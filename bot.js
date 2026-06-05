/**
 * bot.js — Main orchestration engine
 *
 * Per scan cycle:
 *   1. Fetch BTC price signals from Binance
 *   2. Fetch active BTC markets from Polymarket
 *   3. For each market: run sentiment scoring + Kelly sizing
 *   4. Place bets where edge > threshold
 *   5. Log everything
 */

import { computeSignals } from "./signals.js";
import { scoreSentiment } from "./sentiment.js";
import { sizeBet } from "./kelly.js";
import { fetchBTCMarkets, placeOrder, getBalance } from "./polymarket.js";
import { recordBet, hasActiveBet, recordScan, getStats } from "./state.js";
import { config } from "./config/index.js";

export async function runScanCycle() {
  console.log(`\n${"─".repeat(60)}`);
  console.log(`🔍 SCAN CYCLE — ${new Date().toISOString()}`);
  console.log(`${"─".repeat(60)}`);

  recordScan();

  // ── 1. Fetch signals ──────────────────────────────────────────
  let signals;
  try {
    signals = await computeSignals();
    console.log(
      `📈 BTC $${signals.currentPrice.toLocaleString()} | RSI: ${signals.rsi.toFixed(1)} | ` +
      `EMA9/21: ${signals.ema9 > signals.ema21 ? "↑ BULL" : "↓ BEAR"} | ` +
      `Bias: ${signals.bias.toFixed(3)} (conf: ${(signals.confidence * 100).toFixed(0)}%)`
    );
  } catch (err) {
    console.error("❌ Signal fetch failed:", err.message);
    return;
  }

  // ── 2. Fetch markets ──────────────────────────────────────────
  let markets;
  try {
    markets = await fetchBTCMarkets();
    console.log(`🏪 Processing ${markets.length} BTC markets`);
  } catch (err) {
    console.error("❌ Market fetch failed:", err.message);
    return;
  }

  if (markets.length === 0) {
    console.log("⚠️  No active BTC markets found");
    return;
  }

  // ── 3. Evaluate each market ───────────────────────────────────
  let betsPlaced = 0;

  for (const market of markets) {
    const conditionId = market.conditionId || market.condition_id;

    // Skip if already have an active bet on this market
    if (hasActiveBet(conditionId)) {
      console.log(`⏭️  Skipping — active bet exists: ${market.question?.slice(0, 50)}`);
      continue;
    }

    console.log(`\n  📋 ${market.question}`);

    // Get LLM sentiment score
    let sentiment = { sentimentBias: 0, reasoning: "skipped" };
    try {
      sentiment = await scoreSentiment(signals, market);
      console.log(
        `  🤖 Sentiment: ${sentiment.bias || "neutral"} ` +
        `(prob: ${sentiment.probability ? (sentiment.probability * 100).toFixed(0) + "%" : "N/A"}) ` +
        `— ${sentiment.reasoning}`
      );
    } catch (err) {
      console.error(`  ⚠️  Sentiment error: ${err.message}`);
    }

    // Kelly sizing
    const decision = sizeBet(signals, sentiment, market);
    console.log(`  💰 Decision: ${decision.shouldBet ? "BET" : "SKIP"} — ${decision.reasoning}`);

    if (!decision.shouldBet) continue;

    // Get the token to bet on
    const token = market.tokens?.find(
      (t) => t.outcome?.toLowerCase() === decision.side.toLowerCase()
    );

    if (!token) {
      console.log(`  ⚠️  Token not found for side: ${decision.side}`);
      continue;
    }

    // Check balance
    const balance = await getBalance();
    if (balance < decision.betSize) {
      console.log(`  💸 Insufficient balance: $${balance.toFixed(2)} < $${decision.betSize}`);
      continue;
    }

    // Place order
    try {
      const order = await placeOrder({
        tokenId: token.tokenId || token.token_id,
        side: "BUY",
        size: decision.betSize,
        price: token.price,
        marketQuestion: market.question,
      });

      recordBet({
        market,
        side: decision.side,
        betSize: decision.betSize,
        edge: decision.edge,
        trueProbability: decision.trueProb,
        impliedProbability: decision.impliedProb,
        orderId: order.orderID || order.orderId || order.id,
      });

      betsPlaced++;
      console.log(
        `  ✅ BET PLACED: ${decision.side} $${decision.betSize} ` +
        `| edge ${(decision.edge * 100).toFixed(1)}% ` +
        `| true ${(decision.trueProb * 100).toFixed(0)}% vs implied ${(decision.impliedProb * 100).toFixed(0)}%`
      );
    } catch (err) {
      console.error(`  ❌ Order failed: ${err.message}`);
    }
  }

  // ── 4. Summary ────────────────────────────────────────────────
  const stats = getStats();
  console.log(
    `\n📊 Cycle complete — ${betsPlaced} bet(s) placed | ` +
    `Session: ${stats.betsPlaced} total, $${stats.totalWagered} wagered, P&L: $${stats.pnl}`
  );
}
