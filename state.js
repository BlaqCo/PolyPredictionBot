/**
 * state.js — PolyBettor state tracker
 *
 * Win/Loss/Breakeven classification:
 *   win      = pnl > 0 (made money)
 *   loss     = pnl < -0.01 (genuinely lost money)
 *   breakeven= pnl between -0.01 and 0 (near_expiry exits at ~entry price)
 *
 * The old bug: any pnl <= 0 counted as a loss.
 * Near_expiry exits at exactly entry price = $0 pnl = counted as "loss".
 * That inflated losses to 241 while the bot was actually in profit.
 */

const STARTING_BALANCE = parseFloat(process.env.BANKROLL || "40");
const IS_DRY = process.env.DRY_RUN !== "false";

const state = {
  bets: [],
  pnl: 0,
  totalWagered: 0,
  wins: 0,
  losses: 0,
  breakevens: 0,
  scalps: 0,
  scansCompleted: 0,
  startedAt: new Date().toISOString(),
  lastScan: null,
  activeBets: new Map(),
  dryBalance: STARTING_BALANCE,
};

console.log(`💰 State initialized | Starting balance: $${STARTING_BALANCE} | Mode: ${IS_DRY ? "DRY RUN" : "LIVE"}`);

export function recordBet({ market, side, betSize, edge, trueProbability,
  impliedProbability, orderId, entryPrice, strategy, reasoning, entryBtcPrice }) {
  const bet = {
    id: `bet_${Date.now()}_${Math.random().toString(36).slice(2,6)}`,
    orderId,
    marketConditionId: market.conditionId || market.condition_id,
    marketQuestion: market.question,
    marketEndDateIso: market.endDateIso || market.end_date_iso,
    side,
    betSize,
    edge,
    trueProbability,
    impliedProbability,
    entryPrice: entryPrice || impliedProbability,
    entryBtcPrice,   // CRITICAL: locked at entry for cumulative delta math
    strategy: strategy || "UNKNOWN",
    reasoning: reasoning || "",
    placedAt: new Date().toISOString(),
    status: "open",
    pnl: null,
    exitReason: null,
    exitPrice: null,
  };

  state.bets.push(bet);
  state.totalWagered += betSize;
  state.dryBalance -= betSize;
  state.activeBets.set(bet.marketConditionId, bet);
  return bet;
}

export function closeBet(conditionId, { exitPrice, reason, pnl }) {
  const bet = state.activeBets.get(conditionId);
  if (!bet) return null;

  bet.exitPrice = exitPrice;
  bet.exitReason = reason;
  bet.pnl = pnl;
  bet.closedAt = new Date().toISOString();

  const isExpiry = reason === "expiry";

  if (isExpiry) {
    // Expired bets: full stake refund, excluded from P&L and W/L
    // Synthetic markets regenerate every 5min — expiry = position timed out,
    // not a real win or loss. Stake returns untouched.
    bet.status = "expired";
    state.expired = (state.expired || 0) + 1;
    state.dryBalance += bet.betSize; // full refund
    // pnl recorded on the bet object for logging, but NOT added to state.pnl
  } else {
    // Real exits only: TP, trail stop, stop loss
    if (pnl > 0.01) {
      state.wins++;
      bet.status = "won";
    } else if (pnl < -0.01) {
      state.losses++;
      bet.status = "lost";
    } else {
      state.breakevens++;
      bet.status = "breakeven";
    }
    if (reason === "take_profit" || reason === "trail_stop") state.scalps++;
    state.pnl += pnl;
    state.dryBalance += bet.betSize + pnl;
  }

  state.activeBets.delete(conditionId);
  return bet;
}

export function hasActiveBet(conditionId)  { return state.activeBets.has(conditionId); }
export function getActiveBet(conditionId)  { return state.activeBets.get(conditionId); }
export function getAllActiveBets()          { return Array.from(state.activeBets.values()); }
export function recordScan()               { state.scansCompleted++; state.lastScan = new Date().toISOString(); }
export function getDryBalance()            { return Math.max(0, state.dryBalance); }

export function getStats() {
  const decided = state.wins + state.losses;
  return {
    uptime: state.startedAt,
    lastScan: state.lastScan,
    scansCompleted: state.scansCompleted,
    betsPlaced: state.bets.length,
    activeBets: state.activeBets.size,
    totalWagered: state.totalWagered.toFixed(2),
    // pnl = ONLY real exits (TP, SL, trail). Expired bets excluded.
    pnl: state.pnl.toFixed(2),
    wins: state.wins,
    losses: state.losses,
    breakevens: state.breakevens,
    expired: state.expired || 0,
    scalps: state.scalps,
    // Win rate: real exits only — no expired, no breakeven
    winRate: decided > 0 ? ((state.wins / decided) * 100).toFixed(1) + "%" : "N/A",
    startingBalance: STARTING_BALANCE,
    currentBalance: Math.max(0, STARTING_BALANCE + state.pnl).toFixed(2),
    dryBalance: getDryBalance().toFixed(2),
  };
}

export function getAllBets() { return state.bets; }
