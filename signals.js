/**
 * signals.js
 * Price: Chainlink BTC/USD on Polygon (same oracle Polymarket settles on) → Kraken fallback
 * Strategies: RSI, Triple EMA, VWAP, Bollinger, MACD, Momentum, Order Book Walls
 */
import axios from "axios";

const CHAINLINK_RPC = "https://polygon-rpc.com";
const CHAINLINK_BTC_USD = "0xc907E116054Ad103354f2D350FD2514433D57F6F";
const LATEST_ROUND = "0xfeaf968c";

async function fetchChainlinkPrice() {
  const { data } = await axios.post(CHAINLINK_RPC, {
    jsonrpc: "2.0", id: 1, method: "eth_call",
    params: [{ to: CHAINLINK_BTC_USD, data: LATEST_ROUND }, "latest"],
  }, { timeout: 6000 });
  if (!data.result || data.result === "0x") throw new Error("Empty Chainlink");
  return Number(BigInt("0x" + data.result.slice(66, 130))) / 1e8;
}

async function fetchKrakenPrice() {
  const { data } = await axios.get("https://api.kraken.com/0/public/Ticker", { params: { pair: "XBTUSD" }, timeout: 6000 });
  return parseFloat(data.result?.XXBTZUSD?.c?.[0]);
}

export async function fetchCurrentPrice() {
  try { const p = await fetchChainlinkPrice(); if (p > 1000) return p; } catch {}
  return fetchKrakenPrice();
}

export async function fetch24hStats() {
  const { data } = await axios.get("https://api.kraken.com/0/public/Ticker", { params: { pair: "XBTUSD" }, timeout: 6000 });
  const t = data.result?.XXBTZUSD;
  if (!t) throw new Error("No Kraken ticker");
  const last = parseFloat(t.c[0]);
  return {
    priceChangePercent: ((last - parseFloat(t.o)) / parseFloat(t.o)) * 100,
    high: parseFloat(t.h[1]), low: parseFloat(t.l[1]),
    volume: parseFloat(t.v[1]), quoteVolume: parseFloat(t.v[1]) * last,
    bid: parseFloat(t.b[0]), ask: parseFloat(t.a[0]),
  };
}

async function fetchKrakenOHLC(interval = 15) {
  const { data } = await axios.get("https://api.kraken.com/0/public/OHLC", { params: { pair: "XBTUSD", interval }, timeout: 8000 });
  return (data.result?.XXBTZUSD || []).slice(-120).map(c => ({
    time: c[0], open: parseFloat(c[1]), high: parseFloat(c[2]),
    low: parseFloat(c[3]), close: parseFloat(c[4]), volume: parseFloat(c[6]),
  }));
}

export async function fetchOrderBook(depth = 100) {
  try {
    const { data } = await axios.get("https://api.kraken.com/0/public/Depth", { params: { pair: "XBTUSD", count: depth }, timeout: 6000 });
    const book = data.result?.XXBTZUSD;
    if (!book) return null;
    return {
      bids: book.bids.map(b => ({ price: parseFloat(b[0]), size: parseFloat(b[1]) })),
      asks: book.asks.map(a => ({ price: parseFloat(a[0]), size: parseFloat(a[1]) })),
    };
  } catch { return null; }
}

export function detectWalls(book, price) {
  if (!book) return { wallBias: 0, wallStrength: 0, bullWall: null, bearWall: null };
  const bucket = price * 0.001;
  const bBuckets = {}, aBuckets = {};
  for (const b of book.bids) { const k = Math.floor(b.price / bucket) * bucket; bBuckets[k] = (bBuckets[k] || 0) + b.size * b.price; }
  for (const a of book.asks) { const k = Math.floor(a.price / bucket) * bucket; aBuckets[k] = (aBuckets[k] || 0) + a.size * a.price; }
  const topBid = Object.entries(bBuckets).sort((a, b) => b[1] - a[1])[0];
  const topAsk = Object.entries(aBuckets).sort((a, b) => b[1] - a[1])[0];
  const bullWall = topBid ? { price: parseFloat(topBid[0]), sizeUSD: topBid[1] } : null;
  const bearWall = topAsk ? { price: parseFloat(topAsk[0]), sizeUSD: topAsk[1] } : null;
  const totalBids = book.bids.reduce((s, b) => s + b.size * b.price, 0);
  const totalAsks = book.asks.reduce((s, a) => s + a.size * a.price, 0);
  const depthRatio = (totalBids - totalAsks) / (totalBids + totalAsks);
  let wallBias = depthRatio * 0.5;
  if (bullWall && (price - bullWall.price) / price < 0.005) wallBias += 0.35;
  if (bearWall && (bearWall.price - price) / price < 0.005) wallBias -= 0.35;
  return {
    wallBias: Math.max(-1, Math.min(1, wallBias)),
    wallStrength: Math.min(1, Math.max(totalBids, totalAsks) / 5_000_000),
    bullWall, bearWall, depthRatio,
    bullProximity: bullWall ? (price - bullWall.price) / price : 1,
    bearProximity: bearWall ? (bearWall.price - price) / price : 1,
  };
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  let ag = 0, al = 0;
  for (let i = 1; i <= period; i++) { const d = closes[i] - closes[i-1]; if (d > 0) ag += d; else al -= d; }
  ag /= period; al /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i-1];
    ag = (ag * (period-1) + Math.max(d,0)) / period;
    al = (al * (period-1) + Math.max(-d,0)) / period;
  }
  return al === 0 ? 100 : 100 - 100 / (1 + ag / al);
}

function calcEMA(closes, period) {
  if (closes.length < period) return closes[closes.length - 1];
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
  return ema;
}

function calcATR(candles, period = 14) {
  const trs = candles.slice(1).map((c, i) => Math.max(c.high - c.low, Math.abs(c.high - candles[i].close), Math.abs(c.low - candles[i].close)));
  return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function calcVWAP(candles) {
  let n = 0, d = 0;
  for (const c of candles) { const t = (c.high + c.low + c.close) / 3; n += t * c.volume; d += c.volume; }
  return d > 0 ? n / d : candles[candles.length-1].close;
}

function calcBollinger(closes, period = 20) {
  if (closes.length < period) return null;
  const sl = closes.slice(-period);
  const mean = sl.reduce((a, b) => a + b) / period;
  const sd = Math.sqrt(sl.reduce((s, v) => s + (v - mean) ** 2, 0) / period);
  return { upper: mean + 2*sd, mid: mean, lower: mean - 2*sd, pct: (closes[closes.length-1] - (mean - 2*sd)) / (4*sd) };
}

function calcMACD(closes) {
  const e12 = calcEMA(closes, 12), e26 = calcEMA(closes, 26);
  return { line: e12 - e26, signal: calcEMA(closes.slice(-35).map((_, i, a) => calcEMA(closes.slice(0, closes.length-35+i+1), 12) - calcEMA(closes.slice(0, closes.length-35+i+1), 26)), 9) };
}

export async function computeSignals() {
  const [candlesR, statsR, clR] = await Promise.allSettled([fetchKrakenOHLC(15), fetch24hStats(), fetchChainlinkPrice()]);
  if (candlesR.status === "rejected") throw new Error("Candles: " + candlesR.reason?.message);
  if (statsR.status === "rejected") throw new Error("Stats: " + statsR.reason?.message);

  const candles = candlesR.value;
  const stats = statsR.value;
  const closes = candles.map(c => c.close);
  const price = closes[closes.length - 1];
  const oraclePrice = clR.status === "fulfilled" && clR.value > 1000 ? clR.value : price;

  const rsi = calcRSI(closes);
  const ema9 = calcEMA(closes, 9);
  const ema21 = calcEMA(closes, 21);
  const ema50 = calcEMA(closes, 50);
  const atr = calcATR(candles);
  const vwap = calcVWAP(candles.slice(-48));
  const bb = calcBollinger(closes);
  const macd = calcMACD(closes);
  const mom5 = (price - closes[closes.length-6]) / closes[closes.length-6];
  const mom15 = (price - closes[closes.length-16]) / closes[closes.length-16];

  const rsiScore = rsi < 25 ? 1 : rsi < 35 ? 0.7 : rsi < 45 ? 0.3 : rsi > 75 ? -1 : rsi > 65 ? -0.7 : rsi > 55 ? -0.3 : (50 - rsi) / 50;
  const emaScore = (ema9 > ema21 && ema21 > ema50) ? 0.85 : (ema9 < ema21 && ema21 < ema50) ? -0.85 : Math.max(-0.5, Math.min(0.5, ((ema9 - ema21) / ema21) * 80));
  const momentumScore = Math.max(-1, Math.min(1, mom5 * 40 + mom15 * 20));
  const vwapScore = Math.max(-1, Math.min(1, (price - vwap) / atr * 0.8));
  const bbScore = bb ? (bb.pct < 0.1 ? 0.8 : bb.pct > 0.9 ? -0.8 : (0.5 - bb.pct) * 1.2) : 0;
  const macdScore = Math.max(-1, Math.min(1, (macd.line - macd.signal) / atr * 2));
  const trendScore = Math.max(-1, Math.min(1, stats.priceChangePercent / 4));

  const W = { rsi: 0.18, ema: 0.22, momentum: 0.14, vwap: 0.15, bb: 0.12, macd: 0.12, trend: 0.07 };
  const bias = rsiScore*W.rsi + emaScore*W.ema + momentumScore*W.momentum + vwapScore*W.vwap + bbScore*W.bb + macdScore*W.macd + trendScore*W.trend;

  const scores = [rsiScore, emaScore, momentumScore, vwapScore, bbScore, macdScore];
  const bull = scores.filter(s => s > 0.1).length;
  const bear = scores.filter(s => s < -0.1).length;
  const alignment = Math.max(bull, bear) / scores.length;
  const confidence = Math.min(0.92, alignment * (scores.map(Math.abs).reduce((a,b)=>a+b)/scores.length));

  return {
    bias: Math.max(-1, Math.min(1, bias)), confidence,
    rsi, ema9, ema21, ema50, atr, vwap, bb, macd,
    currentPrice: price, oraclePrice,
    momentum5: mom5, momentum15: mom15, stats,
    components: { rsiScore, emaScore, momentumScore, vwapScore, bbScore, macdScore, trendScore },
  };
}
