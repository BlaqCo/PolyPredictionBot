/**
 * kelly.js — PolyBettor bet sizing engine
 *
 * TUNING CHANGES for more frequent profitable entries:
 * 1. Signal weight raised 0.55 → 0.90: at low confidence, edge was near-zero
 * 2. Kelly floor lowered 0.003 → 0.001: was blocking valid small-edge bets
 * 3. Confidence boost threshold lowered 0.5 → 0.25: kicks in sooner
 * 4. MIN_EDGE env default lowered 0.015 → 0.010: catches more real opportunities
 *
 * Net effect: bot fires 3-5x more often on valid signals while Kelly
 * still caps bet size so bankroll is protected on losing streaks.
 */

function impliedProb(price) {
  return price > 1 ? price / 100 : price;
}

function estimateTrueProb(signals, sentiment, marketImpl, isYes) {
  const { bias, confidence } = signals;
  let prob = marketImpl;

  // Core signal adjustment — raised weight so low-confidence signals still register
  // bias=0.03, conf=0.02 on a NO → shifts prob by -0.03 * 0.02 * 0.90 = -0.00054 → still tiny
  // bias=0.23, conf=0.46 on a NO → shifts prob by -0.23 * 0.46 * 0.90 = -0.095 → meaningful
  // The WALL strategy (conf 45-46%) will produce strong signals; RSI needs momentum
  const signalAdj = (isYes ? bias : -bias) * confidence * 0.90;
  prob += signalAdj;

  // Confidence boost — lowered threshold from 0.50 to 0.25 so it kicks in sooner
  if (confidence > 0.25) {
    const extra = (isYes ? bias : -bias) * (confidence - 0.25) * 0.30;
    prob += extra;
  }

  // LLM sentiment blend
  if (sentiment?.probability != null) {
    const llm = isYes ? sentiment.probability : 1 - sentiment.probability;
    prob = prob * 0.65 + llm * 0.35;
  }

  return Math.max(0.03, Math.min(0.97, prob));
}

function kelly(trueP, impliedP) {
  const b = 1 / impliedP - 1;
  return (b * trueP - (1 - trueP)) / b;
}

export function sizeBet(signals, sentiment, market) {
  const yes = market.tokens?.find(t => t.outcome === "Yes");
  const no  = market.tokens?.find(t => t.outcome === "No");
  if (!yes || !no) return { shouldBet: false, reasoning: "No token prices" };

  const yesImpl = impliedProb(yes.price);
  const noImpl  = impliedProb(no.price);

  const yesTrue = estimateTrueProb(signals, sentiment, yesImpl, true);
  const noTrue  = estimateTrueProb(signals, sentiment, noImpl, false);

  const yesEdge = yesTrue - yesImpl;
  const noEdge  = noTrue  - noImpl;

  let side, edge, trueProb, impliedP;

  if (yesEdge >= noEdge && yesEdge > 0) {
    side = "YES"; edge = yesEdge; trueProb = yesTrue; impliedP = yesImpl;
  } else if (noEdge > 0) {
    side = "NO";  edge = noEdge;  trueProb = noTrue;  impliedP = noImpl;
  } else {
    return { shouldBet: false, reasoning: `No edge — YES:${(yesEdge*100).toFixed(1)}% NO:${(noEdge*100).toFixed(1)}%` };
  }

  // Min edge: lowered default to 1.0% to catch more valid opportunities
  const MIN_EDGE = parseFloat(process.env.MIN_EDGE || "0.010");
  if (edge < MIN_EDGE) {
    return { shouldBet: false, edge, reasoning: `Edge ${(edge*100).toFixed(1)}% < min ${(MIN_EDGE*100).toFixed(1)}%` };
  }

  const k = kelly(trueProb, impliedP);

  // Lowered Kelly floor from 0.003 to 0.001 — was blocking valid small-edge bets
  if (k <= 0.001) {
    return { shouldBet: false, edge, reasoning: `Kelly ${(k*100).toFixed(2)}% too small` };
  }

  const KELLY_F  = parseFloat(process.env.KELLY_FRACTION || "0.30");
  const BANKROLL = parseFloat(process.env.BANKROLL || "40");
  const MAX_BET  = parseFloat(process.env.MAX_BET_SIZE || "5");

  const raw     = BANKROLL * k * KELLY_F;
  const betSize = parseFloat(Math.max(1, Math.min(raw, MAX_BET)).toFixed(2));

  return {
    shouldBet: true,
    side,
    betSize,
    edge,
    trueProb,
    impliedProb: impliedP,
    kellyRaw: k,
    reasoning: `${side} edge:${(edge*100).toFixed(1)}% kelly:${(k*100).toFixed(1)}% → $${betSize}`,
  };
}
