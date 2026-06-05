import { computeSignals, fetchOrderBook } from "./signals.js";
import { scoreSentiment } from "./sentiment.js";
import { sizeBet } from "./kelly.js";
import { fetchBTCMarkets, placeOrder, getBalance } from "./polymarket.js";
import { recordBet, hasActiveBet, recordScan, getStats, getAllActiveBets } from "./state.js";
import { checkScalpExits, filterScalpMarkets, scalpQuality } from "./scalper.js";

const DRY_RUN = process.env.DRY_RUN !== "false";

// Strategy state — controlled by dashboard settings
export const botSettings = {
  strategies: { RSI_EMA: true, WALL: true, BREAKOUT: true },
  autoMode: true,
  enabled: true,
};

export async function runScanCycle() {
  if (!botSettings.enabled) {
    console.log("⏸  Bot paused via settings");
    return { signals: null, exits: [], betsPlaced: 0 };
  }

  console.log(`\n── SCAN ${new Date().toISOString()} [${botSettings.autoMode ? 'AUTO' : 'MANUAL'}] ──`);
  recordScan();

  let signals;
  try {
    signals = await computeSignals(botSettings.strategies, botSettings.autoMode);
    const dir = signals.bias > 0.1 ? "↑BULL" : signals.bias < -0.1 ? "↓BEAR" : "→FLAT";
    console.log(
      `₿ $${signals.currentPrice.toLocaleString()} | ` +
      `Strategy: ${signals.activeStrategy} | ` +
      `Bias: ${signals.bias.toFixed(3)} ${dir} | ` +
      `Conf: ${(signals.confidence*100).toFixed(0)}% | ` +
      `[${signals.leadMeta}]`
    );
    if (signals.oraclePrice) {
      console.log(`⛓  Chainlink: $${signals.oraclePrice.toLocaleString()}`);
    }
  } catch (err) {
    console.error("❌ Signals failed:", err.message);
    return { signals: null, exits: [], betsPlaced: 0 };
  }

  let allMarkets;
  try {
    allMarkets = await fetchBTCMarkets();
  } catch (err) {
    console.error("❌ Markets failed:", err.message);
    return { signals, exits: [], betsPlaced: 0 };
  }

  // Check exits first
  let exits = [];
  if (getAllActiveBets().length > 0) {
    exits = await checkScalpExits(allMarkets, DRY_RUN);
    for (const e of exits) {
      console.log(`  ${e.pnl > 0 ? "🟢" : "🔴"} EXIT [${e.reason}] ${e.side} | P&L: ${e.pnl >= 0 ? "+" : ""}$${e.pnl}`);
    }
  }

  // Enter new positions
  const scalpMarkets = filterScalpMarkets(allMarkets);
  let betsPlaced = 0;
  const balance = await getBalance();

  for (const market of scalpMarkets) {
    const id = market.conditionId || market.condition_id;
    if (hasActiveBet(id)) continue;

    const quality = scalpQuality(market, signals);
    if (quality < 0.10) {
      console.log(`  SKIP (quality:${quality.toFixed(2)}): ${market.question?.slice(0,50)}`);
      continue;
    }

    let sentiment = { sentimentBias: 0 };
    try { sentiment = await scoreSentiment(signals, market); } catch {}

    const decision = sizeBet(signals, sentiment, market);
    if (!decision.shouldBet) continue;

    const maxBet = parseFloat(process.env.MAX_BET_SIZE || "10");
    const finalBet = Math.min(decision.betSize * (quality > 0.7 ? 1.2 : 1.0), maxBet);
    if (balance < finalBet) continue;

    const token = market.tokens?.find(t => t.outcome?.toLowerCase() === decision.side.toLowerCase());
    if (!token) continue;

    const entryPrice = token.price > 1 ? token.price / 100 : token.price;
    const minLeft = ((new Date(market.endDateIso) - Date.now()) / 60000).toFixed(0);

    try {
      const order = await placeOrder({ tokenId: token.tokenId || token.token_id, side: "BUY", size: finalBet, price: entryPrice, marketQuestion: market.question });
      recordBet({ market, side: decision.side, betSize: finalBet, edge: decision.edge, trueProbability: decision.trueProb, impliedProbability: decision.impliedProb, orderId: order.orderID || order.id, entryPrice });
      betsPlaced++;
      console.log(`  ✅ ENTRY ${decision.side} $${finalBet.toFixed(2)} @ ${(entryPrice*100).toFixed(1)}¢ | ${minLeft}min | strat:${signals.activeStrategy} | ${market.question?.slice(0,40)}`);
    } catch (err) { console.error(`  ❌ Order: ${err.message}`); }
  }

  const s = getStats();
  console.log(`── +${betsPlaced} entries | ${exits.length} exits | Active:${s.activeBets} | P&L:$${s.pnl} | Scalps:${s.scalps} ──`);
  return { signals, exits, betsPlaced };
}
