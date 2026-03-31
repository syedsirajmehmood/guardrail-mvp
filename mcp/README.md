# 🛡️ Guardrail AI — MCP Server for Claude Desktop

Real-time AI confidence scoring. Detect hallucinations, unsafe advice, and fabricated citations in any AI response — in under 50ms.

**npm**: [guardrail-ai-mcp](https://www.npmjs.com/package/guardrail-ai-mcp)
**Docs**: [guardrail-mvp-production.up.railway.app/docs.html](https://guardrail-mvp-production.up.railway.app/docs.html)

---

## Quick Install

```bash
npx guardrail-ai-mcp --key YOUR_API_KEY
```

That's it. No `npm install`, no manual dependency setup — npx handles everything.

---

## Step-by-Step Setup (Claude Desktop)

### Step 1: Get a free API key

**Option A — Web (easiest):**
Go to [guardrail-mvp-production.up.railway.app/developer.html](https://guardrail-mvp-production.up.railway.app/developer.html) and enter your email. You'll get a key starting with `gr_live_`.

**Option B — Terminal:**
```bash
curl -X POST https://guardrail-mvp-production.up.railway.app/api/keys/create \
  -H "Content-Type: application/json" \
  -d '{"email": "you@example.com"}'
```

The response will include your API key:
```json
{ "apiKey": "gr_live_abc123...", "email": "you@example.com" }
```

> ⚠️ **Save your key immediately!** It is shown only once and cannot be recovered. Store it somewhere safe (password manager, `.env` file, etc.).

### Step 2: Open your Claude Desktop config file

**Mac:**
```bash
open ~/Library/Application\ Support/Claude/claude_desktop_config.json
```

**Windows:**
```
%APPDATA%\Claude\claude_desktop_config.json
```

### Step 3: Add the Guardrail MCP server

Paste this into your config. Replace `gr_live_xxx` with the API key you saved in Step 1:

```json
{
  "mcpServers": {
    "guardrail": {
      "command": "npx",
      "args": ["guardrail-ai-mcp", "--key", "gr_live_xxx"]
    }
  }
}
```

> ⚠️ **If your config already has content** (like a `"preferences"` section), merge them into ONE JSON object:

```json
{
  "preferences": {
    "coworkScheduledTasksEnabled": true,
    "sidebarMode": "chat"
  },
  "mcpServers": {
    "guardrail": {
      "command": "npx",
      "args": ["guardrail-ai-mcp", "--key", "gr_live_xxx"]
    }
  }
}
```

### Step 4: Restart Claude Desktop

**Cmd+Q** (Mac) or fully close and reopen. The Guardrail tools load on startup.

### Step 5: Verify it's working

1. Click the **+** button in the chat input
2. Click **Connectors** — you should see **"guardrail"** with a blue toggle ON
3. Type: `Use the guardrail score_and_explain tool to score this: "The Earth is flat."`
4. Claude will call Guardrail and show you the confidence score and signals

---

## Auto-Use (Optional)

By default you need to say "use the guardrail tool..." To make it automatic:

1. Click **+** → **Connectors** → **Tool access** → select **"Tools already loaded"**
2. Create a **Project** (e.g. "Guardrail Testing")
3. Click **+** next to **Instructions** and add:

```
Always use the guardrail score_and_explain tool to score any AI-generated
text I share. Show the confidence score, decision, and detected signals.
Do not answer the text's question — only score it.
```

Now every message in that project automatically uses Guardrail.

---

## Available Tools

| Tool | Description |
|------|-------------|
| `check_confidence` | Quick score — returns confidence 0-1 and deliver/flag/escalate decision |
| `score_and_explain` | Detailed score with human-readable explanation of all signals detected |
| `get_my_stats` | Your API usage — total checks, decision breakdown, recent logs |

### Context-Aware Scoring

All tools support an optional `userQuery` parameter. When you provide the original user question alongside the AI response, Guardrail runs 5 additional signals:

- **Question-type classification** — fact, opinion, instruction, dangerous
- **Relevance scoring** — does the response address the question?
- **Scope creep detection** — is the response absurdly verbose?
- **Refusal audit** — does a dangerous question get a free answer?
- **Context match boost** — +3% for directly relevant responses

---

## Dashboard

Every MCP tool call automatically logs to your dashboard — no extra setup needed.

### View your dashboard

👉 **[guardrail-mvp-production.up.railway.app/dashboard.html](https://guardrail-mvp-production.up.railway.app/dashboard.html)**

Log in with your API key to see:

| Section | What It Shows |
|---------|---------------|
| **Overview** | Total checks, deliver rate, average confidence, recent flags/escalations |
| **Decision Breakdown** | Pie chart of deliver vs flag vs escalate decisions |
| **Recent Logs** | Every check with timestamp, score, decision, signals, and text preview |
| **Trends** | Confidence scores over time |

### What gets logged

Every time Claude calls `check_confidence` or `score_and_explain`, the following is saved:

- Confidence score (0-1)
- Decision (deliver / flag / escalate)
- Signals detected (e.g., "Hedged language", "Unverified claim")
- Domain context (general, medical, financial, etc.)
- User query (if provided)
- Timestamp

### API access to your stats

```bash
# Get your dashboard stats
curl -H "X-Guardrail-Key: gr_live_xxx" \
  https://guardrail-mvp-production.up.railway.app/api/stats

# Get recent logs
curl -H "X-Guardrail-Key: gr_live_xxx" \
  https://guardrail-mvp-production.up.railway.app/api/logs?limit=50
```

---

## Resources

- [Setup Guide](https://guardrail-mvp-production.up.railway.app/setup.html) — visual step-by-step
- [API Docs](https://guardrail-mvp-production.up.railway.app/docs.html) — full endpoint reference
- [Playground](https://guardrail-mvp-production.up.railway.app/playground.html) — test scoring in your browser
- [GitHub](https://github.com/saifsysim/guardrail-mvp) — source code
- [Audit Results](https://guardrail-mvp-production.up.railway.app/medium_article_v2.html) — context-aware scoring tested on 3 LLMs

## License

MIT
