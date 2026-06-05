/**
 * scalper.js — Prediction Market Scalping Engine
 *
 * Strategy: "Momentum Scalp"
 * ─────────────────────────
 * 1. Enter when edge + signal confidence is high
 * 2. Monitor open positions every scan (every 8s)
 * 3. Exit (take profit) when position is up 15–25%
 * 4. Exit (stop loss) when position is down 8%
 * 5. Re-enter same market if new signal appears after exit
 *
 * Why this works on Polymarket:
 *   YES/NO token prices move with BTC price momentum.
 *   A 15-min or 1-hr contract's implied prob shifts
 *   several percentage points on any notable BTC move.
 *   We're trading the delta, not waiting for resolution.
 *
 * Target: 70%+ win rate via tight stops + trend following
 */

import { getActiveBet, getAllActiveBets, closeBet } from "./state.js";

// ── Config ────────────────────────────────────────────────────
const TAKE_PROFIT_LOW  = parseFloat(process.env.TP_LOW  || "0.15"); // 15% gain → start exiting
const TAKE_PROFIT_HIGH = parseFloat(process.env.TP_HIGH || "0.25"); // 25% gain → must exit
const STOP_LOSS        = parseFloat(process.env.STOP_LOSS || "0.08"); // 8% loss → cut
const TRAIL_AFTER      = parseFloat(process.env.TRAIL_AFTER || "0.10"); // 10% up → trail stop activates
const TRAIL_PCT        = parseFloat(process.env.TRAIL_PCT || "0.05");   // trail 5% below peak

// Per-bet state for trailing stop
const trailState = new Map(); // conditionId → { peak, trailStop }

/**
 * Check all open positions against current market prices.
 * Returns list of exit actions taken.
 *
 * @param {Array} markets - enriched markets from polymarket.js (with _decision)
 * @param {boolean} dryRun
 */
export async function checkScalpExits(markets, dryRun = true) {
  const activeBets = getAllActiveBets();
  if (activeBets.length === 0) return [];

  const exits = [];

  for (const bet of activeBets) {
    // Find current market price for our token
    const market = markets.find(m =>
      (m.conditionId || m.condition_id) === bet.marketConditionId
    );

    if (!market) continue; // market not in current scan, skip

    const token = market.tokens?.find(t =>
      t.outcome?.toLowerCase() === bet.side.toLowerCase()
    );

    if (!token) continue;

    // Normalize price to 0.0–1.0
    const currentPrice = token.price > 1 ? token.price / 100 : token.price;
    const entryPrice = bet.entryPrice;

    if (!entryPrice || entryPrice <= 0) continue;

    // P&L as % of entry
    const pnlPct = (currentPrice - entryPrice) / entryPrice;
    const unrealizedPnl = bet.betSize * pnlPct;

    // ── Trailing stop logic ────────────────────────────────────
    let trail = trailState.get(bet.marketConditionId);
    if (!trail) {
      trail = { peak: currentPrice, trailStop: null };
      trailState.set(bet.marketConditionId, trail);
    }

    // Update peak
    if (currentPrice > trail.peak) {
      trail.peak = currentPrice;
    }

    // Activate trailing stop once up TRAIL_AFTER
    const peakPnlPct = (trail.peak - entryPrice) / entryPrice;
    if (peakPnlPct >= TRAIL_AFTER) {
      trail.trailStop = trail.peak * (1 - TRAIL_PCT);
    }

    // ── Exit decisions ─────────────────────────────────────────
    let shouldExit = false;
    let exitReason = "";

    // 1. Take profit: up 15–25%
    if (pnlPct >= TAKE_PROFIT_LOW) {
      shouldExit = true;
      exitReason = pnlPct >= TAKE_PROFIT_HIGH ? "TAKE_PROFIT_MAX" : "TAKE_PROFIT";
    }

    // 2. Trailing stop hit
    if (trail.trailStop && currentPrice <= trail.trailStop) {
      shouldExit = true;
      exitReason = "TRAIL_STOP";
    }

    // 3. Stop loss: down 8%
    if (pnlPct <= -STOP_LOSS) {
      shouldExit = true;
      exitReason = "STOP_LOSS";
    }

    // 4. Market about to expire (< 5 min remaining) — exit to avoid slippage risk
    if (market.endDateIso) {
      const msLeft = new Date(market.endDateIso) - Date.now();
      if (msLeft > 0 && msLeft < 5 * 60 * 1000) {
        shouldExit = true;
        exitReason = "NEAR_EXPIRY";
      }
    }

    if (!shouldExit) {
      console.log(`  📊 HOLD ${bet.side} ${bet.marketQuestion?.slice(0,40)} | entry:${(entryPrice*100).toFixed(1)}¢ now:${(currentPrice*100).toFixed(1)}¢ | P&L: ${pnlPct >= 0 ? '+' : ''}${(pnlPct*100).toFixed(1)}%`);
      continue;
    }

    // ── Execute exit ───────────────────────────────────────────
    const finalPnl = parseFloat(unrealizedPnl.toFixed(2));

    console.log(
      `  🎯 EXIT [${exitReason}] ${bet.side} $${bet.betSize}` +
      ` | entry:${(entryPrice*100).toFixed(1)}¢ → exit:${(currentPrice*100).toFixed(1)}¢` +
      ` | P&L: ${finalPnl >= 0 ? '+' : ''}$${finalPnl}` +
      (dryRun ? ' [DRY RUN]' : '')
    );

    if (!dryRun) {
      // In live mode: sell the token back (place SELL order)
      try {
        const { placeOrder } = await import("./polymarket.js");
        await placeOrder({
          tokenId: token.tokenId || token.token_id,
          side: "SELL",
          size: bet.betSize / entryPrice, // token quantity
          price: currentPrice,
          marketQuestion: bet.marketQuestion,
        });
      } catch (err) {
        console.error(`  ❌ Exit order failed: ${err.message}`);
        continue;
      }
    }

    closeBet(bet.marketConditionId, {
      exitPrice: currentPrice,
      reason: exitReason.toLowerCase().includes('stop') ? 'stop_loss' :
              exitReason === 'NEAR_EXPIRY' ? 'expiry' : 'take_profit',
      pnl: finalPnl,
    });

    trailState.delete(bet.marketConditionId);

    exits.push({
      market: bet.marketQuestion,
      side: bet.side,
      pnlPct,
      pnl: finalPnl,
      reason: exitReason,
    });
  }

  return exits;
}

/**
 * Filter markets to only short-duration ones (15-min or 1-hr contracts)
 * These are ideal for scalping — fast price movement, quick resolution.
 */
export function filterScalpMarkets(markets) {
  return markets.filter(m => {
    if (!m.endDateIso) return false;
    const msLeft = new Date(m.endDateIso) - Date.now();
    const minutesLeft = msLeft / 60000;

    // Target: markets with 5–90 minutes remaining
    // Avoid: < 5 min (too close to expiry, bad liquidity)
    // Avoid: > 90 min (too slow for scalping)
    return minutesLeft >= 5 && minutesLeft <= 90;
  });
}

/**
 * Score a market for scalp quality (0–1)
 * Higher = better scalp candidate
 */
export function scalpQuality(market, signals) {
  let score = 0;
  if (!market.endDateIso) return 0;

  const msLeft = new Date(market.endDateIso) - Date.now();
  const minLeft = msLeft / 60000;

  // Sweet spot: 15–45 min remaining
  if (minLeft >= 15 && minLeft <= 45) score += 0.3;
  else if (minLeft >= 5 && minLeft <= 90) score += 0.1;

  // High signal confidence = better entry
  score += signals.confidence * 0.4;

  // Strong bias = clearer direction
  score += Math.abs(signals.bias) * 0.3;

  return Math.min(1, score);
}
