# guardrail-mcp-server

MCP server for [Guardrail AI](https://guardrail-mvp-production.up.railway.app) — score AI responses for hallucinations, safety risks, and confidence before they reach your users.

Works with **Claude Desktop**, **Cursor**, and any MCP-compatible client.

## Quick Start

### 1. Get a Free API Key

Sign up at [guardrail-mvp-production.up.railway.app](https://guardrail-mvp-production.up.railway.app)

### 2. Configure Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "guardrail": {
      "command": "npx",
      "args": ["guardrail-mcp-server", "--key", "gr_live_YOUR_KEY_HERE"]
    }
  }
}
```

### 3. Restart Claude Desktop

Three new tools will appear:

| Tool | What It Does |
|------|-------------|
| `check_confidence` | Score text → deliver / flag / escalate |
| `score_and_explain` | Score + human-readable explanation |
| `get_my_stats` | Your usage stats |

## Context-Aware Scoring

For best results, pass the user's original question alongside the AI response:

```
Use check_confidence with:
  text: "The capital of France is Paris"
  userQuery: "What is the capital of France?"
```

This enables:
- **Question-type detection** — fact vs opinion vs instruction
- **Relevance scoring** — does the response address the question?
- **Scope analysis** — is the response proportionate to the question?
- **Refusal audit** — did the model answer a dangerous question freely?

## 23+ Detection Signals

Hallucinated facts • Fabricated citations • Medical/legal/financial risk • Sycophancy • Knowledge cutoff disclaimers • Self-contradiction • Unverified claims • and more.

## Links

- [Live Playground](https://guardrail-mvp-production.up.railway.app/playground.html)
- [API Docs](https://guardrail-mvp-production.up.railway.app/docs.html)
- [Audit Report](https://github.com/saifsysim/guardrail-audit)
