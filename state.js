/**
 * state.js — In-memory state manager
 *
 * Tracks bets placed, P&L, and prevents duplicate bets.
 * In Railway, this resets on redeploy — wire to a DB for persistence.
 */

const state = {
  bets: [],           // all bets placed this session
  pnl: 0,            // running P&L in USDC
  totalWagered: 0,   // total USDC wagered
  wins: 0,
  losses: 0,
  scansCompleted: 0,
  startedAt: new Date().toISOString(),
  lastScan: null,
  activeBetsByMarket: new Map(), // conditionId → bet
};

export function recordBet({ market, side, betSize, edge, trueProbability, impliedProbability, orderId }) {
  const bet = {
    id: `bet_${Date.now()}`,
    orderId,
    marketConditionId: market.conditionId,
    marketQuestion: market.question,
    side,
    betSize,
    edge,
    trueProbability,
    impliedProbability,
    placedAt: new Date().toISOString(),
    status: "open",
    pnl: null,
  };

  state.bets.push(bet);
  state.totalWagered += betSize;
  state.activeBetsByMarket.set(market.conditionId, bet);

  return bet;
}

export function settleBet(conditionId, outcome) {
  const bet = state.activeBetsByMarket.get(conditionId);
  if (!bet) return;

  const won = bet.side.toUpperCase() === outcome.toUpperCase();
  const pnl = won
    ? betSize * (1 / bet.impliedProbability - 1)  // profit
    : -bet.betSize;                                 // loss

  bet.status = won ? "won" : "lost";
  bet.pnl = pnl;
  state.pnl += pnl;

  if (won) state.wins++;
  else state.losses++;

  state.activeBetsByMarket.delete(conditionId);
  return bet;
}

export function hasActiveBet(conditionId) {
  return state.activeBetsByMarket.has(conditionId);
}

export function recordScan() {
  state.scansCompleted++;
  state.lastScan = new Date().toISOString();
}

export function getStats() {
  const totalBets = state.wins + state.losses;
  return {
    uptime: state.startedAt,
    lastScan: state.lastScan,
    scansCompleted: state.scansCompleted,
    betsPlaced: state.bets.length,
    activeBets: state.activeBetsByMarket.size,
    totalWagered: state.totalWagered.toFixed(2),
    pnl: state.pnl.toFixed(2),
    wins: state.wins,
    losses: state.losses,
    winRate: totalBets > 0 ? ((state.wins / totalBets) * 100).toFixed(1) + "%" : "N/A",
    recentBets: state.bets.slice(-10).reverse(),
  };
}

export function getAllBets() {
  return state.bets;
}
