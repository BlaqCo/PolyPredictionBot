/**
 * bot.js — Main scan orchestration
 * Integrates: signal engine + Kelly sizing + scalp exits + wall detection
 */

import { computeSignals, fetchOrderBook, detectWalls } from "./signals.js";
import { scoreSentiment } from "./sentiment.js";
import { sizeBet } from "./kelly.js";
import { fetchBTCMarkets, placeOrder, getBalance } from "./polymarket.js";
import { recordBet, hasActiveBet, recordScan, getStats, getAllActiveBets } from "./state.js";
import { checkScalpExits, filterScalpMarkets, scalpQuality } from "./scalper.js";

const DRY_RUN = process.env.DRY_RUN !== "false";

export async function runScanCycle() {
  console.log(`\n── SCAN ${new Date().toISOString()} ──`);
  recordScan();

  // ── 1. Signals + Order Book ────────────────────────────────
  let signals;
  try {
    const [sig, book] = await Promise.all([computeSignals(), fetchOrderBook(150)]);
    const walls = detectWalls(book, sig.currentPrice);
    signals = {
      ...sig,
      walls,
      bias: Math.max(-1, Math.min(1, sig.bias * 0.80 + walls.wallBias * walls.wallStrength * 0.20)),
    };
    const dir = signals.bias > 0.1 ? "↑BULL" : signals.bias < -0.1 ? "↓BEAR" : "→FLAT";
    console.log(
      `₿ $${signals.currentPrice.toLocaleString()} | ` +
      `RSI:${signals.rsi.toFixed(0)} | ` +
      `Bias:${signals.bias.toFixed(3)} ${dir} | ` +
      `Conf:${(signals.confidence*100).toFixed(0)}% | ` +
      `Wall:${signals.walls.wallBias.toFixed(2)} | ` +
      `⛓ Oracle:$${signals.oraclePrice?.toLocaleString() || '—'}`
    );
  } catch (err) {
    console.error("❌ Signal fetch failed:", err.message);
    return { signals: null, exits: [], betsPlaced: 0 };
  }

  // ── 2. Fetch markets ───────────────────────────────────────
  let allMarkets;
  try {
    allMarkets = await fetchBTCMarkets();
  } catch (err) {
    console.error("❌ Market fetch failed:", err.message);
    return { signals, exits: [], betsPlaced: 0 };
  }

  // ── 3. CHECK SCALP EXITS FIRST (before entering new bets) ──
  let exits = [];
  if (getAllActiveBets().length > 0) {
    console.log(`\n  📋 Checking ${getAllActiveBets().length} open position(s) for exits...`);
    exits = await checkScalpExits(allMarkets, DRY_RUN);
    if (exits.length > 0) {
      for (const e of exits) {
        const emoji = e.pnl > 0 ? "🟢" : "🔴";
        console.log(`  ${emoji} ${e.reason} — ${e.side} ${e.market?.slice(0,45)} | P&L: ${e.pnl >= 0 ? '+' : ''}$${e.pnl}`);
      }
    }
  }

  // ── 4. Filter for scalp-quality markets (15–90 min) ────────
  const scalpMarkets = filterScalpMarkets(allMarkets);
  console.log(`\n  🎯 ${scalpMarkets.length} scalp-eligible markets (15–90 min remaining) of ${allMarkets.length} total`);

  // ── 5. Enter new positions ─────────────────────────────────
  let betsPlaced = 0;
  const balance = await getBalance();

  for (const market of scalpMarkets) {
    const id = market.conditionId || market.condition_id;
    if (hasActiveBet(id)) continue; // already in this market

    // Score scalp quality
    const quality = scalpQuality(market, signals);
    if (quality < 0.35) {
      console.log(`  SKIP (quality ${quality.toFixed(2)}): ${market.question?.slice(0,50)}`);
      continue;
    }

    // Get LLM sentiment
    let sentiment = { sentimentBias: 0, reasoning: "skipped" };
    try { sentiment = await scoreSentiment(signals, market); } catch {}

    // Kelly sizing
    const decision = sizeBet(signals, sentiment, market);
    if (!decision.shouldBet) {
      console.log(`  SKIP (${decision.reasoning?.slice(0,60)})`);
      continue;
    }

    // Boost bet size slightly for high-quality scalps (capped at max)
    const scalpMultiplier = quality > 0.7 ? 1.2 : 1.0;
    const maxBet = parseFloat(process.env.MAX_BET_SIZE || "10");
    const finalBetSize = Math.min(decision.betSize * scalpMultiplier, maxBet);

    const token = market.tokens?.find(t => t.outcome?.toLowerCase() === decision.side.toLowerCase());
    if (!token) continue;

    if (balance < finalBetSize) {
      console.log(`  💸 Low balance: $${balance.toFixed(2)}`);
      continue;
    }

    const entryPrice = token.price > 1 ? token.price / 100 : token.price;
    const msLeft = new Date(market.endDateIso) - Date.now();
    const minLeft = (msLeft / 60000).toFixed(0);

    try {
      const order = await placeOrder({
        tokenId: token.tokenId || token.token_id,
        side: "BUY",
        size: finalBetSize,
        price: entryPrice,
        marketQuestion: market.question,
      });

      recordBet({
        market,
        side: decision.side,
        betSize: finalBetSize,
        edge: decision.edge,
        trueProbability: decision.trueProb,
        impliedProbability: decision.impliedProb,
        orderId: order.orderID || order.id,
        entryPrice,
      });

      betsPlaced++;
      console.log(
        `  ✅ SCALP ENTRY ${decision.side} $${finalBetSize.toFixed(2)} @ ${(entryPrice*100).toFixed(1)}¢ | ` +
        `${minLeft}min left | edge ${(decision.edge*100).toFixed(1)}% | quality ${quality.toFixed(2)} | ` +
        `${market.question?.slice(0,45)}`
      );
    } catch (err) {
      console.error(`  ❌ Order failed: ${err.message}`);
    }
  }

  const s = getStats();
  console.log(
    `── Done: +${betsPlaced} entries | ${exits.length} exits | ` +
    `Active: ${s.activeBets} | P&L: $${s.pnl} | Scalps: ${s.scalps} ──`
  );

  return { signals, exits, betsPlaced };
}
