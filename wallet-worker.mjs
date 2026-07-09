const ETHERSCAN_BASE = "https://api.etherscan.io/v2/api";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

async function etherscanGet(params, apiKey) {
  try {
    const url = new URL(ETHERSCAN_BASE);
    url.searchParams.set("chainid", "1");
    url.searchParams.set("apikey", apiKey);
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    const res = await fetch(url.toString());
    const data = await res.json();
    if (data.status === "1") return data.result;
    return null;
  } catch {
    return null;
  }
}

async function fetchWalletData(address, apiKey) {
  const [balance, transactions, tokenTransfers] = await Promise.all([
    etherscanGet({ module: "account", action: "balance", address, tag: "latest" }, apiKey),
    etherscanGet({ module: "account", action: "txlist", address, startblock: "0", endblock: "99999999", page: "1", offset: "5", sort: "desc" }, apiKey),
    etherscanGet({ module: "account", action: "tokentx", address, page: "1", offset: "5", sort: "desc" }, apiKey),
  ]);

  const ethBalance = balance ? (parseInt(balance) / 1e18).toFixed(4) : "unknown";

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

async function analyzeWithClaude(walletData, apiKey) {
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
  "portfolio_snapshot": "1-2 sentence summary",
  "activity_summary": ["item 1", "item 2"],
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

Rules: risk_level must be low/medium/high. Be concise. No investment advice. Return only valid JSON.`;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5",
      max_tokens: 800,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  const data = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(data.error));
  
  const text = data.content[0].text.trim();
  const clean = text.replace(/^```(?:json)?\n?/m, "").replace(/\n?```$/m, "").trim();
  return JSON.parse(clean);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
  return new Response(null, { 
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Max-Age": "86400",
    }
  });
}

    if (url.pathname === "/health") {
      return jsonResponse({ status: "ok", timestamp: new Date().toISOString() });
    }

    if (url.pathname === "/api/wallet-report" && request.method === "GET") {
      const address = url.searchParams.get("address");

      if (!address) {
        return jsonResponse({ error: "Wallet address is required" }, 400);
      }

      if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
        return jsonResponse({ error: "Invalid Ethereum wallet address" }, 400);
      }

      try {
        const walletData = await fetchWalletData(address, env.ETHERSCAN_API_KEY);
        const report = await analyzeWithClaude(walletData, env.ANTHROPIC_API_KEY);
        return jsonResponse(report);
      } catch (err) {
        return jsonResponse({ error: err.message }, 500);
      }
    }

    return jsonResponse({ error: "Not found" }, 404);
  },
};
