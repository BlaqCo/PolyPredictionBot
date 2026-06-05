const state = { bets: [], pnl: 0, totalWagered: 0, wins: 0, losses: 0, scansCompleted: 0, startedAt: new Date().toISOString(), lastScan: null, activeBets: new Map() };

export function recordBet({ market, side, betSize, edge, trueProbability, impliedProbability, orderId }) {
  const bet = { id: `bet_${Date.now()}`, orderId, marketConditionId: market.conditionId, marketQuestion: market.question, side, betSize, edge, trueProbability, impliedProbability, placedAt: new Date().toISOString(), status: "open" };
  state.bets.push(bet);
  state.totalWagered += betSize;
  state.activeBets.set(market.conditionId, bet);
  return bet;
}

export function hasActiveBet(conditionId) { return state.activeBets.has(conditionId); }

export function recordScan() { state.scansCompleted++; state.lastScan = new Date().toISOString(); }

export function getStats() {
  const total = state.wins + state.losses;
  return { uptime: state.startedAt, lastScan: state.lastScan, scansCompleted: state.scansCompleted, betsPlaced: state.bets.length, activeBets: state.activeBets.size, totalWagered: state.totalWagered.toFixed(2), pnl: state.pnl.toFixed(2), wins: state.wins, losses: state.losses, winRate: total > 0 ? ((state.wins / total) * 100).toFixed(1) + "%" : "N/A" };
}

export function getAllBets() { return state.bets; }
