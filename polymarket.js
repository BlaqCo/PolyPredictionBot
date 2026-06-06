/**
 * polymarket.js
 * Fetches live BTC markets from Polymarket.
 * Falls back to price-aware synthetic markets if none found with valid expiry.
 */

import axios from "axios";

let _botSettings = null;
async function getDryRun() {
  if (!_botSettings) {
    try { const m = await import("./bot.js"); _botSettings = m.botSettings; } catch {}
  }
  return _botSettings?.dryRun ?? (process.env.DRY_RUN !== "false");
}

const BTC_KW = [
  // Short-duration directional markets (the ones we actually want)
  "btc up or down",
  "bitcoin up or down",
  "btc up/down",
  "will btc go up",
  "will bitcoin go up",
  "btc higher or lower",
  // Price level markets
  "bitcoin", "btc",
  "will btc", "will bitcoin",
  "btc above", "btc below",
  "bitcoin above", "bitcoin below",
  "btc price", "bitcoin price",
  "btc end", "bitcoin end",
  "btc close", "bitcoin close",
];

// These are OLD/expired markets Polymarket leaves open — filter them out
const STALE_MARKET_KW = [
  "$1,000,000", "$1m usd", "$20k", "$17000", "$1700",
  "january 4", "june 17", "balaji",
];

function isValidScalpMarket(m) {
  if (!m.endDateIso && !m.endDate) return false;
  const end = new Date(m.endDateIso || m.endDate);
  const msLeft = end - Date.now();
  const minLeft = msLeft / 60000;
  return minLeft >= 4 && minLeft <= 180; // 4 min to 3 hours
}

export async function fetchBTCMarkets() {
  // Try real Polymarket CLOB
  try {
    const { data } = await axios.get("https://clob.polymarket.com/markets", {
      params: { active: true, closed: false, limit: 200 },
      timeout: 10000,
      headers: { "Accept": "application/json" },
    });
    const all = data?.data || data || [];
    const btc = all
      .filter(m => {
        const q = (m.question || m.title || "").toLowerCase();
        if (STALE_MARKET_KW.some(kw => q.includes(kw))) return false;
        return BTC_KW.some(kw => q.includes(kw));
      })
      .filter(isValidScalpMarket)
      .map(normalizeMarket);

    if (btc.length > 0) {
      console.log(`📊 Polymarket CLOB: ${btc.length} live BTC scalp markets`);
      return btc;
    }
    console.log(`📊 Polymarket CLOB: found BTC markets but none with valid expiry — using synthetic`);
  } catch (err) {
    console.log("⚠️  Polymarket CLOB:", err.message);
  }

  // Try Gamma API
  try {
    const { data } = await axios.get("https://gamma-api.polymarket.com/markets", {
      params: { active: true, closed: false, limit: 100 },
      timeout: 10000,
    });
    const all = Array.isArray(data) ? data : (data?.markets || []);
    const btc = all
      .filter(m => {
        const q = (m.question || m.groupItemTitle || "").toLowerCase();
        if (STALE_MARKET_KW.some(kw => q.includes(kw))) return false;
        return BTC_KW.some(kw => q.includes(kw));
      })
      .filter(isValidScalpMarket)
      .map(normalizeMarket);

    if (btc.length > 0) {
      console.log(`📊 Gamma API: ${btc.length} live BTC scalp markets`);
      return btc;
    }
  } catch (err) {
    console.log("⚠️  Gamma API:", err.message);
  }

  // Try direct slug/tag search for "BTC Up or Down" markets (new 5m/15m format)
  try {
    const searches = [
      axios.get("https://gamma-api.polymarket.com/markets", {
        params: { search: "BTC Up or Down", active: true, closed: false, limit: 20 },
        timeout: 6000,
      }),
      axios.get("https://gamma-api.polymarket.com/markets", {
        params: { search: "Bitcoin Up or Down", active: true, closed: false, limit: 20 },
        timeout: 6000,
      }),
      axios.get("https://gamma-api.polymarket.com/events", {
        params: { tag: "crypto", active: true, limit: 50 },
        timeout: 6000,
      }),
    ];
    const results = await Promise.allSettled(searches);
    const found = [];
    for (const r of results) {
      if (r.status !== "fulfilled") continue;
      const items = r.value.data?.markets || r.value.data?.events || r.value.data || [];
      for (const item of (Array.isArray(items) ? items : [])) {
        const mts = item.markets || [item];
        for (const m of mts) {
          const q = (m.question || m.title || "").toLowerCase();
          if ((q.includes("btc") || q.includes("bitcoin")) && isValidScalpMarket(m)) {
            if (!STALE_MARKET_KW.some(kw => q.includes(kw))) {
              found.push(normalizeMarket(m));
            }
          }
        }
      }
    }
    if (found.length > 0) {
      console.log(`📊 Search API: ${found.length} live short-duration BTC markets`);
      return found;
    }
  } catch (err) {
    console.log("⚠️  Search API:", err.message);
  }

  // Synthetic markets — price-aware, correct expiry, no BS
  console.log("⚠️  No live markets found — using price-aware synthetic markets");
  return await getSyntheticMarkets();
}

function normalizeMarket(m) {
  if (!m.tokens && m.outcomes) {
    m.tokens = m.outcomes.map((o, i) => ({
      tokenId: m.clobTokenIds?.[i] || `${m.conditionId}_${i}`,
      outcome: o,
      price: m.outcomePrices?.[i]
        ? Math.min(0.97, Math.max(0.03, parseFloat(m.outcomePrices[i]) / (parseFloat(m.outcomePrices[i]) > 1 ? 100 : 1)))
        : 0.5,
    }));
  }
  if (m.tokens) {
    m.tokens = m.tokens.map(t => ({
      ...t,
      price: t.price > 1 ? Math.min(0.97, t.price / 100) : Math.min(0.97, Math.max(0.03, t.price)),
    }));
  }
  return m;
}

async function getSyntheticMarkets() {
  let btcPrice = 105000;
  try {
    const { data } = await axios.get("https://api.kraken.com/0/public/Ticker", {
      params: { pair: "XBTUSD" }, timeout: 5000,
    });
    btcPrice = parseFloat(data.result?.XXBTZUSD?.c?.[0] || btcPrice);
  } catch {}

  const now = Date.now();
  const min = n => new Date(now + n * 60000).toISOString();
  const p = Math.round(btcPrice);

  // Match real Polymarket "BTC Up or Down" format
  // YES = BTC goes UP, NO = BTC goes DOWN
  // Near 50/50 since it's purely directional
  return [
    {
      conditionId: `syn_5m_a_${now}`,
      question: `BTC Up or Down in the next 5 minutes? (${p.toLocaleString()})`,
      endDateIso: min(5),
      tokens: [
        { tokenId: `syn_5m_yes_a_${now}`, outcome: "Yes", price: 0.50 },
        { tokenId: `syn_5m_no_a_${now}`,  outcome: "No",  price: 0.50 },
      ],
    },
    {
      conditionId: `syn_5m_b_${now}`,
      question: `Will BTC be higher in 5 minutes? (now: $${p.toLocaleString()})`,
      endDateIso: min(5),
      tokens: [
        { tokenId: `syn_5m_yes_b_${now}`, outcome: "Yes", price: 0.49 },
        { tokenId: `syn_5m_no_b_${now}`,  outcome: "No",  price: 0.51 },
      ],
    },
    {
      conditionId: `syn_15m_a_${now}`,
      question: `BTC Up or Down 15m? (from $${p.toLocaleString()})`,
      endDateIso: min(15),
      tokens: [
        { tokenId: `syn_15m_yes_a_${now}`, outcome: "Yes", price: 0.51 },
        { tokenId: `syn_15m_no_a_${now}`,  outcome: "No",  price: 0.49 },
      ],
    },
    {
      conditionId: `syn_15m_b_${now}`,
      question: `Will BTC be higher in 15 minutes? (now: $${p.toLocaleString()})`,
      endDateIso: min(15),
      tokens: [
        { tokenId: `syn_15m_yes_b_${now}`, outcome: "Yes", price: 0.48 },
        { tokenId: `syn_15m_no_b_${now}`,  outcome: "No",  price: 0.52 },
      ],
    },
    {
      conditionId: `syn_1h_a_${now}`,
      question: `BTC Up or Down 1 hour? (from $${p.toLocaleString()})`,
      endDateIso: min(60),
      tokens: [
        { tokenId: `syn_1h_yes_a_${now}`, outcome: "Yes", price: 0.52 },
        { tokenId: `syn_1h_no_a_${now}`,  outcome: "No",  price: 0.48 },
      ],
    },
    {
      conditionId: `syn_1h_b_${now}`,
      question: `Will BTC be higher in 1 hour? (now: $${p.toLocaleString()})`,
      endDateIso: min(60),
      tokens: [
        { tokenId: `syn_1h_yes_b_${now}`, outcome: "Yes", price: 0.50 },
        { tokenId: `syn_1h_no_b_${now}`,  outcome: "No",  price: 0.50 },
      ],
    },
  ];
}

export async function placeOrder({ tokenId, side, size, price, marketQuestion }) {
  const dryRun = await getDryRun();

  if (dryRun) {
    const payout = parseFloat((size / price).toFixed(2));
    const profit = parseFloat((payout - size).toFixed(2));
    const order = {
      orderId: `dry_${side}_${Date.now()}`,
      tokenId, side,
      size: parseFloat(size.toFixed(2)),
      price: parseFloat(price.toFixed(4)),
      potentialPayout: payout,
      potentialProfit: profit,
      marketQuestion,
      status: "dry_filled",
      timestamp: new Date().toISOString(),
    };
    console.log(
      `    📋 DRY ${side} $${size.toFixed(2)} @ ${(price*100).toFixed(1)}¢` +
      ` | win → $${payout} (+$${profit})`
    );
    return order;
  }

  // LIVE
  const pk = process.env.POLYMARKET_PRIVATE_KEY;
  const apiKey = process.env.POLYMARKET_API_KEY;
  if (!pk || pk.startsWith("your_") || !apiKey || apiKey.startsWith("your_")) {
    throw new Error("Live mode requires POLYMARKET_PRIVATE_KEY + POLYMARKET_API_KEY");
  }
  try {
    const { ClobClient, Side } = await import("@polymarket/clob-client");
    const { ethers } = await import("ethers");
    const wallet = new ethers.Wallet(pk.startsWith("0x") ? pk : `0x${pk}`);
    const client = new ClobClient("https://clob.polymarket.com", 137, wallet, {
      key: apiKey, secret: process.env.POLYMARKET_API_SECRET,
      passphrase: process.env.POLYMARKET_API_PASSPHRASE,
    });
    const order = await client.createAndPostOrder({
      tokenID: tokenId,
      side: side === "BUY" ? Side.BUY : Side.SELL,
      size: size.toString(), price: price.toString(),
    });
    console.log(`    ✅ LIVE ORDER: ${order.orderID} | ${side} $${size} @ ${price}`);
    return order;
  } catch (err) {
    throw new Error("CLOB order failed: " + err.message);
  }
}

export async function getBalance() {
  const dryRun = await getDryRun();
  if (dryRun) {
    try {
      const { getDryBalance } = await import("./state.js");
      return getDryBalance();
    } catch { return parseFloat(process.env.BANKROLL || "40"); }
  }
  // Live: would query Polymarket wallet — for now use env var
  return parseFloat(process.env.BANKROLL || "40");
}
