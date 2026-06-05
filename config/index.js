import express from "express";
import cron from "node-cron";
import dotenv from "dotenv";
dotenv.config();

const config = {
  polymarket: {
    privateKey: process.env.POLYMARKET_PRIVATE_KEY,
    apiKey: process.env.POLYMARKET_API_KEY,
    apiSecret: process.env.POLYMARKET_API_SECRET,
    passphrase: process.env.POLYMARKET_API_PASSPHRASE,
    host: "https://clob.polymarket.com",
    chainId: 137,
  },
  binance: { baseUrl: process.env.BINANCE_BASE_URL || "https://api.binance.com" },
  anthropic: { apiKey: process.env.ANTHROPIC_API_KEY },
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

import("../bot.js").then(({ runScanCycle }) => {
  const app = express();
  app.use(express.json());

  app.get("/health", (req, res) => res.json({ status: "ok" }));

  app.get("/", (req, res) => res.json({
    bot: "PolyBot BTC",
    mode: config.bot.dryRun ? "DRY_RUN" : "LIVE",
    config: config.bot,
  }));

  app.get("/bets", async (req, res) => {
    const { getAllBets } = await import("../state.js");
    res.json(getAllBets());
  });

  app.get("/price", async (req, res) => {
    try {
      const { fetchCurrentPrice, fetch24hStats } = await import("../signals.js");
      const [price, stats] = await Promise.all([fetchCurrentPrice(), fetch24hStats()]);
      res.json({ price, stats });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/scan", async (req, res) => {
    res.json({ message: "Scan triggered" });
    runScanCycle().catch(console.error);
  });

  app.listen(config.port, () => console.log(`🌐 Server on port ${config.port}`));

  const mins = config.bot.scanIntervalMinutes;
  const cronExpr = mins < 60 ? `*/${mins} * * * *` : `0 */${Math.floor(mins / 60)} * * *`;
  cron.schedule(cronExpr, () => runScanCycle().catch(console.error));

  console.log("⚡ Running initial scan...");
  runScanCycle().catch(console.error);

}).catch(err => {
  console.error("Failed to load bot module:", err.message);
  process.exit(1);
});
