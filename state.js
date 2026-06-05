/**
 * state.js
 * Tracks bets, P&L, and open positions for scalp exit monitoring
 */

const state = {
  bets: [],
  pnl: 0,
  totalWagered: 0,
  wins: 0,
  losses: 0,
  scalps: 0,          // exits via take-profit (not waiting for resolution)
  scansCompleted: 0,
  startedAt: new Date().toISOString(),
  lastScan: null,
  activeBets: new Map(), // conditionId → bet
};

export function recordBet({ market, side, betSize, edge, trueProbability, impliedProbability, orderId, entryPrice }) {
  const bet = {
    id: `bet_${Date.now()}`,
    orderId,
    marketConditionId: market.conditionId || market.condition_id,
    marketQuestion: market.question,
    side,
    betSize,
    edge,
    trueProbability,
    impliedProbability,
    entryPrice: entryPrice || impliedProbability, // price we paid (0.0–1.0)
    placedAt: new Date().toISOString(),
    status: "open",
    pnl: null,
    exitReason: null,
  };
  state.bets.push(bet);
  state.totalWagered += betSize;
  state.activeBets.set(bet.marketConditionId, bet);
  return bet;
}

export function closeBet(conditionId, { exitPrice, reason, pnl }) {
  const bet = state.activeBets.get(conditionId);
  if (!bet) return null;

  bet.exitPrice = exitPrice;
  bet.exitReason = reason; // 'take_profit' | 'stop_loss' | 'resolution'
  bet.pnl = pnl;
  bet.closedAt = new Date().toISOString();

  if (pnl > 0) { state.wins++; bet.status = 'won'; }
  else { state.losses++; bet.status = 'lost'; }

  if (reason === 'take_profit') state.scalps++;

  state.pnl += pnl;
  state.activeBets.delete(conditionId);
  return bet;
}

export function hasActiveBet(conditionId) { return state.activeBets.has(conditionId); }
export function getActiveBet(conditionId) { return state.activeBets.get(conditionId); }
export function getAllActiveBets() { return Array.from(state.activeBets.values()); }

export function recordScan() {
  state.scansCompleted++;
  state.lastScan = new Date().toISOString();
}

export function getStats() {
  const total = state.wins + state.losses;
  return {
    uptime: state.startedAt,
    lastScan: state.lastScan,
    scansCompleted: state.scansCompleted,
    betsPlaced: state.bets.length,
    activeBets: state.activeBets.size,
    totalWagered: state.totalWagered.toFixed(2),
    pnl: state.pnl.toFixed(2),
    wins: state.wins,
    losses: state.losses,
    scalps: state.scalps,
    winRate: total > 0 ? ((state.wins / total) * 100).toFixed(1) + "%" : "N/A",
    recentBets: state.bets.slice(-10).reverse(),
  };
}

export function getAllBets() { return state.bets; }
