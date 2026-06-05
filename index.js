import express from "express";
import cron from "node-cron";
import dotenv from "dotenv";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));

export const config = {
  bot: {
    maxBetSize: parseFloat(process.env.MAX_BET_SIZE || "10"),
    minEdge: parseFloat(process.env.MIN_EDGE || "0.05"),
    kellyFraction: parseFloat(process.env.KELLY_FRACTION || "0.25"),
    scanIntervalSeconds: parseInt(process.env.SCAN_INTERVAL_SECONDS || "8"),
    bankroll: parseFloat(process.env.BANKROLL || "100"),
    dryRun: process.env.DRY_RUN !== "false",
  },
  port: parseInt(process.env.PORT || "3000"),
};

console.log("🚀 PolyBot BTC");
console.log(`   Mode: ${config.bot.dryRun ? "DRY RUN" : "LIVE"} | Bankroll: $${config.bot.bankroll} | Scan: every ${config.bot.scanIntervalSeconds}s`);

let lastSignals = null, lastMarkets = [], isScanning = false;

import("./bot.js").then(({ runScanCycle }) => {
  const app = express();
  app.use(express.json());

  app.get("/dashboard", (req, res) => {
    try { res.setHeader("Content-Type","text/html"); res.send(readFileSync(join(__dirname,"dashboard.html"),"utf8")); }
    catch { res.status(404).send("dashboard.html not found"); }
  });

  app.get("/health", (_, res) => res.json({ status: "ok" }));

  app.get("/", async (_, res) => {
    const { getStats } = await import("./state.js");
    res.json({ bot: "PolyBot BTC", mode: config.bot.dryRun ? "DRY_RUN" : "LIVE", config: config.bot, stats: getStats() });
  });

  app.get("/bets", async (_, res) => { const { getAllBets } = await import("./state.js"); res.json(getAllBets()); });

  app.get("/price", async (_, res) => {
    try {
      const { fetchCurrentPrice, fetch24hStats } = await import("./signals.js");
      const [price, stats] = await Promise.all([fetchCurrentPrice(), fetch24hStats()]);
      res.json({ price, stats });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.get("/signals", (_, res) => res.json(lastSignals || {}));
  app.get("/markets", (_, res) => res.json(lastMarkets));

  app.listen(config.port, () => console.log(`🌐 Port ${config.port} | /dashboard`));

  // ── Scan every N seconds ──
  async function scan() {
    if (isScanning) return;
    isScanning = true;
    try {
      const { computeSignals, fetchOrderBook, detectWalls } = await import("./signals.js");
      const { fetchBTCMarkets } = await import("./polymarket.js");
      const { sizeBet } = await import("./kelly.js");
      const { scoreSentiment } = await import("./sentiment.js");

      const [sig, book] = await Promise.allSettled([computeSignals(), fetchOrderBook(150)]);
      if (sig.status === "fulfilled") {
        const walls = detectWalls(book.status === "fulfilled" ? book.value : null, sig.value.currentPrice);
        lastSignals = { ...sig.value, walls };
      }

      const markets = await fetchBTCMarkets();
      if (lastSignals) {
        const enriched = await Promise.all(markets.map(async m => {
          let sentiment = { sentimentBias: 0 };
          try { sentiment = await scoreSentiment(lastSignals, m); } catch {}
          return { ...m, _decision: sizeBet(lastSignals, sentiment, m) };
        }));
        lastMarkets = enriched;
      }

      await runScanCycle();
    } catch (err) {
      console.error("Scan error:", err.message);
    } finally {
      isScanning = false;
    }
  }

  setInterval(scan, config.bot.scanIntervalSeconds * 1000);
  console.log(`⚡ Scanning every ${config.bot.scanIntervalSeconds}s`);
  scan();
}).catch(err => { console.error("Boot failed:", err.message); process.exit(1); });
