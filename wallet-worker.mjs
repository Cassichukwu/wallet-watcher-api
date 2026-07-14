const ETHERSCAN_BASE = "https://api.etherscan.io/v2/api";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
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

async function sendEmailAlert(email, walletAddress, report, resendApiKey) {
  const highAlerts = report.alerts.filter(a => a.risk_level === "high");
  const mediumAlerts = report.alerts.filter(a => a.risk_level === "medium");

  const alertsHtml = report.alerts.map(alert => `
    <div style="margin: 12px 0; padding: 12px; border-radius: 8px; background: ${
      alert.risk_level === "high" ? "#fff0f0" :
      alert.risk_level === "medium" ? "#fffbf0" : "#f0fff4"
    }; border-left: 4px solid ${
      alert.risk_level === "high" ? "#e53e3e" :
      alert.risk_level === "medium" ? "#d69e2e" : "#38a169"
    }">
      <div style="font-weight: bold; text-transform: uppercase; font-size: 11px; color: ${
        alert.risk_level === "high" ? "#e53e3e" :
        alert.risk_level === "medium" ? "#d69e2e" : "#38a169"
      }">${alert.risk_level} risk</div>
      <div style="font-weight: 600; margin: 4px 0;">${alert.event}</div>
      <div style="font-size: 14px; color: #555;">${alert.why_it_matters}</div>
      <div style="font-size: 13px; color: #333; margin-top: 6px;"><strong>Action:</strong> ${alert.recommended_action}</div>
    </div>
  `).join("");

  const emailBody = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <div style="background: #0a0f1e; padding: 24px; border-radius: 12px 12px 0 0;">
        <h1 style="color: #00d4ff; margin: 0; font-size: 22px;">👁️ Wallet Watcher Copilot</h1>
        <p style="color: #8899aa; margin: 4px 0 0;">Risk Alert Report</p>
      </div>
      <div style="padding: 24px; background: #f8f9fa; border-radius: 0 0 12px 12px;">
        <p style="color: #333;"><strong>Wallet:</strong> ${walletAddress}</p>
        <p style="color: #333;"><strong>Summary:</strong> ${report.one_line_summary}</p>
        
        <h3 style="color: #333; margin-top: 20px;">Risk Alerts (${report.alerts.length})</h3>
        ${alertsHtml}
        
        <div style="margin-top: 20px; padding: 12px; background: #e8f4fd; border-radius: 8px;">
          <p style="margin: 0; color: #555; font-size: 13px;">${report.portfolio_snapshot}</p>
        </div>
        
        <div style="margin-top: 20px; text-align: center;">
          <a href="https://coin-calm-dashboard.lovable.app" 
             style="background: #00d4ff; color: #0a0f1e; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: bold;">
            View Full Report
          </a>
        </div>
        
        <p style="color: #999; font-size: 12px; margin-top: 20px; text-align: center;">
          Wallet Watcher Copilot — AI-powered wallet monitoring
        </p>
      </div>
    </div>
  `;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${resendApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: "Wallet Watcher <onboarding@resend.dev>",
      to: [email],
      subject: `⚠️ Wallet Alert: ${highAlerts.length > 0 ? highAlerts.length + " HIGH risk" : mediumAlerts.length + " medium risk"} detected`,
      html: emailBody,
    }),
  });

  const data = await res.json();
  return { success: res.ok, id: data.id, error: data.message };
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

    // GET /api/wallet-report?address=0x...&email=user@example.com
    if (url.pathname === "/api/wallet-report" && request.method === "GET") {
      const address = url.searchParams.get("address");
      const email = url.searchParams.get("email");

      if (!address) {
        return jsonResponse({ error: "Wallet address is required" }, 400);
      }

      if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
        return jsonResponse({ error: "Invalid Ethereum wallet address" }, 400);
      }

      try {
        const walletData = await fetchWalletData(address, env.ETHERSCAN_API_KEY);
        const report = await analyzeWithClaude(walletData, env.ANTHROPIC_API_KEY);

        // Send email if provided and there are alerts
        if (email && report.alerts && report.alerts.length > 0) {
          const hasHighOrMedium = report.alerts.some(a => a.risk_level === "high" || a.risk_level === "medium");
          if (hasHighOrMedium) {
            await sendEmailAlert(email, address, report, env.RESEND_API_KEY);
          }
        }

        return jsonResponse(report);
      } catch (err) {
        return jsonResponse({ error: err.message }, 500);
      }
    }

    // POST /api/send-alert - manual email trigger
    if (url.pathname === "/api/send-alert" && request.method === "POST") {
      try {
        const body = await request.json();
        const { email, address, report } = body;

        if (!email || !address || !report) {
          return jsonResponse({ error: "email, address, and report are required" }, 400);
        }

        const result = await sendEmailAlert(email, address, report, env.RESEND_API_KEY);
        return jsonResponse(result);
      } catch (err) {
        return jsonResponse({ error: err.message }, 500);
      }
    }

    return jsonResponse({ error: "Not found" }, 404);
  },
};
