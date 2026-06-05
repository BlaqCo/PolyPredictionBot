/**
 * kelly.js — Kelly criterion sizing
 * No artificial dampening. Same logic whether DRY or LIVE.
 */

function impliedProb(price) {
  return price > 1 ? price / 100 : price;
}

function estimateTrueProb(signals, sentiment, marketImpl, isYes) {
  const { bias, confidence } = signals;

  // Start at market implied
  let prob = marketImpl;

  // Signal adjustment — full strength, no dampening
  // A bias of +0.6 with 0.8 confidence on a YES bet shifts prob by +0.096
  // Real edge requires real signal, not artificial floors
  const signalAdj = (isYes ? bias : -bias) * confidence * 0.22;
  prob += signalAdj;

  // LLM sentiment if available
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

  // Pick best side
  let side, edge, trueProb, impliedP;
  if (yesEdge >= noEdge && yesEdge > 0) {
    side = "YES"; edge = yesEdge; trueProb = yesTrue; impliedP = yesImpl;
  } else if (noEdge > 0) {
    side = "NO"; edge = noEdge; trueProb = noTrue; impliedP = noImpl;
  } else {
    return { shouldBet: false, reasoning: `No edge — YES:${(yesEdge*100).toFixed(1)}% NO:${(noEdge*100).toFixed(1)}%` };
  }

  // Min edge: 2% — same threshold live or dry
  const MIN_EDGE = parseFloat(process.env.MIN_EDGE || "0.02");
  if (edge < MIN_EDGE) {
    return { shouldBet: false, edge, reasoning: `Edge ${(edge*100).toFixed(1)}% < min ${(MIN_EDGE*100).toFixed(0)}%` };
  }

  const k = kelly(trueProb, impliedP);
  if (k <= 0.005) {
    return { shouldBet: false, edge, reasoning: `Kelly ${(k*100).toFixed(2)}% too small` };
  }

  const KELLY_F   = parseFloat(process.env.KELLY_FRACTION || "0.3");
  const BANKROLL  = parseFloat(process.env.BANKROLL || "40");
  const MAX_BET   = parseFloat(process.env.MAX_BET_SIZE || "8");

  const raw = BANKROLL * k * KELLY_F;
  const betSize = Math.max(1, Math.min(raw, MAX_BET));

  return {
    shouldBet: true,
    side,
    betSize: parseFloat(betSize.toFixed(2)),
    edge,
    trueProb,
    impliedProb: impliedP,
    kellyRaw: k,
    reasoning: `${side} edge:${(edge*100).toFixed(1)}% kelly:${(k*100).toFixed(1)}% → $${betSize.toFixed(2)}`,
  };
}
