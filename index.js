import express from "express";
import dotenv from "dotenv";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));

export const config = {
  bot: {
    maxBetSize: parseFloat(process.env.MAX_BET_SIZE || "8"),
    minEdge: parseFloat(process.env.MIN_EDGE || "0.015"),
    kellyFraction: parseFloat(process.env.KELLY_FRACTION || "0.30"),
    scanIntervalSeconds: parseInt(process.env.SCAN_INTERVAL_SECONDS || "8"),
    bankroll: parseFloat(process.env.BANKROLL || "40"),
    dryRun: process.env.DRY_RUN !== "false",
    tpLow: parseFloat(process.env.TP_LOW || "0.15"),
    tpHigh: parseFloat(process.env.TP_HIGH || "0.25"),
    stopLoss: parseFloat(process.env.STOP_LOSS || "0.08"),
  },
  port: parseInt(process.env.PORT || "3000"),
};

// In-memory log for dashboard
const systemLog = [];
function addLog(type, msg) {
  systemLog.unshift({ ts: new Date().toISOString(), type, msg });
  if (systemLog.length > 200) systemLog.pop();
  console.log(`[${type.toUpperCase()}] ${msg}`);
}

let lastSignals = null, lastMarkets = [], isScanning = false;

// Runtime dryRun flag — can be toggled via dashboard without restart
let runtimeDryRun = config.bot.dryRun;

import("./bot.js").then(async ({ runScanCycle, botSettings }) => {
  // Sync initial dryRun into botSettings so dashboard can read it
  botSettings.dryRun = runtimeDryRun;
  const app = express();
  app.use(express.json());

  // Dashboard
  app.get("/dashboard", (_, res) => {
    try { res.setHeader("Content-Type","text/html"); res.send(readFileSync(join(__dirname,"dashboard.html"),"utf8")); }
    catch { res.status(404).send("dashboard.html not found"); }
  });

  app.get("/health", (_, res) => res.json({ status: "ok" }));

  app.get("/", async (_, res) => {
    const { getStats } = await import("./state.js");
    res.json({ bot: "PolyBot BTC", mode: botSettings.dryRun ? "DRY_RUN" : "LIVE", config: config.bot, stats: getStats(), settings: botSettings });
  });

  app.get("/bets", async (_, res) => { const { getAllBets } = await import("./state.js"); res.json(getAllBets()); });
  app.get("/active", async (_, res) => { const { getAllActiveBets } = await import("./state.js"); res.json(getAllActiveBets()); });
  app.get("/signals", (_, res) => res.json(lastSignals || {}));
  app.get("/markets", (_, res) => res.json(lastMarkets));
  app.get("/log", (_, res) => res.json(systemLog));

  app.get("/balance", async (_, res) => {
    const { getBalance } = await import("./polymarket.js");
    const { getStats } = await import("./state.js");
    const balance = await getBalance();
    const stats = getStats();
    res.json({
      balance,
      startingBalance: config.bot.bankroll,
      pnl: parseFloat(stats.pnl),
      mode: botSettings.dryRun ? "DRY_RUN" : "LIVE",
    });
  });

  app.get("/price", async (_, res) => {
    try {
      const { fetchCurrentPrice, fetch24hStats } = await import("./signals.js");
      const [price, stats] = await Promise.all([fetchCurrentPrice(), fetch24hStats()]);
      res.json({ price, stats });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ── Settings API ───────────────────────────────────────────
  app.get("/settings", (_, res) => res.json(botSettings));

  app.post("/settings", (req, res) => {
    const { strategies, autoMode, enabled, dryRun } = req.body;
    const changes = [];

    if (typeof dryRun === "boolean" && dryRun !== botSettings.dryRun) {
      botSettings.dryRun = dryRun;
      runtimeDryRun = dryRun;
      const msg = dryRun
        ? "⚠️  Switched to DRY RUN — no real orders will be placed"
        : "🔴 SWITCHED TO LIVE MODE — real money orders ENABLED";
      changes.push(msg);
      addLog(dryRun ? "warn" : "err", msg);
    }

    if (typeof enabled === "boolean" && enabled !== botSettings.enabled) {
      botSettings.enabled = enabled;
      const msg = enabled ? "Bot RESUMED via dashboard" : "Bot PAUSED via dashboard";
      changes.push(msg);
      addLog(enabled ? "ok" : "warn", msg);
    }

    if (typeof autoMode === "boolean" && autoMode !== botSettings.autoMode) {
      botSettings.autoMode = autoMode;
      const msg = `Auto strategy: ${autoMode ? "ON" : "OFF"}`;
      changes.push(msg);
      addLog("info", msg);
    }

    if (strategies) {
      for (const [key, val] of Object.entries(strategies)) {
        if (typeof val === "boolean" && botSettings.strategies[key] !== val) {
          botSettings.strategies[key] = val;
          const msg = `Strategy ${key}: ${val ? "ENABLED" : "DISABLED"}`;
          changes.push(msg);
          addLog(val ? "ok" : "warn", msg);
        }
      }
    }

    res.json({ ok: true, settings: botSettings, changes });
  });

  app.listen(config.port, () => {
    addLog("ok", `PolyBot started on port ${config.port} | Mode: ${config.bot.dryRun ? "DRY RUN" : "LIVE"}`);
    addLog("info", `Scan interval: ${config.bot.scanIntervalSeconds}s | TP: ${(config.bot.tpLow*100).toFixed(0)}-${(config.bot.tpHigh*100).toFixed(0)}% | SL: ${(config.bot.stopLoss*100).toFixed(0)}%`);
  });

  async function scan() {
    if (isScanning) return;
    isScanning = true;
    try {
      const { computeSignals, fetchOrderBook } = await import("./signals.js");
      const { fetchBTCMarkets } = await import("./polymarket.js");
      const { sizeBet } = await import("./kelly.js");
      const { scoreSentiment } = await import("./sentiment.js");
      const { scalpQuality } = await import("./scalper.js");

      const [sigR, bookR] = await Promise.allSettled([
        computeSignals(botSettings.strategies, botSettings.autoMode),
        fetchOrderBook(150),
      ]);

      if (sigR.status === "fulfilled") {
        lastSignals = sigR.value;
        if (lastSignals.activeStrategy) {
          addLog("info", `Scan: ${lastSignals.activeStrategy} | bias:${lastSignals.bias.toFixed(3)} | conf:${(lastSignals.confidence*100).toFixed(0)}% | $${lastSignals.currentPrice?.toLocaleString()}`);
        }
      } else {
        addLog("err", "Signal error: " + sigR.reason?.message);
      }

      const markets = await fetchBTCMarkets();
      if (lastSignals) {
        const enriched = await Promise.all(markets.map(async m => {
          let sentiment = { sentimentBias: 0 };
          try { sentiment = await scoreSentiment(lastSignals, m); } catch {}
          const msLeft = m.endDateIso ? (new Date(m.endDateIso) - Date.now()) / 60000 : null;
          return {
            ...m,
            _decision: sizeBet(lastSignals, sentiment, m),
            _quality: scalpQuality(m, lastSignals),
            _minutesLeft: msLeft ? msLeft.toFixed(0) : null,
          };
        }));
        lastMarkets = enriched;
      }

      const result = await runScanCycle();
      if (result?.exits?.length > 0) {
        for (const e of result.exits) {
          addLog(e.pnl > 0 ? "ok" : "warn", `EXIT [${e.reason}] ${e.side} $${e.pnl >= 0 ? "+" : ""}${e.pnl} | ${e.market?.slice(0,45)}`);
        }
      }
      if (result?.betsPlaced > 0) {
        const { getStats } = await import("./state.js");
        const st = getStats();
        addLog("ok", `PLACED ${result.betsPlaced} bet(s) | Active:${st.activeBets} | P&L:$${st.pnl}`);
      } else if (lastSignals) {
        const dir = lastSignals.bias > 0.1 ? "BULL" : lastSignals.bias < -0.1 ? "BEAR" : "FLAT";
        addLog("info", `No entry — bias:${lastSignals.bias.toFixed(3)} [${dir}] conf:${(lastSignals.confidence*100).toFixed(0)}% strat:${lastSignals.activeStrategy}`);
      }
    } catch (err) {
      addLog("err", "Scan error: " + err.message);
    } finally {
      isScanning = false;
    }
  }

  setInterval(scan, config.bot.scanIntervalSeconds * 1000);
  addLog("info", `Scanner started — every ${config.bot.scanIntervalSeconds}s`);
  scan();
}).catch(err => { console.error("Boot failed:", err.message); process.exit(1); });
