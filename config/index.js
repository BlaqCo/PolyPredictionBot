/**
 * index.js — Railway entrypoint
 *
 * Starts:
 *   - Express server (health check + stats dashboard)
 *   - Cron job for periodic scan cycles
 */

import express from "express";
import cron from "node-cron";
import { validateConfig, config } from "../config/index.js";
import { runScanCycle } from "./bot.js";
import { getStats, getAllBets } from "./state.js";
import { fetchCurrentPrice, fetch24hStats } from "./signals.js";

// ── Startup ───────────────────────────────────────────────────────────────────

console.log("🚀 PolyBot BTC — starting up");
console.log(`   Mode: ${config.bot.dryRun ? "🧪 DRY RUN" : "💰 LIVE"}`);
console.log(`   Bankroll: $${config.bot.bankroll}`);
console.log(`   Max bet: $${config.bot.maxBetSize}`);
console.log(`   Min edge: ${(config.bot.minEdge * 100).toFixed(0)}%`);
console.log(`   Kelly fraction: ${config.bot.kellyFraction}x`);
console.log(`   Scan interval: ${config.bot.scanIntervalMinutes}m`);

try {
  validateConfig();
} catch (err) {
  console.error("Config validation failed:", err.message);
  process.exit(1);
}

// ── Express server ────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

// Health check — Railway uses this
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Stats dashboard
app.get("/", (req, res) => {
  const stats = getStats();
  res.json({
    bot: "PolyBot BTC",
    mode: config.bot.dryRun ? "DRY_RUN" : "LIVE",
    config: {
      bankroll: config.bot.bankroll,
      maxBetSize: config.bot.maxBetSize,
      minEdge: config.bot.minEdge,
      kellyFraction: config.bot.kellyFraction,
      scanIntervalMinutes: config.bot.scanIntervalMinutes,
    },
    stats,
  });
});

// All bets log
app.get("/bets", (req, res) => {
  res.json(getAllBets());
});

// Manual trigger (useful for testing)
app.post("/scan", async (req, res) => {
  res.json({ message: "Scan triggered", timestamp: new Date().toISOString() });
  await runScanCycle().catch(console.error);
});

// Live BTC price + signals endpoint
app.get("/price", async (req, res) => {
  try {
    const [price, stats] = await Promise.all([
      fetchCurrentPrice(),
      fetch24hStats(),
    ]);
    res.json({ price, stats, timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(config.port, () => {
  console.log(`\n🌐 Server listening on port ${config.port}`);
  console.log(`   GET  /        → stats`);
  console.log(`   GET  /health  → health check`);
  console.log(`   GET  /bets    → all bets log`);
  console.log(`   GET  /price   → live BTC price`);
  console.log(`   POST /scan    → trigger manual scan\n`);
});

// ── Cron scheduler ────────────────────────────────────────────────────────────

// Convert minutes to cron expression
function buildCronExpr(intervalMinutes) {
  if (intervalMinutes < 60) {
    return `*/${intervalMinutes} * * * *`;
  }
  const hours = Math.floor(intervalMinutes / 60);
  return `0 */${hours} * * *`;
}

const cronExpr = buildCronExpr(config.bot.scanIntervalMinutes);
console.log(`⏰ Cron scheduled: "${cronExpr}" (every ${config.bot.scanIntervalMinutes}m)`);

cron.schedule(cronExpr, async () => {
  try {
    await runScanCycle();
  } catch (err) {
    console.error("Unhandled error in scan cycle:", err);
  }
});

// ── Initial scan on startup ───────────────────────────────────────────────────

console.log("⚡ Running initial scan...\n");
runScanCycle().catch((err) => {
  console.error("Initial scan failed:", err.message);
});
