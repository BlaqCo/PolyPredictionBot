const MIN_EDGE = parseFloat(process.env.MIN_EDGE || "0.05");
const KELLY_FRACTION = parseFloat(process.env.KELLY_FRACTION || "0.25");
const BANKROLL = parseFloat(process.env.BANKROLL || "100");
const MAX_BET = parseFloat(process.env.MAX_BET_SIZE || "10");

function impliedProb(price) { return price > 1 ? price / 100 : price; }

function trueProbability(signals, sentiment, marketImplied, isYes) {
  let prob = marketImplied;
  prob += (isYes ? signals.bias : -signals.bias) * signals.confidence * 0.15;
  if (sentiment.probability != null) {
    prob = prob * 0.7 + (isYes ? sentiment.probability : 1 - sentiment.probability) * 0.3;
  }
  return Math.max(0.02, Math.min(0.98, prob));
}

function kelly(trueP, impliedP) {
  const b = 1 / impliedP - 1;
  return (b * trueP - (1 - trueP)) / b;
}

export function sizeBet(signals, sentiment, market) {
  const yesToken = market.tokens?.find(t => t.outcome === "Yes");
  const noToken = market.tokens?.find(t => t.outcome === "No");
  if (!yesToken || !noToken) return { shouldBet: false, reasoning: "No token prices" };

  const yesImpl = impliedProb(yesToken.price);
  const noImpl = impliedProb(noToken.price);
  const yesTrue = trueProbability(signals, sentiment, yesImpl, true);
  const noTrue = trueProbability(signals, sentiment, noImpl, false);
  const yesEdge = yesTrue - yesImpl;
  const noEdge = noTrue - noImpl;

  let side, edge, trueProb, impliedP;
  if (yesEdge > noEdge && yesEdge > 0) { side = "YES"; edge = yesEdge; trueProb = yesTrue; impliedP = yesImpl; }
  else if (noEdge > 0) { side = "NO"; edge = noEdge; trueProb = noTrue; impliedP = noImpl; }
  else return { shouldBet: false, reasoning: `No edge. YES: ${(yesEdge*100).toFixed(1)}% NO: ${(noEdge*100).toFixed(1)}%` };

  if (edge < MIN_EDGE) return { shouldBet: false, edge, reasoning: `Edge ${(edge*100).toFixed(1)}% below min ${(MIN_EDGE*100).toFixed(0)}%` };

  const k = kelly(trueProb, impliedP);
  if (k <= 0.001) return { shouldBet: false, edge, reasoning: "Kelly too small" };

  const betSize = Math.min(Math.max(1, parseFloat((BANKROLL * k * KELLY_FRACTION).toFixed(2))), MAX_BET);
  return { shouldBet: true, side, betSize, edge, trueProb, impliedProb: impliedP, kellyRaw: k, reasoning: `${side} edge ${(edge*100).toFixed(1)}% → $${betSize}` };
}
