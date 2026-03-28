# 🛡️ Guardrail — AI Escalation Intelligence Layer

> Know when your AI should hand off to a human.

Guardrail is a hosted API that sits between your AI model and your users. It scores every response in real-time and routes it: **deliver**, **flag for review**, or **escalate to a human** — without exposing your scoring logic.

---

## Quick Start

```bash
npm install guardrail-sdk
```

```js
const Guardrail = require('guardrail-sdk');

const gr = new Guardrail({
  apiKey:  'gr_live_xxxx',   // your API key
  context: 'medical',        // general | medical | legal | financial | security | safety
  onEscalate: (r) => notifyHumanAgent(r),
  onFlag:     (r) => showDisclaimer(r),
});

const aiResponse = await yourAI.chat(userMessage);
const result     = await gr.check(aiResponse, { userId: 'u_123' });

if (result.decision === 'deliver') showToUser(aiResponse);
```

> **Get an API key:** Email [hello@guardrail.dev](mailto:hello@guardrail.dev) or request access at [guardrail.dev](https://guardrail.dev).

---

## Browser (CDN)

```html
<script src="https://cdn.guardrail.dev/sdk/v2/guardrail.min.js"></script>
<script>
  const gr = new Guardrail({ apiKey: 'gr_live_xxxx', context: 'legal' });
  const result = await gr.check(aiText);
</script>
```

---

## Decision Logic

| Decision | Confidence | Action |
|---|---|---|
| ✅ Deliver  | ≥ 0.75 | Response sent to user unchanged |
| ⚠️ Flag    | 0.45 – 0.75 | Add disclaimer or async review |
| 🔴 Escalate | < 0.45 | Block response, notify human agent |

---

## API Reference

All requests require the `X-Guardrail-Key` header.

### `POST /api/check`
Score any AI response text.
```json
{ "text": "...", "context": "medical", "userId": "u_123" }
```

### `POST /api/chat`
Call Claude and score in one step.
```json
{ "message": "...", "context": "medical" }
```

### `GET /api/stats`
Aggregate delivery / flag / escalation counts.

### `GET /api/logs`
Recent decisions (up to 200).

### `GET /api/events`
SSE stream for real-time dashboard updates.

---

## Signals Detected

- Uncertainty language ("I'm not sure", "maybe", "I think")
- Hallucination patterns ("studies show", "as of my knowledge cutoff")
- Contradictions ("however", "correction", "actually")
- High-stakes domains (medical, legal, financial, safety, security)
- Domain-specific content (dosage, diagnosis, lawsuit, credential)
- User frustration ("wrong", "again", "that's not right")

---

## Contexts Supported

`general` · `medical` · `legal` · `financial` · `security` · `safety`

Guardrail works with **any LLM** — OpenAI, Anthropic, Gemini, or your own model. The SDK only sees the response text.
