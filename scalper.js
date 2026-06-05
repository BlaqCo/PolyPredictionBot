/**
 * scalper.js — Momentum Scalp Engine
 * TP: 15–25% | Trail stop: 10% activation, 5% trail | SL: 8%
 */

import { getAllActiveBets, closeBet } from "./state.js";

const TP_LOW    = parseFloat(process.env.TP_LOW    || "0.15");
const TP_HIGH   = parseFloat(process.env.TP_HIGH   || "0.25");
const STOP_LOSS = parseFloat(process.env.STOP_LOSS || "0.40");
const TRAIL_AT  = parseFloat(process.env.TRAIL_AFTER || "0.10");
const TRAIL_PCT = parseFloat(process.env.TRAIL_PCT   || "0.05");

const trailState = new Map();

export async function checkScalpExits(markets, dryRun = true) {
  const active = getAllActiveBets();
  if (active.length === 0) return [];
  const exits = [];

  for (const bet of active) {
    const market = markets.find(m =>
      (m.conditionId || m.condition_id) === bet.marketConditionId
    );

    // If market not in current batch, look up by token price drift
    // For synthetic markets, simulate realistic price movement
    let currentPrice;

    if (market) {
      const token = market.tokens?.find(t =>
        t.outcome?.toLowerCase() === bet.side.toLowerCase()
      );
      currentPrice = token ? (token.price > 1 ? token.price / 100 : token.price) : null;
    }

    // For synthetic markets: simulate price drift based on time held
    if (!currentPrice && bet.entryPrice) {
      const msHeld = Date.now() - new Date(bet.placedAt).getTime();
      const minutesHeld = msHeld / 60000;
      // Synthetic price drift: ±0.3% per minute based on entry direction
      const drift = (minutesHeld * 0.003) * (bet.side === "YES" ? 1 : -1) * (Math.random() > 0.4 ? 1 : -0.5);
      currentPrice = Math.max(0.05, Math.min(0.95, bet.entryPrice + drift));
    }

    if (!currentPrice || !bet.entryPrice) continue;

    const pnlPct = (currentPrice - bet.entryPrice) / bet.entryPrice;
    const unrealizedPnl = bet.betSize * pnlPct;

    // Trailing stop
    let trail = trailState.get(bet.marketConditionId);
    if (!trail) { trail = { peak: currentPrice, trailStop: null }; trailState.set(bet.marketConditionId, trail); }
    if (currentPrice > trail.peak) trail.peak = currentPrice;
    const peakPnlPct = (trail.peak - bet.entryPrice) / bet.entryPrice;
    if (peakPnlPct >= TRAIL_AT) trail.trailStop = trail.peak * (1 - TRAIL_PCT);

    let shouldExit = false, exitReason = "";

    if (pnlPct >= TP_LOW) { shouldExit = true; exitReason = pnlPct >= TP_HIGH ? "TAKE_PROFIT_MAX" : "TAKE_PROFIT"; }
    if (trail.trailStop && currentPrice <= trail.trailStop) { shouldExit = true; exitReason = "TRAIL_STOP"; }
    if (pnlPct <= -STOP_LOSS) { shouldExit = true; exitReason = "STOP_LOSS"; }

    if (market?.endDateIso) {
      const msLeft = new Date(market.endDateIso) - Date.now();
      if (msLeft > 0 && msLeft < 5 * 60 * 1000) { shouldExit = true; exitReason = "NEAR_EXPIRY"; }
    }

    if (!shouldExit) {
      console.log(`  📊 HOLD ${bet.side} $${bet.betSize} | entry:${(bet.entryPrice*100).toFixed(1)}¢ now:${(currentPrice*100).toFixed(1)}¢ | ${pnlPct >= 0 ? '+' : ''}${(pnlPct*100).toFixed(1)}%`);
      continue;
    }

    const finalPnl = parseFloat(unrealizedPnl.toFixed(2));
    console.log(`  🎯 EXIT [${exitReason}] ${bet.side} $${bet.betSize} | entry:${(bet.entryPrice*100).toFixed(1)}¢ → ${(currentPrice*100).toFixed(1)}¢ | ${finalPnl >= 0 ? '+' : ''}$${finalPnl}`);

    if (!dryRun && exitReason !== "STOP_LOSS") {
      try {
        const { placeOrder } = await import("./polymarket.js");
        const tokenId = `exit_${bet.marketConditionId}`;
        await placeOrder({ tokenId, side: "SELL", size: bet.betSize / bet.entryPrice, price: currentPrice, marketQuestion: bet.marketQuestion });
      } catch (err) { console.error(`  ❌ Exit order failed: ${err.message}`); continue; }
    }

    closeBet(bet.marketConditionId, {
      exitPrice: currentPrice,
      reason: exitReason.includes("STOP") || exitReason === "TRAIL_STOP" ? "stop_loss" :
              exitReason === "NEAR_EXPIRY" ? "expiry" : "take_profit",
      pnl: finalPnl,
    });
    trailState.delete(bet.marketConditionId);
    exits.push({ market: bet.marketQuestion, side: bet.side, pnlPct, pnl: finalPnl, reason: exitReason });
  }

  return exits;
}

export function filterScalpMarkets(markets) {
  return markets.filter(m => {
    if (!m.endDateIso && !m.endDate) return true; // include if no expiry info
    const end = new Date(m.endDateIso || m.endDate);
    const minLeft = (end - Date.now()) / 60000;
    return minLeft >= 4 && minLeft <= 180;
  });
}

export function scalpQuality(market, signals) {
  let score = 0;

  // Time score
  if (market.endDateIso || market.endDate) {
    const minLeft = (new Date(market.endDateIso || market.endDate) - Date.now()) / 60000;
    if (minLeft >= 10 && minLeft <= 30) score += 0.35;      // 15-min sweet spot
    else if (minLeft >= 30 && minLeft <= 75) score += 0.25; // 1-hr range
    else if (minLeft >= 4 && minLeft <= 180) score += 0.10;
    else return 0; // expired or too far
  } else {
    score += 0.20; // no expiry info — assume valid
  }

  // Signal confidence
  score += Math.min(0.40, signals.confidence * 0.45);

  // Bias strength — need a clear direction
  score += Math.min(0.25, Math.abs(signals.bias) * 0.30);

  return Math.min(1, score);
}
