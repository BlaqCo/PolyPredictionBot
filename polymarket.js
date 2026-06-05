import axios from "axios";

const DRY_RUN = process.env.DRY_RUN !== "false";
const BTC_KEYWORDS = ["bitcoin", "btc", "will btc", "will bitcoin", "bitcoin above", "bitcoin below", "btc above", "btc below"];

export async function fetchBTCMarkets() {
  try {
    const { data } = await axios.get("https://clob.polymarket.com/markets", { params: { active: true, closed: false } });
    const markets = (data?.data || data || []).filter(m => {
      const q = (m.question || m.title || "").toLowerCase();
      return BTC_KEYWORDS.some(kw => q.includes(kw));
    });
    console.log(`📊 Found ${markets.length} BTC markets`);
    return markets.length > 0 ? markets : getMockMarkets();
  } catch (err) {
    console.log("⚠️  Market fetch failed, using mock data:", err.message);
    return getMockMarkets();
  }
}

export async function placeOrder({ tokenId, side, size, price, marketQuestion }) {
  const log = { mode: DRY_RUN ? "DRY_RUN" : "LIVE", tokenId, side, size, price, marketQuestion, timestamp: new Date().toISOString() };
  if (DRY_RUN) {
    console.log("🧪 DRY RUN order:", JSON.stringify(log));
    return { ...log, orderId: `dry_${Date.now()}`, status: "simulated" };
  }
  throw new Error("Live trading not yet implemented — set DRY_RUN=true");
}

export async function getBalance() {
  return parseFloat(process.env.BANKROLL || "100");
}

function getMockMarkets() {
  const tomorrow = new Date(Date.now() + 86400000).toISOString();
  const nextWeek = new Date(Date.now() + 7 * 86400000).toISOString();
  return [
    { conditionId: "mock_001", question: "Will BTC be above $95,000 by end of day?", active: true, endDateIso: tomorrow, tokens: [{ tokenId: "mock_yes_001", outcome: "Yes", price: 0.52 }, { tokenId: "mock_no_001", outcome: "No", price: 0.48 }] },
    { conditionId: "mock_002", question: "Will BTC reach $100,000 this week?", active: true, endDateIso: nextWeek, tokens: [{ tokenId: "mock_yes_002", outcome: "Yes", price: 0.31 }, { tokenId: "mock_no_002", outcome: "No", price: 0.69 }] },
    { conditionId: "mock_003", question: "Will BTC be higher than today's open at close?", active: true, endDateIso: tomorrow, tokens: [{ tokenId: "mock_yes_003", outcome: "Yes", price: 0.58 }, { tokenId: "mock_no_003", outcome: "No", price: 0.42 }] },
  ];
}
