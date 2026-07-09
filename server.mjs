import express from "express";
import cors from "cors";
import Anthropic from "@anthropic-ai/sdk";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const ETHERSCAN_KEY = process.env.ETHERSCAN_API_KEY;
const ETHERSCAN_BASE = "https://api.etherscan.io/v2/api";

// Safe fetch from Etherscan V2
async function etherscanGet(params) {
  try {
    const url = new URL(ETHERSCAN_BASE);
    url.searchParams.set("chainid", "1");
    url.searchParams.set("apikey", ETHERSCAN_KEY);
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    
    const res = await axios.get(url.toString(), { timeout: 10000 });
    const data = res.data;
    
    if (data.status === "1") return data.result;
    return null;
  } catch (err) {
    console.error("Etherscan error:", err.message);
    return null;
  }
}

// Fetch wallet data from Etherscan
async function fetchWalletData(address) {
  const [balance, transactions, tokenTransfers] = await Promise.all([
    etherscanGet({ module: "account", action: "balance", address, tag: "latest" }),
    etherscanGet({ module: "account", action: "txlist", address, startblock: "0", endblock: "99999999", page: "1", offset: "5", sort: "desc" }),
    etherscanGet({ module: "account", action: "tokentx", address, page: "1", offset: "5", sort: "desc" }),
  ]);

  // ETH balance
  const ethBalance = balance ? (parseInt(balance) / 1e18).toFixed(4) : "unknown";

  // Recent transactions
  const recentTxs = Array.isArray(transactions)
    ? transactions.slice(0, 5).map(tx => ({
        hash: tx.hash ? tx.hash.slice(0, 12) + "..." : "unknown",
        from: tx.from ? tx.from.slice(0, 10) + "..." : "unknown",
        to: tx.to ? tx.to.slice(0, 10) + "..." : "unknown",
        value: (parseInt(tx.value || "0") / 1e18).toFixed(4) + " ETH",
        time: tx.timeStamp ? new Date(parseInt(tx.timeStamp) * 1000).toISOString().split("T")[0] : "unknown",
        failed: tx.isError === "1",
        method: tx.functionName ? tx.functionName.split("(")[0].slice(0, 20) : "transfer",
      }))
    : [];

  // Token transfers
  const recentTokens = Array.isArray(tokenTransfers)
    ? tokenTransfers.slice(0, 5).map(tx => ({
        token: tx.tokenSymbol || "unknown",
        from: tx.from ? tx.from.slice(0, 10) + "..." : "unknown",
        to: tx.to ? tx.to.slice(0, 10) + "..." : "unknown",
        value: tx.tokenDecimal
          ? (parseInt(tx.value || "0") / Math.pow(10, parseInt(tx.tokenDecimal))).toFixed(4)
          : "unknown",
        time: tx.timeStamp ? new Date(parseInt(tx.timeStamp) * 1000).toISOString().split("T")[0] : "unknown",
      }))
    : [];

  return {
    address,
    ethBalance,
    recentTransactions: recentTxs,
    recentTokenTransfers: recentTokens,
    dataTimestamp: new Date().toISOString().split("T")[0],
  };
}

// Analyze wallet data with Claude
async function analyzeWithClaude(walletData) {
  const prompt = `Analyze this Ethereum wallet and return a JSON risk report.

Wallet: ${walletData.address}
ETH Balance: ${walletData.ethBalance} ETH
Date: ${walletData.dataTimestamp}

Recent transactions (${walletData.recentTransactions.length}):
${JSON.stringify(walletData.recentTransactions)}

Recent token transfers (${walletData.recentTokenTransfers.length}):
${JSON.stringify(walletData.recentTokenTransfers)}

Return ONLY this JSON (no markdown, no extra text):
{
  "portfolio_snapshot": "1-2 sentence summary of wallet state",
  "activity_summary": ["activity item 1", "activity item 2"],
  "alerts": [
    {
      "event": "brief event name",
      "risk_level": "low",
      "why_it_matters": "plain English explanation",
      "recommended_action": "one safe next step"
    }
  ],
  "no_material_action_required": false,
  "uncertainty_notes": ["note 1"],
  "one_line_summary": "single line wallet status"
}

Rules:
- risk_level must be exactly: low, medium, or high
- Be concise and factual
- No investment advice
- If no activity, set no_material_action_required to true and empty alerts array
- Return only valid JSON`;

  const message = await anthropic.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 800,
    messages: [{ role: "user", content: prompt }],
  });

  const text = message.content[0].text.trim();
  // Remove any markdown code blocks
  const clean = text.replace(/^```(?:json)?\n?/m, "").replace(/\n?```$/m, "").trim();
  return JSON.parse(clean);
}

// Main API endpoint
app.get("/api/wallet-report", async (req, res) => {
  const { address } = req.query;

  if (!address) {
    return res.status(400).json({ error: "Wallet address is required" });
  }

  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return res.status(400).json({ error: "Invalid Ethereum wallet address" });
  }

  try {
    console.log(`Analyzing: ${address}`);
    const walletData = await fetchWalletData(address);
    console.log(`ETH: ${walletData.ethBalance}, Txs: ${walletData.recentTransactions.length}`);
    const report = await analyzeWithClaude(walletData);
    console.log(`Done: ${report.one_line_summary}`);
    return res.json(report);
  } catch (err) {
    console.error("Error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 3002;
app.listen(PORT, () => {
  console.log(`Wallet Watcher API running on http://localhost:${PORT}`);
  console.log(`Test: http://localhost:${PORT}/api/wallet-report?address=0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B`);
});
