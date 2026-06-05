/**
 * polymarket.js — Polymarket CLOB API wrapper
 *
 * Handles:
 *   - Auth (L1 + L2 signatures via ethers + @polymarket/clob-client)
 *   - Fetching active BTC markets
 *   - Placing market orders
 *   - Checking open positions
 */

import { ClobClient, Side } from "@polymarket/clob-client";
import { ethers } from "ethers";
import { config } from "../config/index.js";

let client = null;

export async function getClient() {
  if (client) return client;

  if (!config.polymarket.privateKey || config.polymarket.privateKey.startsWith("your_")) {
    console.log("⚠️  Polymarket credentials not set — using mock client");
    return null;
  }

  const wallet = new ethers.Wallet(
    config.polymarket.privateKey.startsWith("0x")
      ? config.polymarket.privateKey
      : `0x${config.polymarket.privateKey}`
  );

  client = new ClobClient(config.polymarket.host, config.polymarket.chainId, wallet, {
    key: config.polymarket.apiKey,
    secret: config.polymarket.apiSecret,
    passphrase: config.polymarket.passphrase,
  });

  console.log(`✅ Polymarket client initialized — wallet: ${wallet.address}`);
  return client;
}

// ── Market discovery ──────────────────────────────────────────────────────────

const BTC_KEYWORDS = [
  "bitcoin", "btc", "bitcoin price", "btc price",
  "will btc", "will bitcoin", "bitcoin above", "bitcoin below",
  "btc above", "btc below", "bitcoin end", "btc end",
];

export async function fetchBTCMarkets() {
  const cl = await getClient();

  if (!cl) return getMockMarkets();

  try {
    // Fetch all active markets and filter for BTC
    const markets = await cl.getMarkets({ active: true, closed: false });
    const btcMarkets = (markets?.data || []).filter((m) => {
      const q = (m.question || m.title || "").toLowerCase();
      return BTC_KEYWORDS.some((kw) => q.includes(kw));
    });

    console.log(`📊 Found ${btcMarkets.length} active BTC markets`);
    return btcMarkets;
  } catch (err) {
    console.error("Error fetching markets:", err.message);
    return getMockMarkets();
  }
}

// ── Order placement ───────────────────────────────────────────────────────────

/**
 * Place a market order on Polymarket.
 *
 * @param {string} tokenId - The YES or NO token ID
 * @param {string} side - "BUY" (we want to buy YES/NO tokens)
 * @param {number} size - USDC amount to spend
 * @param {number} price - limit price (0.0-1.0)
 */
export async function placeOrder({ tokenId, side, size, price, marketQuestion }) {
  if (config.bot.dryRun) {
    const log = {
      mode: "DRY_RUN",
      tokenId,
      side,
      size,
      price,
      marketQuestion,
      timestamp: new Date().toISOString(),
    };
    console.log("🧪 DRY RUN order:", JSON.stringify(log, null, 2));
    return { ...log, orderId: `dry_${Date.now()}`, status: "simulated" };
  }

  const cl = await getClient();
  if (!cl) throw new Error("No Polymarket client available");

  try {
    const order = await cl.createAndPostOrder({
      tokenID: tokenId,
      side: side === "BUY" ? Side.BUY : Side.SELL,
      size: size.toString(),
      price: price.toString(),
    });

    console.log(`✅ Order placed: ${order.orderID} | ${side} $${size} @ ${price}`);
    return order;
  } catch (err) {
    console.error("Order failed:", err.message);
    throw err;
  }
}

// ── Positions ─────────────────────────────────────────────────────────────────

export async function getOpenPositions() {
  const cl = await getClient();
  if (!cl) return [];

  try {
    const positions = await cl.getTrades({ maker_address: await cl.getAddress() });
    return positions?.data || [];
  } catch (err) {
    console.error("Error fetching positions:", err.message);
    return [];
  }
}

export async function getBalance() {
  const cl = await getClient();
  if (!cl) return config.bot.bankroll;

  try {
    const balance = await cl.getCollateralBalance();
    return parseFloat(balance);
  } catch (err) {
    console.error("Error fetching balance:", err.message);
    return config.bot.bankroll;
  }
}

// ── Mock data for dry runs ────────────────────────────────────────────────────

function getMockMarkets() {
  const now = new Date();
  const tomorrow = new Date(now.getTime() + 86400000);
  const nextWeek = new Date(now.getTime() + 7 * 86400000);

  return [
    {
      conditionId: "mock_001",
      question: `Will BTC be above $${Math.round(parseFloat(process.env.MOCK_BTC_PRICE || "95000") / 1000) * 1000} by end of day?`,
      description: "Resolves YES if Bitcoin price closes above the strike price.",
      active: true,
      endDateIso: tomorrow.toISOString(),
      tokens: [
        { tokenId: "mock_yes_001", outcome: "Yes", price: 0.52 },
        { tokenId: "mock_no_001", outcome: "No", price: 0.48 },
      ],
    },
    {
      conditionId: "mock_002",
      question: "Will BTC reach $100,000 this week?",
      description: "Resolves YES if Bitcoin touches or exceeds $100,000 at any point this week.",
      active: true,
      endDateIso: nextWeek.toISOString(),
      tokens: [
        { tokenId: "mock_yes_002", outcome: "Yes", price: 0.31 },
        { tokenId: "mock_no_002", outcome: "No", price: 0.69 },
      ],
    },
    {
      conditionId: "mock_003",
      question: "Will BTC be higher than today's open at market close?",
      description: "Daily BTC direction market.",
      active: true,
      endDateIso: tomorrow.toISOString(),
      tokens: [
        { tokenId: "mock_yes_003", outcome: "Yes", price: 0.58 },
        { tokenId: "mock_no_003", outcome: "No", price: 0.42 },
      ],
    },
  ];
}
