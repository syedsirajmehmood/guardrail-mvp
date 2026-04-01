# 🛡️ Guardrail — How It Works

> The AI Escalation Intelligence Layer

## High-Level Architecture

```mermaid
graph TB
    subgraph YOUR_APP["Your Application"]
        AI["Any AI / LLM<br/>(OpenAI, Claude, Gemini, etc.)"]
        APP["Your App / Chatbot"]
    end

    subgraph GUARDRAIL["Guardrail Platform"]
        API["Guardrail API<br/>/api/check · /api/chat"]
        ENGINE["Scoring Engine<br/>60+ Signal Patterns"]
        WIKI["Wikipedia Verification"]
        DB["Usage Analytics<br/>(PostgreSQL)"]
    end

    subgraph OUTPUTS["Decisions"]
        DELIVER["✅ Deliver<br/>Confidence ≥ 75%"]
        FLAG["⚠️ Flag<br/>Confidence 45–74%"]
        ESCALATE["🔴 Escalate<br/>Confidence < 45%"]
    end

    AI -->|"AI response"| APP
    APP -->|"Score this response"| API
    API --> ENGINE
    ENGINE --> WIKI
    ENGINE --> DB
    API --> DELIVER
    API --> FLAG
    API --> ESCALATE

    style GUARDRAIL fill:#0d1e33,stroke:#1db99a,color:#e2edf8
    style DELIVER fill:#0a2e20,stroke:#1db99a,color:#1db99a
    style FLAG fill:#2a1f0a,stroke:#f5a623,color:#f5a623
    style ESCALATE fill:#2a0a0a,stroke:#ff5c5c,color:#ff5c5c
```

---

## Integration Paths

Choose the integration that fits your stack:

```mermaid
flowchart LR
    subgraph CHOOSE["Choose Your Integration"]
        direction TB
        A["🌐 Browser SDK"]
        B["💬 Chat Widget"]
        C["🔌 Chatflow / Flowise"]
        D["🗨️ tawk.to"]
        E["🖥️ MCP / Claude Desktop"]
        F["📡 REST API"]
    end

    A -->|"guardrail.js"| G["POST /api/check"]
    B -->|"embed/widget.js"| H["POST /api/chat"]
    C -->|"Custom Tool"| G
    D -->|"Webhook"| I["POST /api/tawkto/webhook"]
    E -->|"MCP Server"| G
    F -->|"Direct HTTP"| G

    G --> J["Score + Decision"]
    H --> J
    I --> J

    style CHOOSE fill:#0d1e33,stroke:#1e3050,color:#e2edf8
    style J fill:#0a2e20,stroke:#1db99a,color:#1db99a
```

---

## Flow 1 — SDK Integration (Any AI Model)

Best for: **Custom apps with any LLM**

```mermaid
sequenceDiagram
    participant User
    participant App as Your App
    participant LLM as Any LLM
    participant GR as Guardrail API

    User->>App: Ask a question
    App->>LLM: Forward to AI model
    LLM-->>App: AI response
    App->>GR: POST /api/check {text, context}
    GR-->>App: {decision, confidence, reasons}

    alt decision = deliver
        App-->>User: ✅ Show response
    else decision = flag
        App-->>User: ⚠️ Show with disclaimer
    else decision = escalate
        App-->>User: 🔴 Route to human
    end
```

---

## Flow 2 — Chat Widget (Drop-in, Site-Aware)

Best for: **Adding AI chat to any website**

```mermaid
sequenceDiagram
    participant Visitor
    participant Widget as Chat Widget
    participant Page as Host Website
    participant GR as Guardrail Server
    participant Claude as Claude AI

    Note over Widget,Page: Widget loads → auto-scrapes page
    Widget->>Page: Read title, meta, headings, body text
    Page-->>Widget: Page context (cached)

    Visitor->>Widget: Ask about your products
    Widget->>GR: POST /api/chat {message, pageContext}
    GR->>GR: Build system prompt with page context
    GR->>Claude: Call Claude with site-aware prompt
    Claude-->>GR: AI response
    GR->>GR: Score response (60+ signals)
    GR-->>Widget: {fullText, decision, confidence}
    Widget-->>Visitor: Show response + confidence badge
```

---

## Flow 3 — tawk.to (Post-Chat Audit)

Best for: **Monitoring existing chatbot quality**

```mermaid
sequenceDiagram
    participant Customer
    participant Tawk as tawk.to Chatbot
    participant GR as Guardrail API
    participant Dash as Your Dashboard

    Customer->>Tawk: Chat conversation
    Tawk-->>Customer: AI responses
    Note over Tawk: Chat ends
    Tawk->>GR: Webhook: POST /api/tawkto/webhook
    GR->>GR: Score each AI message
    GR-->>Tawk: {processed, results}
    GR->>Dash: Log scores to dashboard
    Note over Dash: Review flagged/escalated responses
```

---

## Flow 4 — Chatflow / Flowise (Inline Safety)

Best for: **No-code chatbot builders**

```mermaid
sequenceDiagram
    participant Customer
    participant CF as Chatflow Bot
    participant AI as AI Chain
    participant GR as Guardrail API

    Customer->>CF: Ask question
    CF->>AI: Process through AI chain
    AI-->>CF: Raw AI response
    CF->>GR: POST /api/check {text, userQuery}
    GR-->>CF: {decision, confidence}

    alt deliver
        CF-->>Customer: Show response as-is
    else flag
        CF-->>Customer: Response + "Call us for details"
    else escalate
        CF-->>Customer: Response + "Confirm with our team"
    end
```

---

## Decision Logic

```mermaid
flowchart TD
    A["AI Response Text"] --> B["Scoring Engine"]
    B --> C{"60+ Signal\nPatterns"}

    C --> D["Uncertainty<br/>−8% to −18%"]
    C --> E["Knowledge Cutoff<br/>−8% to −22%"]
    C --> F["Hallucination<br/>−8% to −20%"]
    C --> G["Evasion<br/>−6% to −12%"]
    C --> H["Domain Risk<br/>−20% to −35%"]
    C --> I["Quality Bonus<br/>+2% to +4%"]

    D --> J["Base Score 82%<br/>± Signal Adjustments"]
    E --> J
    F --> J
    G --> J
    H --> J
    I --> J

    J --> K{"Final\nConfidence"}
    K -->|"≥ 75%"| L["✅ DELIVER"]
    K -->|"45–74%"| M["⚠️ FLAG"]
    K -->|"< 45%"| N["🔴 ESCALATE"]

    style L fill:#0a2e20,stroke:#1db99a,color:#1db99a
    style M fill:#2a1f0a,stroke:#f5a623,color:#f5a623
    style N fill:#2a0a0a,stroke:#ff5c5c,color:#ff5c5c
```

---

## Getting Started

1. **Sign up** → [guardrail-mvp-production.up.railway.app](https://guardrail-mvp-production.up.railway.app)
2. **Get your API key** → `gr_live_xxx`
3. **Pick an integration** → SDK, Widget, Chatflow, tawk.to, MCP, or REST
4. **See results** → [Developer Dashboard](https://guardrail-mvp-production.up.railway.app/developer.html)
