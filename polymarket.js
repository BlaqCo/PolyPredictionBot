/**
 * polymarket.js — Polymarket CLOB wrapper
 * Handles BUY and SELL orders for scalping
 */

import axios from "axios";

const DRY_RUN = process.env.DRY_RUN !== "false";
const BTC_KW = ["bitcoin", "btc", "will btc", "will bitcoin", "bitcoin above", "bitcoin below", "btc above", "btc below", "btc price", "bitcoin price"];

export async function fetchBTCMarkets() {
  try {
    const { data } = await axios.get("https://clob.polymarket.com/markets", {
      params: { active: true, closed: false, limit: 100 },
      timeout: 8000,
    });
    const all = data?.data || data || [];
    const btc = all.filter(m => {
      const q = (m.question || m.title || "").toLowerCase();
      return BTC_KW.some(kw => q.includes(kw));
    });
    if (btc.length > 0) {
      console.log(`📊 Polymarket: ${btc.length} BTC markets`);
      return btc;
    }
  } catch (err) {
    console.log("⚠️  Polymarket fetch failed:", err.message);
  }
  return getMockMarkets();
}

export async function placeOrder({ tokenId, side, size, price, marketQuestion }) {
  const log = {
    mode: DRY_RUN ? "DRY_RUN" : "LIVE",
    tokenId, side, size: parseFloat(size.toFixed(4)),
    price: parseFloat(price.toFixed(4)),
    marketQuestion,
    timestamp: new Date().toISOString(),
  };

  if (DRY_RUN) {
    console.log(`    🧪 DRY ${side} $${size.toFixed(2)} @ ${(price*100).toFixed(1)}¢`);
    return { ...log, orderId: `dry_${side}_${Date.now()}`, status: "simulated" };
  }

  throw new Error("Live trading requires Polymarket CLOB client — set credentials in env vars");
}

export async function getBalance() {
  return parseFloat(process.env.BANKROLL || "100");
}

// ── Mock markets simulating real 15-min and 1-hr BTC contracts ──
function getMockMarkets() {
  const now = Date.now();
  const min = (n) => new Date(now + n * 60000).toISOString();

  // Simulate price movement — token prices drift over time
  const seed = Math.floor(now / 30000); // changes every 30s
  const drift = (Math.sin(seed * 0.7) * 0.08); // ±8% price drift

  return [
    // 15-min contracts (prime scalp targets)
    {
      conditionId: "mock_15m_above",
      question: "Will BTC be above $105,000 in the next 15 minutes?",
      endDateIso: min(14),
      tokens: [
        { tokenId: "mock_y1", outcome: "Yes", price: Math.max(0.1, Math.min(0.9, 0.52 + drift)) },
        { tokenId: "mock_n1", outcome: "No",  price: Math.max(0.1, Math.min(0.9, 0.48 - drift)) },
      ],
    },
    {
      conditionId: "mock_15m_below",
      question: "Will BTC be below $104,500 at 15-min close?",
      endDateIso: min(12),
      tokens: [
        { tokenId: "mock_y2", outcome: "Yes", price: Math.max(0.1, Math.min(0.9, 0.38 + drift * 0.5)) },
        { tokenId: "mock_n2", outcome: "No",  price: Math.max(0.1, Math.min(0.9, 0.62 - drift * 0.5)) },
      ],
    },
    // 1-hr contracts
    {
      conditionId: "mock_1h_higher",
      question: "Will BTC be higher than current price in 1 hour?",
      endDateIso: min(55),
      tokens: [
        { tokenId: "mock_y3", outcome: "Yes", price: Math.max(0.1, Math.min(0.9, 0.55 + drift * 1.2)) },
        { tokenId: "mock_n3", outcome: "No",  price: Math.max(0.1, Math.min(0.9, 0.45 - drift * 1.2)) },
      ],
    },
    {
      conditionId: "mock_1h_100k",
      question: "Will BTC hit $106,000 within the next hour?",
      endDateIso: min(48),
      tokens: [
        { tokenId: "mock_y4", outcome: "Yes", price: Math.max(0.1, Math.min(0.9, 0.29 + drift)) },
        { tokenId: "mock_n4", outcome: "No",  price: Math.max(0.1, Math.min(0.9, 0.71 - drift)) },
      ],
    },
    // Slightly longer (still scalp-eligible at 90 min)
    {
      conditionId: "mock_90m_level",
      question: "Will BTC close above $104,000 at next hourly candle?",
      endDateIso: min(82),
      tokens: [
        { tokenId: "mock_y5", outcome: "Yes", price: Math.max(0.1, Math.min(0.9, 0.65 + drift * 0.8)) },
        { tokenId: "mock_n5", outcome: "No",  price: Math.max(0.1, Math.min(0.9, 0.35 - drift * 0.8)) },
      ],
    },
  ];
}
