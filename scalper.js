/**
 * scalper.js
 *
 * Exit engine for PolyBettor.
 *
 * DRY RUN reality check:
 * - Synthetic markets expire every 15/60/90 min
 * - conditionId changes each scan so we can't track live price from market object
 * - Instead: use REAL BTC price movement to drive contract P&L
 * - A YES "BTC above $X in 15 min" contract is essentially a leveraged BTC long
 * - Contract sensitivity: near-ATM ~2-3x BTC % move (options delta effect)
 * - This is NOT random simulation — it's real BTC driving fake contract prices
 */

import axios from "axios";
import { getAllActiveBets, closeBet } from "./state.js";

const trailState = new Map();
let lastBtcPrice = null;

async function getLiveBtcPrice() {
  try {
    const { data } = await axios.get("https://api.kraken.com/0/public/Ticker",
      { params: { pair: "XBTUSD" }, timeout: 4000 });
    const p = parseFloat(data.result?.XXBTZUSD?.c?.[0]);
    if (p > 0) lastBtcPrice = p;
  } catch {}
  return lastBtcPrice;
}

/**
 * Estimate current contract price from real BTC price movement.
 *
 * Near-ATM binary option delta: ~0.35–0.45 per 1% BTC move
 * = roughly 35-45 cent change per 1% BTC move on a 50¢ contract
 * That means a 0.5% BTC move = ~17-22% contract gain → realistic TP
 *
 * Direction: YES on bull = profits when BTC goes up
 *            NO on bull  = profits when BTC goes down
 *            YES on bear = profits when BTC goes down
 *            NO on bear  = profits when BTC goes up
 */
function contractPrice(bet, currentBtc) {
  if (!currentBtc || !bet.entryBtcPrice || !bet.entryPrice) {
    // No BTC data — gentle hold near entry
    return bet.entryPrice;
  }

  const btcChangePct = (currentBtc - bet.entryBtcPrice) / bet.entryBtcPrice;

  // Determine if this is a bull or bear contract from the question text
  const q = (bet.marketQuestion || "").toLowerCase();
  const isBullQuestion = q.includes("above") || q.includes("higher") ||
    q.includes("rise") || q.includes("reach") || q.includes("hit");

  // YES on bull = long, NO on bull = short, YES on bear = short, NO on bear = long
  let isLong;
  if (isBullQuestion) {
    isLong = bet.side === "YES";
  } else {
    isLong = bet.side === "NO";
  }

  // Binary option near-ATM delta ~0.40 (moves 40¢ per 1% BTC move)
  // Increases as contract goes ITM, decreases as it goes OTM
  const currentProb = bet.entryPrice; // approximation
  const delta = 0.40 * Math.min(1, currentProb * 2); // 0 at edges, max at 0.5+

  const move = btcChangePct * delta * (isLong ? 1 : -1);
  const newPrice = bet.entryPrice + move;

  return Math.max(0.03, Math.min(0.97, newPrice));
}

export async function checkScalpExits(markets, signals, dryRun = true) {
  const active = getAllActiveBets();
  if (active.length === 0) return [];

  const currentBtc = await getLiveBtcPrice();

  // Read live config (updated by dashboard settings)
  const TP_LOW    = parseFloat(process.env.TP_LOW    || "0.12");
  const TP_HIGH   = parseFloat(process.env.TP_HIGH   || "0.22");
  const STOP_LOSS = parseFloat(process.env.STOP_LOSS || "0.40");
  const TRAIL_AT  = parseFloat(process.env.TRAIL_AFTER || "0.08");
  const TRAIL_PCT = parseFloat(process.env.TRAIL_PCT   || "0.04");

  const exits = [];

  for (const bet of active) {
    if (!bet.entryPrice) continue;

    // Current contract price from real BTC movement
    const currentPrice = contractPrice(bet, currentBtc);
    const pnlPct = (currentPrice - bet.entryPrice) / bet.entryPrice;
    const unrealizedPnl = parseFloat((bet.betSize * pnlPct).toFixed(2));

    // Trailing stop
    let trail = trailState.get(bet.marketConditionId);
    if (!trail) {
      trail = { peak: currentPrice, trailStop: null };
      trailState.set(bet.marketConditionId, trail);
    }
    if (currentPrice > trail.peak) trail.peak = currentPrice;
    const peakPnlPct = (trail.peak - bet.entryPrice) / bet.entryPrice;
    if (peakPnlPct >= TRAIL_AT) {
      trail.trailStop = trail.peak * (1 - TRAIL_PCT);
    }

    let shouldExit = false, exitReason = "", exitPrice = currentPrice;

    // Take profit
    if (pnlPct >= TP_HIGH) {
      shouldExit = true; exitReason = "TAKE_PROFIT_MAX";
    } else if (pnlPct >= TP_LOW) {
      shouldExit = true; exitReason = "TAKE_PROFIT";
    }
    // Trailing stop
    else if (trail.trailStop && currentPrice <= trail.trailStop) {
      shouldExit = true; exitReason = "TRAIL_STOP";
    }
    // Stop loss
    else if (pnlPct <= -STOP_LOSS) {
      shouldExit = true; exitReason = "STOP_LOSS";
    }

    // Expiry check — resolve based on whether BTC moved in bet's favor
    const endDate = bet.marketEndDateIso;
    if (endDate) {
      const msLeft = new Date(endDate) - Date.now();
      if (msLeft > 0 && msLeft < 3 * 60 * 1000) {
        shouldExit = true; exitReason = "NEAR_EXPIRY";
      } else if (msLeft <= 0 && !shouldExit) {
        // Contract expired — was the bet directionally correct?
        shouldExit = true; exitReason = "EXPIRED";
        const q = (bet.marketQuestion || "").toLowerCase();
        const isBullQ = q.includes("above") || q.includes("higher") || q.includes("reach") || q.includes("hit");
        const btcWentUp = currentBtc && bet.entryBtcPrice && currentBtc > bet.entryBtcPrice;
        const isLong = isBullQ ? bet.side === "YES" : bet.side === "NO";
        const won = isLong ? btcWentUp : !btcWentUp;
        // Win = contract settles at 1.0, loss = 0.0
        exitPrice = won ? 0.95 : 0.05;
      }
    }

    if (!shouldExit) {
      console.log(`  📊 HOLD ${bet.side} $${bet.betSize} | ${(bet.entryPrice*100).toFixed(0)}¢→${(currentPrice*100).toFixed(0)}¢ | ${pnlPct>=0?'+':''}${(pnlPct*100).toFixed(1)}% | BTC:$${currentBtc?.toFixed(0)||'?'}`);
      continue;
    }

    const finalPnlPct = (exitPrice - bet.entryPrice) / bet.entryPrice;
    const finalPnl = parseFloat((bet.betSize * finalPnlPct).toFixed(2));

    console.log(`  🎯 EXIT [${exitReason}] ${bet.side} $${bet.betSize} | ${(bet.entryPrice*100).toFixed(0)}¢→${(exitPrice*100).toFixed(0)}¢ | ${finalPnl>=0?'+':''}$${finalPnl} (${finalPnl>=0?'+':''}${(finalPnlPct*100).toFixed(1)}%)`);

    closeBet(bet.marketConditionId, {
      exitPrice,
      reason: exitReason.startsWith("TAKE_PROFIT") ? "take_profit"
            : exitReason === "TRAIL_STOP" ? "trail_stop"
            : exitReason === "NEAR_EXPIRY" || exitReason === "EXPIRED" ? "expiry"
            : "stop_loss",
      pnl: finalPnl,
    });
    trailState.delete(bet.marketConditionId);
    exits.push({ market: bet.marketQuestion, side: bet.side, pnlPct: finalPnlPct, pnl: finalPnl, reason: exitReason });
  }

  return exits;
}

export function filterScalpMarkets(markets) {
  return markets.filter(m => {
    if (!m.endDateIso && !m.endDate) return true;
    const end = new Date(m.endDateIso || m.endDate);
    const minLeft = (end - Date.now()) / 60000;
    return minLeft >= 3 && minLeft <= 180;
  });
}

export function scalpQuality(market, signals) {
  let score = 0;
  if (market.endDateIso || market.endDate) {
    const minLeft = (new Date(market.endDateIso || market.endDate) - Date.now()) / 60000;
    if (minLeft < 3 || minLeft > 180) return 0;
    if (minLeft >= 8 && minLeft <= 30) score += 0.35;
    else if (minLeft >= 30 && minLeft <= 90) score += 0.25;
    else score += 0.10;
  } else {
    score += 0.20;
  }
  score += Math.min(0.40, signals.confidence * 0.45);
  score += Math.min(0.25, Math.abs(signals.bias) * 0.30);
  return Math.min(1, score);
}
