# 🛡️ Guardrail — AI Escalation Intelligence Layer

> Know when your AI should hand off to a human.

Guardrail is a hosted API that sits between your AI model and your users. It scores every response in real-time and routes it: **deliver**, **flag for review**, or **escalate to a human**.

---

## 🚀 Getting Started (3 steps)

### Step 1 — Sign Up for a Free API Key

Visit the landing page and enter your email in the hero signup form:

```
https://YOUR-RAILWAY-URL.up.railway.app
```

Click **"Get Free Key →"** and you'll instantly receive a unique API key:

```
gr_live_a3b4c5d6e7f8...
```

You'll be redirected automatically to your **Developer Portal** at `/developer.html`.

---

### Step 2 — Copy Your Integration Snippet

In your Developer Portal, you'll see a pre-filled code snippet with **your key already in it**. Copy it into your project:

```html
<!-- Browser: load the SDK -->
<script src="https://YOUR-RAILWAY-URL.up.railway.app/sdk/guardrail.js"></script>
<script>
  const gr = new Guardrail({
    endpoint: 'https://YOUR-RAILWAY-URL.up.railway.app',
    apiKey:   'gr_live_your_key_here',
    context:  'general',           // general | medical | legal | financial | security | safety
    onEscalate: (r) => notifyHuman(r),
    onFlag:     (r) => showDisclaimer(r),
  });
</script>
```

Or in **Node.js**, copy `sdk/guardrail.js` into your project:

```js
const Guardrail = require('./guardrail');

const gr = new Guardrail({
  endpoint: 'https://YOUR-RAILWAY-URL.up.railway.app',
  apiKey:   'gr_live_your_key_here',
  context:  'medical',
  onEscalate: (r) => notifyHumanAgent(r),
});
```

---

### Step 3 — Wrap Your AI Calls

After getting a response from any AI model, pass it through Guardrail:

```js
const aiResponse = await yourAI.chat(userMessage);
const result     = await gr.check(aiResponse, { userId: 'u_123' });

// result.decision  → 'deliver' | 'flag' | 'escalate'
// result.confidence → 0.0 – 1.0
// result.reasons   → ['Uncertainty language detected', ...]

if (result.decision === 'deliver') {
  showToUser(aiResponse);                  // ✅ high confidence
} else if (result.decision === 'flag') {
  showWithDisclaimer(aiResponse, result);  // ⚠️ uncertain
} else {
  escalateToHuman(result);                 // 🔴 block + alert
}
```

That's it. Guardrail works with **any LLM** — OpenAI, Anthropic, Gemini, or your own model.

---

## 🎯 Decision Logic

| Decision | Confidence | What happens |
|---|---|---|
| ✅ **Deliver** | ≥ 0.75 | Response sent to user unchanged |
| ⚠️ **Flag** | 0.45 – 0.74 | Show disclaimer or queue for async review |
| 🔴 **Escalate** | < 0.45 | Block response, notify human agent immediately |

---

## 🌐 Live Tools

| Tool | URL | Description |
|---|---|---|
| **Landing Page** | `/` | Signup form, overview |
| **Developer Portal** | `/developer.html` | Your API key, stats, code snippet |
| **Playground** | `/playground.html` | Paste any AI text, test scoring interactively |
| **Dashboard** | `/dashboard.html` | Real-time feed of all decisions |
| **Chat Demo** | `/chat.html` | Live Claude chat with Guardrail scoring |

---

## 📡 API Reference

All endpoints (except `/api/signup` and `/api/health`) require the `X-Guardrail-Key` header.

### `POST /api/signup` — **Public** — Get an API key
```json
Body: { "email": "you@example.com" }
Response: { "key": "gr_live_xxx", "email": "you@example.com", "existed": false }
```
Idempotent — signing up with the same email returns your existing key.

---

### `POST /api/check` — Score any AI response
```json
Body: { "text": "...", "context": "medical", "userId": "u_123" }
Response: { "decision": "escalate", "confidence": 0.31, "reasons": ["Uncertainty language detected (3 signals)", "High-stakes domain: medical"] }
```

---

### `POST /api/chat` — Call Claude + score in one step
```json
Body: { "message": "What is the dosage for aspirin?", "context": "medical" }
Response: { "decision": "flag", "confidence": 0.62, "fullText": "...", "reasons": [...] }
```

---

### `GET /api/developer/me` — Your personal usage stats
```json
Headers: X-Guardrail-Key: gr_live_xxx
Response: { "email": "you@example.com", "requests": 42, "decisions": { "deliver": 30, "flag": 8, "escalate": 4 }, "recentLogs": [...] }
```

---

### `GET /api/stats` — Aggregate stats
```json
Response: { "total": 100, "deliver": 72, "flag": 20, "escalate": 8, "deliverRate": 72.0, ... }
```

---

### `GET /api/logs?limit=50` — Recent decisions (up to 200)

### `GET /api/events` — SSE real-time stream for dashboard

### `GET /api/health` — Health check (public)

---

## 🧠 Signals Detected

| Signal | Examples |
|---|---|
| **Uncertainty** | "I'm not sure", "maybe", "I think", "perhaps" |
| **Hallucination risk** | "studies show", "as of my knowledge cutoff", exact made-up stats |
| **Contradiction** | "however", "on the other hand", "correction", "actually" |
| **High-stakes domain** | Medical, legal, financial, safety, security context |
| **Domain content** | Dosage, diagnosis, lawsuit, credentials, surgery |
| **User frustration** | "wrong", "again", "that's not right", repeated corrections |

---

## 🧪 Running Tests

```bash
npm test
# → 24 tests, all passing
```

---

## 🔧 Self-Hosting

```bash
git clone https://github.com/saifsysim/guardrail-mvp
cd guardrail-mvp
cp .env.example .env
# Add ANTHROPIC_API_KEY and GUARDRAIL_MASTER_KEY to .env
npm install
npm run dev
# → http://localhost:3001
```

Deploy to Railway: connect repo, set env vars, generate domain. Done.

---

## Contexts Supported

`general` · `medical` · `legal` · `financial` · `security` · `safety`
