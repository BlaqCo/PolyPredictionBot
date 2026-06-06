/**
 * scalper.js — PolyBettor Exit Engine
 *
 * Contract P&L math:
 * - Each synthetic market is a binary: "Will BTC be above $X in 15 min?"
 * - Bot entry is at ~49¢ (49% implied probability)
 * - Delta of a near-ATM binary ≈ 0.40 per 1% BTC move
 * - So 0.5% BTC move = 0.005 * 0.40 = 0.002 price change = 0.4% on a 49¢ contract
 * 
 * That's still tiny. Real fix: use CUMULATIVE BTC move from entry, not scan-to-scan.
 * entryBtcPrice is stored per bet. currentBtc fetched fresh each cycle.
 * A 1% cumulative BTC move from entry → ~20% contract gain → TP fires.
 * That's realistic for a 15-min window on a trending market.
 *
 * TP_LOW=0.10 means 10% contract gain needed.
 * 10% / 0.40 delta = 0.25% BTC move needed from entry price.
 * $61,000 * 0.0025 = $152 BTC move. Happens frequently intraday.
 */

import axios from "axios";
import { getAllActiveBets, closeBet } from "./state.js";

const trailState = new Map();

// Fetch current BTC price — called once per scan cycle, shared across all bets
export async function fetchCurrentBtcPrice() {
  try {
    const { data } = await axios.get("https://api.kraken.com/0/public/Ticker",
      { params: { pair: "XBTUSD" }, timeout: 4000 });
    const p = parseFloat(data.result?.XXBTZUSD?.c?.[0]);
    if (p > 0) return p;
  } catch {}
  return null;
}

function estimateContractPrice(bet, currentBtc) {
  if (!currentBtc || !bet.entryBtcPrice || !bet.entryPrice) return bet.entryPrice;

  // CUMULATIVE move from entry (not scan-to-scan)
  const btcChangePct = (currentBtc - bet.entryBtcPrice) / bet.entryBtcPrice;

  // Parse question to determine direction
  const q = (bet.marketQuestion || "").toLowerCase();
  
  // "BTC Up or Down" markets: YES = up, NO = down
  const isUpOrDown = q.includes("up or down") || q.includes("up/down");
  let isLong;
  if (isUpOrDown) {
    // YES means BTC goes up
    isLong = bet.side === "YES";
  } else {
    // Price level markets: "Will BTC be above $X"
    const isBullQ = q.includes("above") || q.includes("higher") ||
      q.includes("rise") || q.includes("reach") || q.includes("hit") ||
      q.includes("exceed") || q.includes("over");
    isLong = isBullQ ? bet.side === "YES" : bet.side === "NO";
  }

  // Binary option delta: 0.45 near ATM (50¢), less at extremes
  const distFromMid = Math.abs(bet.entryPrice - 0.5);
  const delta = Math.max(0.25, 0.45 - distFromMid * 0.4);

  const priceChange = btcChangePct * delta * (isLong ? 1 : -1);
  const newPrice = bet.entryPrice + priceChange;

  return Math.max(0.03, Math.min(0.97, newPrice));
}

export async function checkScalpExits(markets, signals, dryRun = true) {
  const active = getAllActiveBets();
  if (active.length === 0) return { exits: [], currentBtc: null };

  const currentBtc = await fetchCurrentBtcPrice();

  const TP_LOW    = parseFloat(process.env.TP_LOW    || "0.10");
  const TP_HIGH   = parseFloat(process.env.TP_HIGH   || "0.20");
  const STOP_LOSS = parseFloat(process.env.STOP_LOSS || "0.15");
  const TRAIL_AT  = parseFloat(process.env.TRAIL_AFTER || "0.07");
  const TRAIL_PCT = parseFloat(process.env.TRAIL_PCT   || "0.035");

  const exits = [];

  for (const bet of active) {
    if (!bet.entryPrice) continue;

    const currentPrice = estimateContractPrice(bet, currentBtc);
    const pnlPct = (currentPrice - bet.entryPrice) / bet.entryPrice;
    const unrealizedPnl = parseFloat((bet.betSize * pnlPct).toFixed(2));

    // Trailing stop
    let trail = trailState.get(bet.marketConditionId);
    if (!trail) { trail = { peak: currentPrice, trailStop: null }; trailState.set(bet.marketConditionId, trail); }
    if (currentPrice > trail.peak) trail.peak = currentPrice;
    const peakGain = (trail.peak - bet.entryPrice) / bet.entryPrice;
    if (peakGain >= TRAIL_AT) trail.trailStop = trail.peak * (1 - TRAIL_PCT);

    let shouldExit = false, exitReason = "", exitPrice = currentPrice;

    if (pnlPct >= TP_HIGH)                                    { shouldExit = true; exitReason = "TAKE_PROFIT_MAX"; }
    else if (pnlPct >= TP_LOW)                               { shouldExit = true; exitReason = "TAKE_PROFIT"; }
    else if (trail.trailStop && currentPrice <= trail.trailStop) { shouldExit = true; exitReason = "TRAIL_STOP"; }
    else if (pnlPct <= -STOP_LOSS)                           { shouldExit = true; exitReason = "STOP_LOSS"; }

    // Expiry
    const endDate = bet.marketEndDateIso;
    if (endDate) {
      const msLeft = new Date(endDate) - Date.now();
      if (msLeft > 0 && msLeft < 2 * 60 * 1000) {
        shouldExit = true; exitReason = "NEAR_EXPIRY";
      } else if (msLeft <= 0 && !shouldExit) {
        shouldExit = true; exitReason = "EXPIRED";
        // Settlement: did BTC move in bet's direction vs entry?
        const q = (bet.marketQuestion || "").toLowerCase();
        const isBullQ = q.includes("above") || q.includes("higher") || q.includes("reach");
        const btcWentUp = currentBtc && bet.entryBtcPrice && currentBtc > bet.entryBtcPrice;
        const isLong = isBullQ ? bet.side === "YES" : bet.side === "NO";
        exitPrice = (isLong ? btcWentUp : !btcWentUp) ? 0.94 : 0.06;
      }
    }

    if (!shouldExit) {
      const btcMove = currentBtc && bet.entryBtcPrice
        ? ((currentBtc - bet.entryBtcPrice) / bet.entryBtcPrice * 100).toFixed(2)
        : "?";
      console.log(`  📊 HOLD ${bet.side} $${bet.betSize} | entry:${(bet.entryPrice*100).toFixed(0)}¢ now:${(currentPrice*100).toFixed(0)}¢ | contract:${pnlPct>=0?'+':''}${(pnlPct*100).toFixed(1)}% | BTC:${btcMove}%`);
      continue;
    }

    const finalPnlPct = (exitPrice - bet.entryPrice) / bet.entryPrice;
    const finalPnl = parseFloat((bet.betSize * finalPnlPct).toFixed(2));

    console.log(`  🎯 EXIT [${exitReason}] ${bet.side} $${bet.betSize} | ${(bet.entryPrice*100).toFixed(0)}¢→${(exitPrice*100).toFixed(0)}¢ | ${finalPnl>=0?'+':''}$${finalPnl} (${finalPnl>=0?'+':''}${(finalPnlPct*100).toFixed(1)}%)`);

    closeBet(bet.marketConditionId, {
      exitPrice,
      reason: exitReason.startsWith("TAKE_PROFIT") ? "take_profit"
            : exitReason === "TRAIL_STOP" ? "trail_stop"
            : (exitReason === "NEAR_EXPIRY" || exitReason === "EXPIRED") ? "expiry"
            : "stop_loss",
      pnl: finalPnl,
    });
    trailState.delete(bet.marketConditionId);
    exits.push({ market: bet.marketQuestion, side: bet.side, pnlPct: finalPnlPct, pnl: finalPnl, reason: exitReason });
  }

  return { exits, currentBtc };
}

export function filterScalpMarkets(markets) {
  return markets.filter(m => {
    if (!m.endDateIso && !m.endDate) return true;
    const minLeft = (new Date(m.endDateIso || m.endDate) - Date.now()) / 60000;
    return minLeft >= 3 && minLeft <= 180;
  });
}

export function scalpQuality(market, signals) {
  let score = 0;
  if (market.endDateIso || market.endDate) {
    const minLeft = (new Date(market.endDateIso || market.endDate) - Date.now()) / 60000;
    if (minLeft < 3 || minLeft > 180) return 0;
    if (minLeft >= 8 && minLeft <= 30)       score += 0.35;
    else if (minLeft >= 30 && minLeft <= 90) score += 0.25;
    else                                      score += 0.10;
  } else score += 0.20;
  score += Math.min(0.40, signals.confidence * 0.45);
  score += Math.min(0.25, Math.abs(signals.bias) * 0.30);
  return Math.min(1, score);
}
