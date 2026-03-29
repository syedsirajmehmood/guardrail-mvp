# guardrail-mcp

MCP server for [Guardrail](https://guardrail-mvp-production.up.railway.app) — AI confidence scoring for Claude Desktop.

Score any AI response for uncertainty, hallucination risk, and high-stakes domain signals. Deterministic pattern matching — no LLM tokens burned.

## Quick Start

```bash
npx guardrail-mcp --key gr_live_xxx
```

Get a free API key at [guardrail-mvp-production.up.railway.app](https://guardrail-mvp-production.up.railway.app).

## Claude Desktop Config

Add to `~/.config/claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "guardrail": {
      "command": "npx",
      "args": ["guardrail-mcp", "--key", "gr_live_xxx"]
    }
  }
}
```

Restart Claude Desktop — three Guardrail tools appear automatically:

| Tool | What it does |
|------|-------------|
| `check_confidence` | Score text → deliver / flag / escalate |
| `get_my_stats` | View usage stats and decision breakdown |
| `score_and_explain` | Score + human-readable explanation |

## Options

```
--key <key>         Guardrail API key (required)
--endpoint <url>    Custom API URL (default: production Railway)
--help              Show help
```

## How It Works

Guardrail uses 55 deterministic signal patterns across 8 categories (uncertainty, hallucination, sycophancy, etc.) to score AI responses. No LLM calls in the scoring path — results are instant and reproducible.

## License

MIT
