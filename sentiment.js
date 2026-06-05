export async function scoreSentiment(signals, market) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || apiKey.startsWith("your_")) return { sentimentBias: 0, reasoning: "No API key" };

  const { currentPrice, rsi, ema9, ema21, momentum5, stats, bias, confidence } = signals;
  const prompt = `MARKET: "${market.question}"
BTC PRICE: $${currentPrice.toLocaleString()}
24H CHANGE: ${stats.priceChangePercent.toFixed(2)}%
RSI: ${rsi.toFixed(1)} | EMA9: $${ema9.toFixed(0)} | EMA21: $${ema21.toFixed(0)}
5-candle momentum: ${(momentum5 * 100).toFixed(2)}%
Signal bias: ${bias.toFixed(3)} (confidence: ${(confidence * 100).toFixed(0)}%)
What is the probability the YES outcome resolves?`;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514", max_tokens: 256,
        system: `You are a crypto quant analyst. Respond ONLY with JSON: {"probability": <0.0-1.0>, "confidence": <0.0-1.0>, "bias": "bullish"|"bearish"|"neutral", "reasoning": "<one sentence>"}`,
        messages: [{ role: "user", content: prompt }]
      })
    });
    const data = await res.json();
    const parsed = JSON.parse(data.content?.[0]?.text?.replace(/```json|```/g, "").trim());
    return { sentimentBias: parsed.bias === "bullish" ? parsed.confidence : parsed.bias === "bearish" ? -parsed.confidence : 0, probability: parsed.probability, confidence: parsed.confidence, reasoning: parsed.reasoning };
  } catch (err) {
    return { sentimentBias: 0, reasoning: "Error" };
  }
}
