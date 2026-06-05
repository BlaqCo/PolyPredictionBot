/**
 * signals.js — Binance price signal engine
 *
 * Pulls BTC/USDT klines and computes:
 *   - RSI(14)
 *   - EMA(9) vs EMA(21) crossover
 *   - Momentum score
 *   - Volatility (ATR-like)
 *   - Combined directional bias [-1, +1]
 */

import axios from "axios";
import { config } from "../config/index.js";

const BASE = config.binance.baseUrl;

// ── Raw data ──────────────────────────────────────────────────────────────────

export async function fetchKlines(symbol = "BTCUSDT", interval = "15m", limit = 100) {
  const url = `${BASE}/api/v3/klines`;
  const { data } = await axios.get(url, {
    params: { symbol, interval, limit },
  });

  return data.map((k) => ({
    openTime: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
    closeTime: k[6],
  }));
}

export async function fetchCurrentPrice(symbol = "BTCUSDT") {
  const { data } = await axios.get(`${BASE}/api/v3/ticker/price`, {
    params: { symbol },
  });
  return parseFloat(data.price);
}

export async function fetch24hStats(symbol = "BTCUSDT") {
  const { data } = await axios.get(`${BASE}/api/v3/ticker/24hr`, {
    params: { symbol },
  });
  return {
    priceChangePercent: parseFloat(data.priceChangePercent),
    high: parseFloat(data.highPrice),
    low: parseFloat(data.lowPrice),
    volume: parseFloat(data.volume),
    quoteVolume: parseFloat(data.quoteAssetVolume),
  };
}

// ── Indicators ────────────────────────────────────────────────────────────────

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;

  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function calcEMA(closes, period) {
  if (closes.length < period) return closes[closes.length - 1];
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }
  return ema;
}

function calcATR(candles, period = 14) {
  const trs = candles.slice(1).map((c, i) => {
    const prev = candles[i];
    return Math.max(
      c.high - c.low,
      Math.abs(c.high - prev.close),
      Math.abs(c.low - prev.close)
    );
  });
  return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

// ── Main signal function ───────────────────────────────────────────────────────

/**
 * Returns a signal object:
 * {
 *   bias: number,        // -1 (strong bear) to +1 (strong bull)
 *   confidence: number,  // 0-1 how aligned signals are
 *   rsi: number,
 *   ema9: number,
 *   ema21: number,
 *   atr: number,
 *   currentPrice: number,
 *   momentum5: number,   // 5-candle % change
 *   components: object   // raw sub-scores
 * }
 */
export async function computeSignals() {
  const [candles, stats] = await Promise.all([
    fetchKlines("BTCUSDT", "15m", 100),
    fetch24hStats("BTCUSDT"),
  ]);

  const closes = candles.map((c) => c.close);
  const currentPrice = closes[closes.length - 1];

  const rsi = calcRSI(closes);
  const ema9 = calcEMA(closes, 9);
  const ema21 = calcEMA(closes, 21);
  const atr = calcATR(candles);

  // 5-candle momentum
  const momentum5 =
    (closes[closes.length - 1] - closes[closes.length - 6]) /
    closes[closes.length - 6];

  // ── Sub-scores (each -1 to +1) ──

  // RSI: oversold = bullish, overbought = bearish
  let rsiScore;
  if (rsi < 30) rsiScore = 1;
  else if (rsi < 40) rsiScore = 0.5;
  else if (rsi > 70) rsiScore = -1;
  else if (rsi > 60) rsiScore = -0.5;
  else rsiScore = (50 - rsi) / 50; // slight mean-reversion lean

  // EMA crossover
  const emaDiff = (ema9 - ema21) / ema21;
  const emaScore = Math.max(-1, Math.min(1, emaDiff * 100));

  // Momentum
  const momentumScore = Math.max(-1, Math.min(1, momentum5 * 50));

  // 24h trend
  const trendScore = Math.max(-1, Math.min(1, stats.priceChangePercent / 5));

  // Volume spike (neutral, just affects confidence)
  const relativeVolume = stats.quoteVolume / (stats.quoteVolume * 0.8); // simplified

  // ── Weighted composite ──
  const weights = { rsi: 0.25, ema: 0.35, momentum: 0.25, trend: 0.15 };
  const bias =
    rsiScore * weights.rsi +
    emaScore * weights.ema +
    momentumScore * weights.momentum +
    trendScore * weights.trend;

  // Confidence = how aligned are the 4 signals?
  const scores = [rsiScore, emaScore, momentumScore, trendScore];
  const allSameSign = scores.every((s) => s >= 0) || scores.every((s) => s <= 0);
  const absValues = scores.map(Math.abs);
  const avgStrength = absValues.reduce((a, b) => a + b, 0) / absValues.length;
  const confidence = allSameSign ? avgStrength : avgStrength * 0.5;

  return {
    bias: Math.max(-1, Math.min(1, bias)),
    confidence: Math.min(1, confidence),
    rsi,
    ema9,
    ema21,
    atr,
    currentPrice,
    momentum5,
    stats,
    components: { rsiScore, emaScore, momentumScore, trendScore },
  };
}
