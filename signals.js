import axios from "axios";

const BASE = process.env.BINANCE_BASE_URL || "https://api.binance.com";

export async function fetchKlines(symbol = "BTCUSDT", interval = "15m", limit = 100) {
  const { data } = await axios.get(`${BASE}/api/v3/klines`, { params: { symbol, interval, limit } });
  return data.map(k => ({ open: parseFloat(k[1]), high: parseFloat(k[2]), low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]) }));
}

export async function fetchCurrentPrice(symbol = "BTCUSDT") {
  const { data } = await axios.get(`${BASE}/api/v3/ticker/price`, { params: { symbol } });
  return parseFloat(data.price);
}

export async function fetch24hStats(symbol = "BTCUSDT") {
  const { data } = await axios.get(`${BASE}/api/v3/ticker/24hr`, { params: { symbol } });
  return { priceChangePercent: parseFloat(data.priceChangePercent), high: parseFloat(data.highPrice), low: parseFloat(data.lowPrice), volume: parseFloat(data.volume), quoteVolume: parseFloat(data.quoteAssetVolume) };
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  let ag = gains / period, al = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (period - 1) + Math.max(d, 0)) / period;
    al = (al * (period - 1) + Math.max(-d, 0)) / period;
  }
  return al === 0 ? 100 : 100 - 100 / (1 + ag / al);
}

function calcEMA(closes, period) {
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
  return ema;
}

function calcATR(candles, period = 14) {
  const trs = candles.slice(1).map((c, i) => Math.max(c.high - c.low, Math.abs(c.high - candles[i].close), Math.abs(c.low - candles[i].close)));
  return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

export async function computeSignals() {
  const [candles, stats] = await Promise.all([fetchKlines(), fetch24hStats()]);
  const closes = candles.map(c => c.close);
  const currentPrice = closes[closes.length - 1];
  const rsi = calcRSI(closes);
  const ema9 = calcEMA(closes, 9);
  const ema21 = calcEMA(closes, 21);
  const atr = calcATR(candles);
  const momentum5 = (closes[closes.length - 1] - closes[closes.length - 6]) / closes[closes.length - 6];

  const rsiScore = rsi < 30 ? 1 : rsi < 40 ? 0.5 : rsi > 70 ? -1 : rsi > 60 ? -0.5 : (50 - rsi) / 50;
  const emaScore = Math.max(-1, Math.min(1, ((ema9 - ema21) / ema21) * 100));
  const momentumScore = Math.max(-1, Math.min(1, momentum5 * 50));
  const trendScore = Math.max(-1, Math.min(1, stats.priceChangePercent / 5));

  const bias = rsiScore * 0.25 + emaScore * 0.35 + momentumScore * 0.25 + trendScore * 0.15;
  const scores = [rsiScore, emaScore, momentumScore, trendScore];
  const allSame = scores.every(s => s >= 0) || scores.every(s => s <= 0);
  const avgStr = scores.map(Math.abs).reduce((a, b) => a + b, 0) / scores.length;
  const confidence = Math.min(1, allSame ? avgStr : avgStr * 0.5);

  return { bias: Math.max(-1, Math.min(1, bias)), confidence, rsi, ema9, ema21, atr, currentPrice, momentum5, stats, components: { rsiScore, emaScore, momentumScore, trendScore } };
}
