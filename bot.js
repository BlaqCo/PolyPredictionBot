import { computeSignals } from "./signals.js";
import { scoreSentiment } from "./sentiment.js";
import { sizeBet } from "./kelly.js";
import { fetchBTCMarkets, placeOrder, getBalance } from "./polymarket.js";
import { recordBet, hasActiveBet, recordScan, getStats } from "./state.js";

export async function runScanCycle() {
  console.log(`\n${"─".repeat(60)}`);
  console.log(`🔍 SCAN — ${new Date().toISOString()}`);
  recordScan();

  let signals;
  try {
    signals = await computeSignals();
    console.log(`📈 BTC $${signals.currentPrice.toLocaleString()} | RSI: ${signals.rsi.toFixed(1)} | Bias: ${signals.bias.toFixed(3)}`);
  } catch (err) {
    console.error("❌ Signal fetch failed:", err.message);
    return;
  }

  let markets;
  try {
    markets = await fetchBTCMarkets();
    console.log(`🏪 ${markets.length} BTC markets`);
  } catch (err) {
    console.error("❌ Market fetch failed:", err.message);
    return;
  }

  let betsPlaced = 0;
  for (const market of markets) {
    const conditionId = market.conditionId || market.condition_id;
    if (hasActiveBet(conditionId)) continue;

    console.log(`\n  📋 ${market.question}`);

    let sentiment = { sentimentBias: 0, reasoning: "skipped" };
    try { sentiment = await scoreSentiment(signals, market); } catch (e) {}

    const decision = sizeBet(signals, sentiment, market);
    console.log(`  💰 ${decision.shouldBet ? "BET" : "SKIP"} — ${decision.reasoning}`);
    if (!decision.shouldBet) continue;

    const token = market.tokens?.find(t => t.outcome?.toLowerCase() === decision.side.toLowerCase());
    if (!token) continue;

    const balance = await getBalance();
    if (balance < decision.betSize) continue;

    try {
      const order = await placeOrder({
        tokenId: token.tokenId || token.token_id,
        side: "BUY",
        size: decision.betSize,
        price: token.price,
        marketQuestion: market.question,
      });
      recordBet({ market, side: decision.side, betSize: decision.betSize, edge: decision.edge, trueProbability: decision.trueProb, impliedProbability: decision.impliedProb, orderId: order.orderID || order.id });
      betsPlaced++;
      console.log(`  ✅ BET: ${decision.side} $${decision.betSize} | edge ${(decision.edge * 100).toFixed(1)}%`);
    } catch (err) {
      console.error(`  ❌ Order failed: ${err.message}`);
    }
  }

  const stats = getStats();
  console.log(`\n📊 Done — ${betsPlaced} bet(s) | Total: ${stats.betsPlaced} | P&L: $${stats.pnl}`);
}
