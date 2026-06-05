/**
 * kelly.js — Kelly criterion position sizing + edge calculation
 *
 * Combines:
 *   1. Technical signal bias → raw probability estimate
 *   2. LLM sentiment adjustment
 *   3. Market price (implied probability from Polymarket)
 *   4. Kelly formula → optimal bet size
 *   5. Fractional Kelly for risk management
 */

import { config } from "../config/index.js";

/**
 * Convert Polymarket YES token price to implied probability.
 * Polymarket prices are in cents (0-100), or 0.0-1.0 depending on endpoint.
 */
export function impliedProbability(price) {
  // Normalize: if price > 1, it's in cents format
  return price > 1 ? price / 100 : price;
}

/**
 * Estimate our "true" probability from signals + sentiment.
 *
 * @param {object} signals - from computeSignals()
 * @param {object} sentiment - from scoreSentiment()
 * @param {number} marketImpliedProb - from Polymarket price
 * @param {boolean} isYes - are we evaluating the YES side?
 */
export function estimateTrueProbability(signals, sentiment, marketImpliedProb, isYes) {
  const { bias, confidence } = signals;

  // Start from market implied (baseline)
  let prob = marketImpliedProb;

  // Technical signal adjustment
  // bias: +1 = very bullish, -1 = very bearish
  // For YES bets (price goes up), bullish bias increases our prob estimate
  const signalAdj = (isYes ? bias : -bias) * confidence * 0.15;
  prob += signalAdj;

  // Sentiment adjustment
  if (sentiment.probability != null) {
    // Weight: 30% LLM, 70% our technical estimate
    const llmAdjusted = isYes ? sentiment.probability : 1 - sentiment.probability;
    prob = prob * 0.7 + llmAdjusted * 0.3;
  } else if (sentiment.sentimentBias !== 0) {
    const sentAdj = (isYes ? sentiment.sentimentBias : -sentiment.sentimentBias) * 0.1;
    prob += sentAdj;
  }

  // Clamp to valid range
  return Math.max(0.02, Math.min(0.98, prob));
}

/**
 * Kelly criterion: f* = (bp - q) / b
 * where b = odds (1/price - 1), p = true prob, q = 1 - p
 *
 * Returns fraction of bankroll to bet.
 */
export function kellyFraction(trueProbability, impliedProb) {
  const b = (1 / impliedProb) - 1; // decimal odds
  const p = trueProbability;
  const q = 1 - p;

  const kelly = (b * p - q) / b;
  return kelly; // can be negative (don't bet) or positive
}

/**
 * Full bet sizing decision.
 *
 * @returns {object} {
 *   shouldBet: boolean,
 *   side: "YES" | "NO",
 *   betSize: number (USDC),
 *   edge: number,
 *   trueProbability: number,
 *   impliedProbability: number,
 *   kellyRaw: number,
 *   reasoning: string
 * }
 */
export function sizeBet(signals, sentiment, market) {
  const yesPrice = market.tokens?.find((t) => t.outcome === "Yes")?.price;
  const noPrice = market.tokens?.find((t) => t.outcome === "No")?.price;

  if (!yesPrice || !noPrice) {
    return { shouldBet: false, reasoning: "No token prices available" };
  }

  const yesImplied = impliedProbability(yesPrice);
  const noImplied = impliedProbability(noPrice);

  // Evaluate both sides
  const yesTrueProb = estimateTrueProbability(signals, sentiment, yesImplied, true);
  const noTrueProb = estimateTrueProbability(signals, sentiment, noImplied, false);

  const yesKelly = kellyFraction(yesTrueProb, yesImplied);
  const noKelly = kellyFraction(noTrueProb, noImplied);

  const yesEdge = yesTrueProb - yesImplied;
  const noEdge = noTrueProb - noImplied;

  // Pick the better side
  let side, edge, kelly, trueProb, impliedProb;
  if (yesEdge > noEdge && yesEdge > 0) {
    side = "YES";
    edge = yesEdge;
    kelly = yesKelly;
    trueProb = yesTrueProb;
    impliedProb = yesImplied;
  } else if (noEdge > 0) {
    side = "NO";
    edge = noEdge;
    kelly = noKelly;
    trueProb = noTrueProb;
    impliedProb = noImplied;
  } else {
    return {
      shouldBet: false,
      reasoning: `No edge found. YES edge: ${(yesEdge * 100).toFixed(1)}%, NO edge: ${(noEdge * 100).toFixed(1)}%`,
    };
  }

  // Minimum edge threshold
  if (edge < config.bot.minEdge) {
    return {
      shouldBet: false,
      edge,
      reasoning: `Edge ${(edge * 100).toFixed(1)}% below threshold ${(config.bot.minEdge * 100).toFixed(1)}%`,
    };
  }

  // Don't bet if Kelly is negative or tiny
  if (kelly <= 0.001) {
    return {
      shouldBet: false,
      edge,
      reasoning: `Kelly fraction too small: ${(kelly * 100).toFixed(2)}%`,
    };
  }

  // Fractional Kelly for safety
  const fractionalKelly = kelly * config.bot.kellyFraction;
  const rawBetSize = config.bot.bankroll * fractionalKelly;
  const betSize = Math.min(rawBetSize, config.bot.maxBetSize);
  const finalBetSize = Math.max(1, parseFloat(betSize.toFixed(2))); // min $1

  return {
    shouldBet: true,
    side,
    betSize: finalBetSize,
    edge,
    trueProb,
    impliedProb,
    kellyRaw: kelly,
    kellyFractional: fractionalKelly,
    reasoning: `${side} — edge ${(edge * 100).toFixed(1)}%, Kelly ${(fractionalKelly * 100).toFixed(1)}% → $${finalBetSize}`,
  };
}
