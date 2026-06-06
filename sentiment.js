/**
 * sentiment.js — LLM-powered market sentiment scorer
 *
 * Uses Claude to score current BTC market sentiment based on:
 *   - Price action description
 *   - Technical signal summary
 *   - Returns a structured probability adjustment
 */

import { config } from "../config/index.js";

/**
 * Ask Claude to score the probability that BTC will be HIGHER
 * than current price at the resolution time of the market.
 *
 * @param {object} signalData - from signals.js computeSignals()
 * @param {object} market - Polymarket market object
 * @returns {object} { sentimentBias: number, reasoning: string, adjustedProb: number }
 */
export async function scoreSentiment(signalData, market) {
  if (!config.anthropic.apiKey || config.anthropic.apiKey.startsWith("your_")) {
    console.log("⚠️  No Anthropic key — skipping sentiment scoring");
    return { sentimentBias: 0, reasoning: "No API key", adjustedProb: null };
  }

  const prompt = buildPrompt(signalData, market);

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": config.anthropic.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 512,
        system: `You are a quantitative crypto market analyst. Your job is to assess the probability 
that Bitcoin's price will satisfy a given prediction market condition. 

You MUST respond with ONLY a JSON object — no markdown, no explanation outside the JSON:
{
  "probability": <number 0.0-1.0, your estimated true probability the YES outcome resolves>,
  "confidence": <number 0.0-1.0, how confident you are in your estimate>,
  "bias": <"bullish" | "bearish" | "neutral">,
  "reasoning": "<one sentence max>"
}`,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    const data = await response.json();
    const text = data.content?.[0]?.text || "";

    const cleaned = text.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(cleaned);

    return {
      sentimentBias: parsed.bias === "bullish" ? parsed.confidence : parsed.bias === "bearish" ? -parsed.confidence : 0,
      probability: parsed.probability,
      confidence: parsed.confidence,
      reasoning: parsed.reasoning,
    };
  } catch (err) {
    console.error("Sentiment API error:", err.message);
    return { sentimentBias: 0, reasoning: "Error", adjustedProb: null };
  }
}

function buildPrompt(signals, market) {
  const { currentPrice, rsi, ema9, ema21, momentum5, stats, bias, confidence } = signals;
  const priceChangeDir = stats.priceChangePercent >= 0 ? "up" : "down";

  return `
MARKET QUESTION: "${market.question}"
MARKET DESCRIPTION: "${market.description || "BTC price prediction"}"
RESOLUTION TIME: ${market.endDateIso || "unknown"}

CURRENT BTC PRICE: $${currentPrice.toLocaleString()}
24H CHANGE: ${stats.priceChangePercent.toFixed(2)}% (${priceChangeDir})
24H HIGH: $${stats.high.toLocaleString()} | LOW: $${stats.low.toLocaleString()}

TECHNICAL INDICATORS (15m):
- RSI(14): ${rsi.toFixed(1)} ${rsi > 70 ? "[OVERBOUGHT]" : rsi < 30 ? "[OVERSOLD]" : ""}
- EMA9: $${ema9.toFixed(0)} | EMA21: $${ema21.toFixed(0)} ${ema9 > ema21 ? "[BULLISH CROSS]" : "[BEARISH CROSS]"}
- 5-candle momentum: ${(momentum5 * 100).toFixed(2)}%
- Signal composite bias: ${bias.toFixed(3)} (confidence: ${(confidence * 100).toFixed(0)}%)

Given this data, what is the probability that the YES outcome resolves for this market?
`.trim();
}
