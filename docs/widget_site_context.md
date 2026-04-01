# Guardrail Widget — Site-Aware AI Chat

> **Version:** 1.1.0 · **Feature:** Auto Page Context Scraping

## Overview

The Guardrail chat widget automatically scrapes the host page's content and sends it as structured context with every chat message. This allows the AI to answer questions **about your website** — your products, services, pricing, documentation — without any manual configuration.

## How It Works

```
┌─────────────────────────────────────────────────────┐
│  Your Website                                       │
│                                                     │
│  ┌─ Widget loads ─────────────────────────────────┐ │
│  │  1. Reads: title, meta tags, headings, text    │ │
│  │  2. Caches scraped context (runs once)         │ │
│  │  3. Sends pageContext with every chat message   │ │
│  └────────────────────────────────────────────────┘ │
│              │                                      │
│              ▼                                      │
│    POST /api/chat                                   │
│    { message, pageContext: { title, url, ... } }    │
└─────────────────────────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────────────────┐
│  Guardrail Server                                   │
│                                                     │
│  1. buildSystemPrompt() injects page context        │
│  2. Claude receives: system prompt + page content   │
│  3. Claude answers using your website's content     │
│  4. Response is scored by Guardrail engine           │
│  5. Result returned with confidence + decision      │
└─────────────────────────────────────────────────────┘
```

## What Gets Scraped

| Data Point | Source | Example |
|---|---|---|
| **Title** | `document.title` | "Acme Corp — Premium Widgets" |
| **URL** | `window.location.href` | "https://acme.com/pricing" |
| **Description** | `<meta name="description">` | "Industry-leading widget solutions..." |
| **Keywords** | `<meta name="keywords">` | "widgets, enterprise, SaaS" |
| **OG Title** | `<meta property="og:title">` | "Acme Corp" |
| **Headings** | All `h1`–`h3` elements | "h1: Pricing Plans", "h2: Enterprise" |
| **Body Text** | Visible text content | First 3,000 characters of page text |

### What is NOT scraped

- ❌ Scripts, styles, SVGs, iframes
- ❌ Hidden elements (`aria-hidden="true"`)
- ❌ The widget's own UI elements
- ❌ User inputs, form data, cookies
- ❌ localStorage / sessionStorage
- ❌ Any data from other browser tabs

## Whose AI Tokens Are Used?

> **The server owner's Anthropic API key pays for all Claude API calls.**

| Component | Who Pays | Key Used |
|---|---|---|
| Widget `data-key` | Free (Guardrail auth only) | `gr_live_xxx` — identifies the customer |
| Claude API calls | Server operator | `ANTHROPIC_API_KEY` in server `.env` |
| Optional: caller's key | The caller | `anthropicKey` in request body |

The `data-key` on the widget is a **Guardrail API key** for authentication and usage tracking — it is NOT an LLM API key.

If no Anthropic key is configured on the server, the widget falls back to **demo mode** with pre-recorded responses (no AI tokens consumed).

## Integration

### Basic (auto-scraping enabled by default)

```html
<!-- Paste before </body> -->
<script
  src="https://your-guardrail-server.com/embed/widget.js"
  data-key="gr_live_xxx"
></script>
```

### With All Options

```html
<script
  src="https://your-guardrail-server.com/embed/widget.js"
  data-key="gr_live_xxx"
  data-context="general"
  data-title="Acme Support"
  data-theme="dark"
  data-scrape="true"
  data-system-prompt="You are Acme Corp's support agent. Be friendly and helpful."
  data-welcome="Hi! Ask me anything about Acme products."
  data-placeholder="Ask about our products..."
></script>
```

### Disable Scraping

If you don't want the widget to read page content:

```html
<script
  src="https://your-guardrail-server.com/embed/widget.js"
  data-key="gr_live_xxx"
  data-scrape="false"
></script>
```

## Data Attributes Reference

| Attribute | Default | Description |
|---|---|---|
| `data-key` | *required* | Your Guardrail API key |
| `data-scrape` | `"true"` | Enable/disable page context scraping |
| `data-context` | `"general"` | Domain context for confidence scoring |
| `data-title` | `"AI Assistant"` | Widget header title |
| `data-theme` | `"dark"` | `"dark"` or `"light"` |
| `data-system-prompt` | `""` | Extra instructions appended to system prompt |
| `data-welcome` | `"Hi! I'm your..."` | First message shown in chat |
| `data-placeholder` | `"Ask anything..."` | Input placeholder text |

## System Prompt Structure

When page context is available, the server builds the following system prompt for Claude:

```
You are an AI assistant for the website described below.
Use the website context to answer user questions accurately.
If the user asks something not covered by the website context, say so honestly.

--- WEBSITE CONTEXT ---
Title: Acme Corp — Premium Widgets
URL: https://acme.com/pricing
Description: Industry-leading widget solutions for enterprise teams.
Keywords: widgets, enterprise, SaaS

Page Structure (headings):
  - h1: Pricing Plans
  - h2: Starter
  - h2: Professional
  - h2: Enterprise

Page Content:
Acme Corp offers three pricing tiers. The Starter plan begins at $29/mo
and includes up to 5 team members. The Professional plan at $99/mo
supports unlimited team members and priority support...
--- END WEBSITE CONTEXT ---

Additional instructions: You are Acme Corp's support agent.
```

## Privacy & Security

1. **Text only** — Only visible text content is scraped. No scripts, styles, or user data.
2. **One-time scrape** — The page is scraped once on load and cached. No continuous monitoring.
3. **Truncated** — Body text is capped at 3,000 characters to limit token usage.
4. **Your server** — Page context is sent to YOUR Guardrail server, not a third party.
5. **Opt-out** — Set `data-scrape="false"` to completely disable scraping.
6. **No PII collection** — The widget does not access cookies, localStorage, form inputs, or any user-specific data.

## Token Cost Estimation

Each chat message with page context adds roughly **800–1,200 tokens** to the system prompt (depending on page content length). Assuming Claude's pricing:

| Scenario | Approx Extra Cost per Message |
|---|---|
| Short page (~500 chars) | ~$0.0003 |
| Medium page (~2,000 chars) | ~$0.001 |
| Full page (3,000 char cap) | ~$0.0015 |

This is the **input token cost only** and uses the page context as system prompt tokens.

## API Request Format

The widget sends the following to `/api/chat`:

```json
{
  "message": "What pricing plans do you offer?",
  "context": "general",
  "pageContext": {
    "title": "Acme Corp — Pricing",
    "url": "https://acme.com/pricing",
    "description": "Compare our Starter, Pro, and Enterprise plans.",
    "headings": [
      "h1: Pricing Plans",
      "h2: Starter — $29/mo",
      "h2: Professional — $99/mo",
      "h2: Enterprise — Custom"
    ],
    "bodyText": "Acme Corp offers three pricing tiers...",
    "scrapedAt": "2026-03-31T23:30:00.000Z"
  }
}
```

The server response includes a `hasPageContext: true` flag in the log record so you can track which conversations used site context.
