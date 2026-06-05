import express from "express";
import cron from "node-cron";
import { validateConfig, config } from "../config/index.js";
import { runScanCycle } from "./bot.js";
import { getStats, getAllBets } from "./state.js";
import { fetchCurrentPrice, fetch24hStats } from "./signals.js";

console.log("🚀 PolyBot BTC — starting up");
console.log(`   Mode: ${process.env.DRY_RUN !== "false" ? "🧪 DRY RUN" : "💰 LIVE"}`);

try {
  validateConfig();
} catch (err) {
  console.error("Config validation failed:", err.message);
  process.exit(1);
}

const app = express();
app.use(express.json());

app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.get("/", (req, res) => {
  res.json({ bot: "PolyBot BTC", mode: config.bot.dryRun ? "DRY_RUN" : "LIVE", stats: getStats() });
});

app.get("/bets", (req, res) => res.json(getAllBets()));

app.post("/scan", async (req, res) => {
  res.json({ message: "Scan triggered" });
  await runScanCycle().catch(console.error);
});

app.get("/price", async (req, res) => {
  try {
    const [price, stats] = await Promise.all([fetchCurrentPrice(), fetch24hStats()]);
    res.json({ price, stats });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(config.port, () => {
  console.log(`🌐 Server on port ${config.port}`);
});

function buildCron(mins) {
  return mins < 60 ? `*/${mins} * * * *` : `0 */${Math.floor(mins/60)} * * *`;
}

cron.schedule(buildCron(config.bot.scanIntervalMinutes), () => {
  runScanCycle().catch(console.error);
});

console.log("⚡ Running initial scan...");
runScanCycle().catch(console.error);
