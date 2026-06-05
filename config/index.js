import dotenv from "dotenv";
dotenv.config();

export const config = {
  polymarket: {
    privateKey: process.env.POLYMARKET_PRIVATE_KEY,
    apiKey: process.env.POLYMARKET_API_KEY,
    apiSecret: process.env.POLYMARKET_API_SECRET,
    passphrase: process.env.POLYMARKET_API_PASSPHRASE,
    host: "https://clob.polymarket.com",
    chainId: 137,
  },
  binance: {
    baseUrl: process.env.BINANCE_BASE_URL || "https://api.binance.com",
  },
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY,
  },
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

export function validateConfig() {
  const required = [
    ["POLYMARKET_PRIVATE_KEY", config.polymarket.privateKey],
    ["POLYMARKET_API_KEY", config.polymarket.apiKey],
    ["POLYMARKET_API_SECRET", config.polymarket.apiSecret],
    ["POLYMARKET_API_PASSPHRASE", config.polymarket.passphrase],
    ["ANTHROPIC_API_KEY", config.anthropic.apiKey],
  ];
  const missing = required
    .filter(([, val]) => !val || val.startsWith("your_"))
    .map(([key]) => key);
  if (missing.length > 0) {
    console.warn(`⚠️  Missing env vars: ${missing.join(", ")}`);
    if (!config.bot.dryRun) {
      throw new Error("Cannot run live mode without all credentials set.");
    }
  }
  console.log(`🔧 Config loaded — DRY_RUN=${config.bot.dryRun}, BANKROLL=$${config.bot.bankroll}`);
}
