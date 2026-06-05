/**
 * signals.js — PolyBettor Scalp Signal Engine
 *
 * 3 strategies tuned for HIGH FREQUENCY scalping:
 *
 * A) TREND_SCALP  — EMA stack alignment + RSI pullback/rejection
 *                   Fires on BOTH uptrends and downtrends
 *                   Best when: clear directional trend, RSI between 35-65
 *
 * B) MOMENTUM    — Price velocity + volume surge detection
 *                   Fires when price is accelerating in one direction
 *                   Best when: breakout or sharp move beginning
 *
 * C) MEAN_REVERT — RSI extremes + Bollinger Band squeeze
 *                   Fires when market is oversold/overbought
 *                   Best when: ranging, after a spike
 *
 * Auto mode selects based on current volatility + trend strength
 */

import axios from "axios";

// ── Price Sources ─────────────────────────────────────────────
const CHAINLINK_RPC = "https://polygon-rpc.com";
const CHAINLINK_BTC = "0xc907E116054Ad103354f2D350FD2514433D57F6F";

async function fetchChainlink() {
  const { data } = await axios.post(CHAINLINK_RPC, {
    jsonrpc:"2.0", id:1, method:"eth_call",
    params:[{ to:CHAINLINK_BTC, data:"0xfeaf968c" }, "latest"],
  }, { timeout:5000 });
  if (!data.result || data.result==="0x") throw new Error("Empty");
  return Number(BigInt("0x"+data.result.slice(66,130))) / 1e8;
}

async function fetchKrakenTicker() {
  const { data } = await axios.get("https://api.kraken.com/0/public/Ticker",
    { params:{ pair:"XBTUSD" }, timeout:6000 });
  const t = data.result?.XXBTZUSD;
  if (!t) throw new Error("No ticker");
  const last = parseFloat(t.c[0]);
  return {
    price: last,
    bid: parseFloat(t.b[0]),
    ask: parseFloat(t.a[0]),
    high: parseFloat(t.h[1]),
    low: parseFloat(t.l[1]),
    volume: parseFloat(t.v[1]),
    priceChangePercent: ((last - parseFloat(t.o)) / parseFloat(t.o)) * 100,
    open: parseFloat(t.o),
  };
}

async function fetchKrakenOHLC(interval=15) {
  const { data } = await axios.get("https://api.kraken.com/0/public/OHLC",
    { params:{ pair:"XBTUSD", interval }, timeout:8000 });
  return (data.result?.XXBTZUSD||[]).slice(-120).map(c => ({
    time:c[0], open:parseFloat(c[1]), high:parseFloat(c[2]),
    low:parseFloat(c[3]), close:parseFloat(c[4]), volume:parseFloat(c[6]),
  }));
}

export async function fetchOrderBook(depth=100) {
  try {
    const { data } = await axios.get("https://api.kraken.com/0/public/Depth",
      { params:{ pair:"XBTUSD", count:depth }, timeout:6000 });
    const b = data.result?.XXBTZUSD;
    if (!b) return null;
    return {
      bids: b.bids.map(x => ({ price:parseFloat(x[0]), size:parseFloat(x[1]) })),
      asks: b.asks.map(x => ({ price:parseFloat(x[0]), size:parseFloat(x[1]) })),
    };
  } catch { return null; }
}

export async function fetchCurrentPrice() {
  try { const p = await fetchChainlink(); if (p>1000) return p; } catch {}
  return (await fetchKrakenTicker()).price;
}

export async function fetch24hStats() { return fetchKrakenTicker(); }

// ── Indicators ────────────────────────────────────────────────

function calcRSI(closes, period=14) {
  if (closes.length < period+1) return 50;
  let ag=0, al=0;
  for (let i=1; i<=period; i++) { const d=closes[i]-closes[i-1]; if(d>0)ag+=d; else al-=d; }
  ag/=period; al/=period;
  for (let i=period+1; i<closes.length; i++) {
    const d=closes[i]-closes[i-1];
    ag=(ag*(period-1)+Math.max(d,0))/period;
    al=(al*(period-1)+Math.max(-d,0))/period;
  }
  return al===0 ? 100 : 100-100/(1+ag/al);
}

function calcEMA(closes, period) {
  if (closes.length<period) return closes[closes.length-1];
  const k=2/(period+1);
  let ema=closes.slice(0,period).reduce((a,b)=>a+b)/period;
  for (let i=period; i<closes.length; i++) ema=closes[i]*k+ema*(1-k);
  return ema;
}

function calcATR(candles, period=14) {
  const trs=candles.slice(1).map((c,i)=>Math.max(
    c.high-c.low, Math.abs(c.high-candles[i].close), Math.abs(c.low-candles[i].close)
  ));
  return trs.slice(-period).reduce((a,b)=>a+b)/period;
}

function calcBollinger(closes, period=20) {
  if (closes.length<period) return null;
  const sl=closes.slice(-period);
  const mean=sl.reduce((a,b)=>a+b)/period;
  const sd=Math.sqrt(sl.reduce((s,v)=>s+(v-mean)**2,0)/period);
  const price=closes[closes.length-1];
  return {
    upper:mean+2*sd, mid:mean, lower:mean-2*sd,
    pct:(price-(mean-2*sd))/(4*sd), // 0=at lower band, 1=at upper band
    width:(4*sd)/mean, // band width as % of price
  };
}

// ── Strategy A: TREND_SCALP ───────────────────────────────────
// Identifies trend direction via EMA stack, then times entry
// on RSI pullback (uptrend) or RSI bounce rejection (downtrend)

export function strategyTrendScalp(closes, candles) {
  const price  = closes[closes.length-1];
  const ema9   = calcEMA(closes, 9);
  const ema21  = calcEMA(closes, 21);
  const ema50  = calcEMA(closes, 50);
  const rsi    = calcRSI(closes);
  const rsi5   = calcRSI(closes, 5); // short RSI for timing
  const atr    = calcATR(candles);

  // Trend strength: distance of EMAs from each other relative to ATR
  const emaBullStack = ema9 > ema21 && ema21 > ema50;
  const emaBearStack = ema9 < ema21 && ema21 < ema50;
  const trendStrength = Math.abs(ema9 - ema50) / atr; // >1 = strong trend

  let bias = 0, confidence = 0, signal = "none";

  if (emaBullStack && trendStrength > 0.3) {
    // UPTREND — look for RSI pullback to 40-55 range then bouncing
    if (rsi >= 35 && rsi <= 55 && rsi5 > rsi) {
      // RSI pulling back but short-term RSI already recovering = entry
      const strength = Math.min(1, (55-rsi)/20 + trendStrength*0.3);
      bias = 0.5 + strength * 0.45;
      confidence = Math.min(0.88, 0.45 + strength*0.4 + trendStrength*0.1);
      signal = `uptrend_pullback RSI:${rsi.toFixed(0)} strength:${trendStrength.toFixed(1)}`;
    } else if (rsi > 55 && rsi < 70) {
      // Strong uptrend momentum
      bias = 0.4 + Math.min(0.3, trendStrength*0.15);
      confidence = Math.min(0.75, 0.35 + trendStrength*0.12);
      signal = `uptrend_momentum RSI:${rsi.toFixed(0)}`;
    }
  } else if (emaBearStack && trendStrength > 0.3) {
    // DOWNTREND — look for RSI bounce to 45-65 then rejecting
    if (rsi >= 45 && rsi <= 65 && rsi5 < rsi) {
      // RSI bounced but short-term already turning down = short entry
      const strength = Math.min(1, (rsi-45)/20 + trendStrength*0.3);
      bias = -(0.5 + strength * 0.45);
      confidence = Math.min(0.88, 0.45 + strength*0.4 + trendStrength*0.1);
      signal = `downtrend_rejection RSI:${rsi.toFixed(0)} strength:${trendStrength.toFixed(1)}`;
    } else if (rsi < 45 && rsi > 30) {
      // Strong downtrend momentum
      bias = -(0.4 + Math.min(0.3, trendStrength*0.15));
      confidence = Math.min(0.75, 0.35 + trendStrength*0.12);
      signal = `downtrend_momentum RSI:${rsi.toFixed(0)}`;
    }
  } else {
    // No clear trend — weak signal from RSI alone
    if (rsi < 35) { bias = 0.25; confidence = 0.20; signal = `rsi_oversold:${rsi.toFixed(0)}`; }
    else if (rsi > 65) { bias = -0.25; confidence = 0.20; signal = `rsi_overbought:${rsi.toFixed(0)}`; }
  }

  return {
    name: "TREND_SCALP",
    bias: Math.max(-1, Math.min(1, bias)),
    confidence,
    rsi, rsi5, ema9, ema21, ema50,
    emaBullStack, emaBearStack, trendStrength,
    components: { rsi, ema9, ema21, ema50, trendStrength },
    meta: signal || `no_trend EMA9${ema9>ema21?'>':'<'}EMA21 RSI:${rsi.toFixed(0)} ts:${trendStrength.toFixed(2)}`,
  };
}

// ── Strategy B: MOMENTUM ──────────────────────────────────────
// Detects price acceleration + volume surge
// Fires early on moves, exits fast — highest frequency

export function strategyMomentum(candles, ticker) {
  const closes = candles.map(c=>c.close);
  const price  = closes[closes.length-1];
  const atr    = calcATR(candles);

  // Price velocity: rate of change over multiple windows
  const roc1  = (closes[closes.length-1] - closes[closes.length-2]) / closes[closes.length-2];
  const roc3  = (closes[closes.length-1] - closes[closes.length-4]) / closes[closes.length-4];
  const roc6  = (closes[closes.length-1] - closes[closes.length-7]) / closes[closes.length-7];

  // Acceleration: is momentum speeding up?
  const accel = roc1 - (roc3/3); // positive = accelerating

  // Volume analysis
  const avgVol  = candles.slice(-20,-1).reduce((s,c)=>s+c.volume,0)/19;
  const lastVol = candles[candles.length-1].volume;
  const volSurge = avgVol>0 ? lastVol/avgVol : 1;

  // Consecutive candles in same direction
  let streak = 0;
  for (let i=candles.length-1; i>candles.length-6; i--) {
    if (candles[i].close > candles[i-1].close) { if (streak>=0) streak++; else break; }
    else { if (streak<=0) streak--; else break; }
  }

  // Signal strength
  const rocScore = Math.max(-1, Math.min(1, roc3*80 + roc1*40));
  const volBoost = Math.min(0.35, (volSurge-1)*0.15);
  const streakBoost = Math.min(0.25, Math.abs(streak)*0.08);
  const accelBoost = Math.min(0.20, Math.abs(accel)*30);

  const rawBias = rocScore;
  const conf = Math.min(0.92,
    Math.abs(rawBias)*0.5 + volBoost + streakBoost + accelBoost
  );

  return {
    name: "MOMENTUM",
    bias: Math.max(-1, Math.min(1, rawBias)),
    confidence: rawBias === 0 ? 0 : conf,
    volSurge, streak, roc1, roc3, roc6, accel,
    components: { roc3, volSurge, streak, accel },
    meta: `roc3:${(roc3*100).toFixed(2)}% vol:${volSurge.toFixed(1)}x streak:${streak} accel:${accel>0?'+':''}${(accel*1000).toFixed(1)}`,
  };
}

// ── Strategy C: MEAN_REVERT ───────────────────────────────────
// RSI extremes + Bollinger band compression/expansion
// Fades overextended moves — high win rate, smaller gains

export function strategyMeanRevert(closes, candles) {
  const price = closes[closes.length-1];
  const rsi   = calcRSI(closes);
  const bb    = calcBollinger(closes);
  const atr   = calcATR(candles);

  if (!bb) return { name:"MEAN_REVERT", bias:0, confidence:0, meta:"insufficient data", components:{} };

  // Price position within bands (0=lower, 0.5=mid, 1=upper)
  const bbPct = bb.pct;

  // Band squeeze: narrow bands = coiling for a move
  const avgWidth = 0.04; // typical band width
  const squeeze = bb.width < avgWidth * 0.7;

  let bias = 0, confidence = 0, signal = "";

  if (rsi < 30 && bbPct < 0.15) {
    // Deeply oversold + at lower band = strong buy
    bias = 0.75 + (30-rsi)/100;
    confidence = Math.min(0.90, 0.60 + (30-rsi)*0.015);
    signal = `oversold_extreme RSI:${rsi.toFixed(0)} BB:${(bbPct*100).toFixed(0)}%`;
  } else if (rsi < 40 && bbPct < 0.25) {
    // Moderately oversold at lower band
    bias = 0.45 + (40-rsi)/200;
    confidence = Math.min(0.70, 0.35 + (40-rsi)*0.01);
    signal = `oversold RSI:${rsi.toFixed(0)} BB:${(bbPct*100).toFixed(0)}%`;
  } else if (rsi > 70 && bbPct > 0.85) {
    // Deeply overbought + at upper band = strong sell
    bias = -(0.75 + (rsi-70)/100);
    confidence = Math.min(0.90, 0.60 + (rsi-70)*0.015);
    signal = `overbought_extreme RSI:${rsi.toFixed(0)} BB:${(bbPct*100).toFixed(0)}%`;
  } else if (rsi > 60 && bbPct > 0.75) {
    // Moderately overbought at upper band
    bias = -(0.45 + (rsi-60)/200);
    confidence = Math.min(0.70, 0.35 + (rsi-60)*0.01);
    signal = `overbought RSI:${rsi.toFixed(0)} BB:${(bbPct*100).toFixed(0)}%`;
  }

  // Squeeze increases confidence (coiled spring)
  if (squeeze && Math.abs(bias) > 0) confidence = Math.min(0.92, confidence + 0.08);

  return {
    name: "MEAN_REVERT",
    bias: Math.max(-1, Math.min(1, bias)),
    confidence,
    rsi, bb, squeeze,
    components: { rsi, bbPct, squeeze, bbWidth:bb.width },
    meta: signal || `neutral RSI:${rsi.toFixed(0)} BB:${(bbPct*100).toFixed(0)}% squeeze:${squeeze}`,
  };
}

// ── Wall Detection (utility) ──────────────────────────────────
export function detectWalls(book, price) {
  if (!book) return { wallBias:0, wallStrength:0, bullWall:null, bearWall:null };
  const bucket=price*0.001;
  const bB={}, aB={};
  for (const b of book.bids){ const k=Math.floor(b.price/bucket)*bucket; bB[k]=(bB[k]||0)+b.size*b.price; }
  for (const a of book.asks){ const k=Math.floor(a.price/bucket)*bucket; aB[k]=(aB[k]||0)+a.size*a.price; }
  const topBid=Object.entries(bB).sort((a,b)=>b[1]-a[1])[0];
  const topAsk=Object.entries(aB).sort((a,b)=>b[1]-a[1])[0];
  const bullWall=topBid?{ price:parseFloat(topBid[0]), usd:topBid[1] }:null;
  const bearWall=topAsk?{ price:parseFloat(topAsk[0]), usd:topAsk[1] }:null;
  const totalBids=book.bids.reduce((s,b)=>s+b.size*b.price,0);
  const totalAsks=book.asks.reduce((s,a)=>s+a.size*a.price,0);
  const depthRatio=(totalBids-totalAsks)/(totalBids+totalAsks);
  let wallBias=depthRatio*0.4;
  if (bullWall&&(price-bullWall.price)/price<0.004) wallBias+=0.3;
  if (bearWall&&(bearWall.price-price)/price<0.004) wallBias-=0.3;
  return {
    wallBias:Math.max(-1,Math.min(1,wallBias)),
    wallStrength:Math.min(1,Math.max(totalBids,totalAsks)/5_000_000),
    bullWall, bearWall, depthRatio,
  };
}

// ── Auto Strategy Selector ────────────────────────────────────
export function autoSelectStrategy(A, B, C, ticker) {
  const vol = Math.abs(ticker.priceChangePercent);

  // Strong trend → TREND_SCALP
  if (A.trendStrength > 0.8 && A.confidence > 0.40) return "TREND_SCALP";

  // High momentum / volume surge → MOMENTUM
  if (B.volSurge > 1.5 && B.confidence > 0.35) return "MOMENTUM";
  if (Math.abs(B.roc3||0) > 0.003 && B.confidence > 0.30) return "MOMENTUM";

  // Extreme RSI → MEAN_REVERT
  if ((C.rsi < 35 || C.rsi > 65) && C.confidence > 0.35) return "MEAN_REVERT";

  // Default: pick highest confidence
  const ranked = [A, B, C].sort((x,y) => y.confidence - x.confidence);
  return ranked[0].confidence > 0.20 ? ranked[0].name : "TREND_SCALP";
}

// ── Main ──────────────────────────────────────────────────────
export async function computeSignals(activeStrategies={TREND_SCALP:true,MOMENTUM:true,MEAN_REVERT:true}, autoMode=true) {
  const [candlesR, tickerR, clR, bookR] = await Promise.allSettled([
    fetchKrakenOHLC(15),
    fetchKrakenTicker(),
    fetchChainlink(),
    fetchOrderBook(100),
  ]);

  if (candlesR.status==="rejected") throw new Error("Candles: "+candlesR.reason?.message);
  if (tickerR.status==="rejected") throw new Error("Ticker: "+tickerR.reason?.message);

  const candles = candlesR.value;
  const ticker  = tickerR.value;
  const closes  = candles.map(c=>c.close);
  const price   = closes[closes.length-1];
  const atr     = calcATR(candles);
  const oracle  = clR.status==="fulfilled"&&clR.value>1000 ? clR.value : null;
  const book    = bookR.status==="fulfilled" ? bookR.value : null;

  // Run all 3 strategies
  const A = strategyTrendScalp(closes, candles);
  const B = strategyMomentum(candles, ticker);
  const C = strategyMeanRevert(closes, candles);
  const walls = detectWalls(book, price);

  // Pick active strategy
  let activeStrat = "TREND_SCALP";
  if (autoMode) {
    activeStrat = autoSelectStrategy(A, B, C, ticker);
  } else {
    const enabled = [
      activeStrategies.TREND_SCALP ? A : null,
      activeStrategies.MOMENTUM    ? B : null,
      activeStrategies.MEAN_REVERT ? C : null,
    ].filter(Boolean);
    if (enabled.length > 0) {
      activeStrat = enabled.reduce((best,s) => s.confidence>best.confidence?s:best, enabled[0]).name;
    }
  }

  const map = { TREND_SCALP:A, MOMENTUM:B, MEAN_REVERT:C };
  const lead = map[activeStrat] || A;

  // Blend wall signal as light confirmation (15%)
  let finalBias = lead.bias;
  if (walls.wallStrength > 0.3) {
    finalBias = finalBias * 0.85 + walls.wallBias * 0.15;
  }

  // Secondary confirmation: if another enabled strategy agrees, small boost
  const others = [A,B,C].filter(s=>s.name!==activeStrat&&s.confidence>0.25);
  for (const o of others) {
    if (Math.sign(o.bias)===Math.sign(finalBias)) {
      finalBias = finalBias * 0.92 + o.bias * 0.08;
    }
  }

  return {
    bias: Math.max(-1, Math.min(1, finalBias)),
    confidence: lead.confidence,
    currentPrice: price,
    oraclePrice: oracle,
    stats: { ...ticker, quoteVolume: ticker.volume*price },
    atr,
    rsi: A.rsi,
    ema9: A.ema9,
    ema21: A.ema21,
    ema50: A.ema50,
    walls,
    activeStrategy: activeStrat,
    autoMode,
    strategies: { A, B, C },
    components: lead.components,
    leadMeta: lead.meta,
  };
}
