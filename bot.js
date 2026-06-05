import { computeSignals, fetchOrderBook, detectWalls } from "./signals.js";
import { scoreSentiment } from "./sentiment.js";
import { sizeBet } from "./kelly.js";
import { fetchBTCMarkets, placeOrder, getBalance } from "./polymarket.js";
import { recordBet, hasActiveBet, recordScan, getStats } from "./state.js";

export async function runScanCycle() {
  console.log(`\n── SCAN ${new Date().toISOString()} ──`);
  recordScan();

  let signals;
  try {
    const [sig, book] = await Promise.all([computeSignals(), fetchOrderBook(150)]);
    const walls = detectWalls(book, sig.currentPrice);
    // Merge wall signal into bias (weighted 20%)
    signals = {
      ...sig,
      walls,
      bias: Math.max(-1, Math.min(1, sig.bias * 0.80 + walls.wallBias * walls.wallStrength * 0.20)),
    };
    const dir = signals.bias > 0.1 ? "↑BULL" : signals.bias < -0.1 ? "↓BEAR" : "→FLAT";
    console.log(`₿ $${signals.currentPrice.toLocaleString()} | RSI:${signals.rsi.toFixed(0)} | Bias:${signals.bias.toFixed(3)} ${dir} | Conf:${(signals.confidence*100).toFixed(0)}% | Wall:${walls.wallBias.toFixed(2)}`);
    if (signals.oraclePrice) console.log(`⛓  Chainlink oracle: $${signals.oraclePrice.toLocaleString()} (diff: ${(signals.oracleDiff*100)?.toFixed(3)}%)`);
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
    const id = market.conditionId || market.condition_id;
    if (hasActiveBet(id)) continue;

    let sentiment = { sentimentBias: 0, reasoning: "skipped" };
    try { sentiment = await scoreSentiment(signals, market); } catch {}

    const decision = sizeBet(signals, sentiment, market);
    if (!decision.shouldBet) {
      console.log(`  SKIP: ${market.question?.slice(0,50)} — ${decision.reasoning}`);
      continue;
    }

    const token = market.tokens?.find(t => t.outcome?.toLowerCase() === decision.side.toLowerCase());
    if (!token) continue;

    const balance = await getBalance();
    if (balance < decision.betSize) { console.log(`  💸 Low balance: $${balance.toFixed(2)}`); continue; }

    try {
      const order = await placeOrder({ tokenId: token.tokenId || token.token_id, side: "BUY", size: decision.betSize, price: token.price, marketQuestion: market.question });
      recordBet({ market, side: decision.side, betSize: decision.betSize, edge: decision.edge, trueProbability: decision.trueProb, impliedProbability: decision.impliedProb, orderId: order.orderID || order.id });
      betsPlaced++;
      console.log(`  ✅ BET ${decision.side} $${decision.betSize} | edge ${(decision.edge*100).toFixed(1)}% | ${market.question?.slice(0,45)}`);
    } catch (err) { console.error(`  ❌ Order: ${err.message}`); }
  }

  const s = getStats();
  console.log(`── Done: ${betsPlaced} bets | Total: ${s.betsPlaced} | P&L: $${s.pnl} ──`);
  return signals;
}
