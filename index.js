import express from "express";
import cron from "node-cron";
import dotenv from "dotenv";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));

const config = {
  bot: {
    maxBetSize: parseFloat(process.env.MAX_BET_SIZE || "10"),
    minEdge: parseFloat(process.env.MIN_EDGE || "0.05"),
    kellyFraction: parseFloat(process.env.KELLY_FRACTION || "0.25"),
    scanIntervalMinutes: parseInt(process.env.SCAN_INTERVAL_MINUTES || "15"),
    bankroll: parseFloat(process.env.BANKROLL || "100"),
    dryRun: process.env.DRY_RUN !== "false",
  },
  port: parseInt(process.env.PORT || "3000"),
};

export { config };

console.log("🚀 PolyBot BTC starting...");
console.log(`   Mode: ${config.bot.dryRun ? "🧪 DRY RUN" : "💰 LIVE"}`);
console.log(`   Bankroll: $${config.bot.bankroll} | Max bet: $${config.bot.maxBetSize}`);

// Last known signal state — updated each scan
let lastSignals = null;
let lastMarkets = [];

import("./bot.js").then(({ runScanCycle }) => {
  const app = express();
  app.use(express.json());

  // Dashboard UI
  app.get("/dashboard", (req, res) => {
    try {
      const html = readFileSync(join(__dirname, "dashboard.html"), "utf8");
      res.setHeader("Content-Type", "text/html");
      res.send(html);
    } catch {
      res.status(404).send("Dashboard not found — make sure dashboard.html is in the repo root");
    }
  });

  // Health check
  app.get("/health", (req, res) => res.json({ status: "ok", timestamp: new Date().toISOString() }));

  // Stats
  app.get("/", async (req, res) => {
    const { getStats } = await import("./state.js");
    res.json({ bot: "PolyBot BTC", mode: config.bot.dryRun ? "DRY_RUN" : "LIVE", config: config.bot, stats: getStats() });
  });

  // Bets
  app.get("/bets", async (req, res) => {
    const { getAllBets } = await import("./state.js");
    res.json(getAllBets());
  });

  // Live price
  app.get("/price", async (req, res) => {
    try {
      const { fetchCurrentPrice, fetch24hStats } = await import("./signals.js");
      const [price, stats] = await Promise.all([fetchCurrentPrice(), fetch24hStats()]);
      res.json({ price, stats });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Last signal state (for dashboard)
  app.get("/signals", (req, res) => {
    if (!lastSignals) return res.json({});
    res.json(lastSignals);
  });

  // Last markets state (for dashboard)
  app.get("/markets", (req, res) => res.json(lastMarkets));

  // Manual scan trigger
  app.post("/scan", async (req, res) => {
    res.json({ message: "Scan triggered", timestamp: new Date().toISOString() });
    runScanCycleWithCapture().catch(console.error);
  });

  app.listen(config.port, () => {
    console.log(`🌐 Server on port ${config.port}`);
    console.log(`   Dashboard: /dashboard`);
    console.log(`   Stats:     /`);
    console.log(`   Price:     /price`);
    console.log(`   Bets:      /bets`);
    console.log(`   Scan:      POST /scan`);
  });

  const mins = config.bot.scanIntervalMinutes;
  const cronExpr = mins < 60 ? `*/${mins} * * * *` : `0 */${Math.floor(mins / 60)} * * *`;
  cron.schedule(cronExpr, () => runScanCycleWithCapture().catch(console.error));

  // Wrapper that captures signal/market state for the dashboard
  async function runScanCycleWithCapture() {
    try {
      const { computeSignals } = await import("./signals.js");
      const { fetchBTCMarkets } = await import("./polymarket.js");
      const { sizeBet } = await import("./kelly.js");
      const { scoreSentiment } = await import("./sentiment.js");

      const signals = await computeSignals();
      lastSignals = signals;

      const markets = await fetchBTCMarkets();

      // Attach decision preview to each market for the dashboard
      const enriched = await Promise.all(markets.map(async m => {
        let sentiment = { sentimentBias: 0 };
        try { sentiment = await scoreSentiment(signals, m); } catch {}
        const decision = sizeBet(signals, sentiment, m);
        return { ...m, _decision: decision };
      }));
      lastMarkets = enriched;

    } catch (err) {
      console.error("Signal capture error:", err.message);
    }
    return runScanCycle();
  }

  console.log("⚡ Running initial scan...");
  runScanCycleWithCapture().catch(console.error);

}).catch(err => {
  console.error("Failed to load bot module:", err.message);
  process.exit(1);
});
