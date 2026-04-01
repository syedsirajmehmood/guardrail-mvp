# Guardrail AI — Internal Architecture Reference

> **Audience:** Engineering team / internal reference  
> **Last Updated:** 2026-04-01

---

## System Architecture

```mermaid
graph TB
    subgraph CLIENTS["Client Layer"]
        SDK["Browser SDK<br/>guardrail.js v2.0"]
        WIDGET["Embeddable Widget<br/>embed/widget.js"]
        CURL["Direct REST<br/>curl / fetch"]
        MCP["MCP Server<br/>Claude Desktop"]
        TAWK["tawk.to Webhook"]
    end

    subgraph SERVER["Express Server (server.js)"]
        MW["Middleware Layer<br/>CORS · JSON · Cache-Control · Static"]
        AUTH["Auth Middleware<br/>requireKey · requireMasterKey"]

        subgraph ROUTES["API Routes"]
            R1["POST /api/signup<br/>(public)"]
            R2["POST /api/check<br/>(auth)"]
            R3["POST /api/chat<br/>(auth)"]
            R4["POST /api/demo-check<br/>(public, rate-limited)"]
            R5["POST /api/demo-chat<br/>(public, rate-limited)"]
            R6["GET /api/developer/me<br/>(auth)"]
            R7["GET /api/stats · /api/logs<br/>(auth)"]
            R8["POST /api/tawkto/webhook<br/>(auth)"]
            R9["GET /api/events<br/>(SSE stream)"]
            R10["CRUD /api/keys<br/>(master key)"]
        end

        subgraph SCORING["Scoring Engine"]
            SE["scoreText()"]
            SEV["scoreTextWithVerification()"]
            QA["analyzeQueryContext()"]
            CE["extractClaims()"]
            SP["buildSystemPrompt()"]
        end
    end

    subgraph EXTERNAL["External Services"]
        CLAUDE["Anthropic Claude API<br/>claude-sonnet-4-5-20250929"]
        WIKIPEDIA["Wikipedia REST API<br/>Claim verification"]
    end

    subgraph DATA["Data Layer"]
        PG["PostgreSQL<br/>(Railway / DATABASE_URL)"]
        MEM["In-Memory Fallback<br/>(data/keys.json)"]
        STORE["In-Memory Store<br/>(logs[], stats{}, SSE clients[])"]
    end

    SDK --> MW
    WIDGET --> MW
    CURL --> MW
    MCP --> MW
    TAWK --> MW

    MW --> AUTH
    AUTH --> ROUTES

    R2 --> SE
    R3 --> SP
    SP --> CLAUDE
    R3 --> SE
    R2 --> SEV
    SEV --> WIKIPEDIA
    SE --> CE
    SE --> QA
    R8 --> SE

    ROUTES --> PG
    ROUTES --> MEM
    ROUTES --> STORE
    R9 --> STORE

    style SERVER fill:#0d1e33,stroke:#1e3050,color:#e2edf8
    style SCORING fill:#081420,stroke:#1db99a,color:#e2edf8
    style DATA fill:#081420,stroke:#1e3050,color:#e2edf8
```

---

## Data Model

```mermaid
erDiagram
    customers {
        SERIAL id PK
        VARCHAR(64) api_key UK "gr_live_xxx"
        VARCHAR(255) email
        VARCHAR(255) label "unnamed"
        VARCHAR(20) plan "free"
        INT requests "0"
        INT checks_limit "1000"
        INT deliver_count "0"
        INT flag_count "0"
        INT escalate_count "0"
        TIMESTAMP created_at "NOW()"
        TIMESTAMP updated_at "NOW()"
    }

    usage_logs {
        SERIAL id PK
        VARCHAR(64) customer_api_key FK
        REAL score "0.0-1.0"
        VARCHAR(20) decision "deliver|flag|escalate"
        TEXT_ARRAY flags_triggered "signal labels[]"
        VARCHAR(100) context "general"
        INT response_length "0"
        VARCHAR(300) user_query "nullable"
        TIMESTAMP created_at "NOW()"
    }

    customers ||--o{ usage_logs : "has many"
```

### Indexes
| Table | Index | Column |
|---|---|---|
| `customers` | `idx_customers_email` | `email` |
| `usage_logs` | `idx_usage_logs_key` | `customer_api_key` |
| `usage_logs` | `idx_usage_logs_created` | `created_at` |

### Storage Modes
| Mode | Trigger | Customers | Logs |
|---|---|---|---|
| **PostgreSQL** | `DATABASE_URL` set | `customers` table | `usage_logs` table |
| **In-Memory** | No `DATABASE_URL` | `data/keys.json` (Map) | In-memory array (max 500) |

---

## Authentication Flow

```mermaid
flowchart TD
    REQ["Incoming Request"] --> CHECK{"Has X-Guardrail-Key\nor ?key= param?"}
    CHECK -->|No| R401["401: API key required"]
    CHECK -->|Yes| MASTER{"key === MASTER_KEY?"}
    MASTER -->|Yes| PASS_M["✅ Pass as admin<br/>req.isMaster = true"]
    MASTER -->|No| DB_LOOKUP["db.getCustomerByKey(key)"]
    DB_LOOKUP --> FOUND{"Customer found?"}
    FOUND -->|No| R401_2["401: Invalid or revoked"]
    FOUND -->|Yes| PASS_C["✅ Pass as customer<br/>req.guardrailCustomer = entry"]

    style R401 fill:#2a0a0a,stroke:#ff5c5c,color:#ff5c5c
    style R401_2 fill:#2a0a0a,stroke:#ff5c5c,color:#ff5c5c
    style PASS_M fill:#0a2e20,stroke:#1db99a,color:#1db99a
    style PASS_C fill:#0a2e20,stroke:#1db99a,color:#1db99a
```

---

## Scoring Engine Pipeline

```mermaid
flowchart TD
    INPUT["Input: text, context, userQuery"] --> SCAN["Scan Signal Patterns"]

    SCAN --> S1["Uncertainty (8 patterns)<br/>−8% to −18%"]
    SCAN --> S2["Knowledge Cutoff (10 patterns)<br/>−8% to −22%"]
    SCAN --> S3["Contradiction (4 patterns)<br/>−6% to −14%"]
    SCAN --> S4["Evasion (7 patterns)<br/>−6% to −12%"]
    SCAN --> S5["Hallucination (9 patterns)<br/>−8% to −20%"]
    SCAN --> S6["Frustration (5 patterns)<br/>−6% to −14%"]
    SCAN --> S7["Sycophancy (4 patterns)<br/>−4% to −8%"]

    S1 --> PENALTY["Sum Total Penalty"]
    S2 --> PENALTY
    S3 --> PENALTY
    S4 --> PENALTY
    S5 --> PENALTY
    S6 --> PENALTY
    S7 --> PENALTY

    INPUT --> DOMAIN["Auto-Detect Domain"]
    DOMAIN --> RISK["Domain Risk Penalty<br/>medical: −25%, safety: −30%..."]
    RISK --> PENALTY

    INPUT --> HSP["High-Stakes Pattern Match"]
    HSP -->|"Match"| HSP_P["−10% penalty"]
    HSP_P --> PENALTY

    INPUT --> QUALITY["Assess Quality<br/>(numbers, URLs, code, lists)"]
    QUALITY --> BONUS["Quality Bonus<br/>+2% to +10% (capped)"]
    QUALITY --> SHORT["Short Penalty<br/>< 10w: −12%, < 25w: −6%"]

    INPUT --> CLAIMS["Extract Claims<br/>splitSentences → classifySentence"]
    CLAIMS --> UNVERIFIED["Count unverified claims<br/>−3% each (cap −15%)"]

    INPUT --> QUERY{"userQuery\nprovided?"}
    QUERY -->|Yes| QA["Query Analysis"]
    QA --> REL["Relevance Score<br/>< 25% → −8%"]
    QA --> SCOPE["Scope Creep<br/>> 10x ratio → −4%"]
    QA --> DANGER["Dangerous + No Refusal<br/>→ −10%"]
    QA --> MATCH["Good Match<br/>> 50% → +3%"]

    PENALTY --> CALC["confidence = 0.82 + bonus − penalty"]
    BONUS --> CALC
    SHORT --> CALC
    UNVERIFIED --> CALC
    REL --> CALC
    SCOPE --> CALC
    DANGER --> CALC
    MATCH --> CALC

    CALC --> CLAMP["Clamp to 0.0 – 1.0"]
    CLAMP --> DECISION{"Decision"}
    DECISION -->|"≥ 0.75"| DELIVER["✅ deliver"]
    DECISION -->|"0.45–0.74"| FLAG["⚠️ flag"]
    DECISION -->|"< 0.45"| ESCALATE["🔴 escalate"]

    style DELIVER fill:#0a2e20,stroke:#1db99a,color:#1db99a
    style FLAG fill:#2a1f0a,stroke:#f5a623,color:#f5a623
    style ESCALATE fill:#2a0a0a,stroke:#ff5c5c,color:#ff5c5c
```

---

## Wikipedia Verification Pipeline

```mermaid
sequenceDiagram
    participant SE as scoreTextWithVerification()
    participant CE as extractClaims()
    participant WV as verifyAllClaims()
    participant WK as Wikipedia REST API

    SE->>CE: Extract claims from text
    CE-->>SE: claims[] (claim + disclaimer types)
    SE->>WV: Verify all claims (parallel)

    loop Each claim (with timeout)
        WV->>WK: GET /wiki/summary/{topic}
        WK-->>WV: Summary text
        WV->>WV: Compare claim vs Wikipedia
    end

    WV-->>SE: verifiedClaims[]
    Note over SE: Recalculate confidence
    Note over SE: verified: +2% each (cap +10%)
    Note over SE: contradicted: −8% each (cap −20%)
    Note over SE: unverified: −3% each (cap −15%)
```

---

## Page Context Scraping → System Prompt

```mermaid
flowchart LR
    subgraph WIDGET["Widget (Client Side)"]
        W1["Read document.title"]
        W2["Read meta tags"]
        W3["Read h1–h3 headings"]
        W4["Clone body → strip scripts/styles"]
        W5["Truncate to 3000 chars"]
    end

    W1 --> PC["pageContext object"]
    W2 --> PC
    W3 --> PC
    W4 --> PC
    W5 --> PC

    PC -->|"POST /api/chat"| BSP["buildSystemPrompt()"]

    BSP --> PROMPT["System Prompt:\n---WEBSITE CONTEXT---\nTitle: ...\nURL: ...\nHeadings: ...\nBody: ...\n---END---\nAdditional: custom prompt"]

    PROMPT --> CLAUDE["Claude API<br/>messages.create()"]

    style WIDGET fill:#081420,stroke:#1e3050,color:#e2edf8
```

---

## SSE Real-Time Dashboard

```mermaid
sequenceDiagram
    participant Dash as Dashboard (browser)
    participant Server as Express Server
    participant Client as Any API client

    Dash->>Server: GET /api/events?key=xxx
    Server-->>Dash: SSE connection opened

    Client->>Server: POST /api/check
    Server->>Server: Score response
    Server->>Server: store.logs.push(record)
    Server->>Dash: SSE: data: {record}
    Dash->>Dash: Render new row in feed
```

---

## Request Rate Limits

| Endpoint | Limit | Window | Tracking |
|---|---|---|---|
| `/api/demo-check` | 5 requests | Per hour | Per IP |
| `/api/demo-chat` | 10 requests | Per hour | Per IP |
| `/api/check` | Unlimited | — | Per API key |
| `/api/chat` | Unlimited | — | Per API key |
| `/api/signup` | Unlimited | — | Idempotent per email |

---

## Technology Stack

| Layer | Technology |
|---|---|
| **Runtime** | Node.js |
| **Framework** | Express.js |
| **Database** | PostgreSQL (Railway) / In-memory fallback |
| **AI** | Anthropic Claude (claude-sonnet-4-5-20250929) |
| **Verification** | Wikipedia REST API |
| **Hosting** | Railway (Nixpacks builder) |
| **Frontend** | Vanilla HTML/CSS/JS (no framework) |
| **SDK** | UMD module (browser + Node.js) |
| **MCP** | @modelcontextprotocol/sdk |

---

## File Structure

```
guardrail-mvp/
├── server.js           # Express app, routes, scoring engine (~1060 lines)
├── db.js               # PostgreSQL + in-memory DB layer
├── init_db.js           # Schema creation + migration script
├── wikipedia.js         # Claim verification against Wikipedia
├── sdk/
│   └── guardrail.js     # Browser/Node SDK (UMD)
├── public/
│   ├── index.html       # Landing page
│   ├── docs.html        # API reference
│   ├── playground.html  # Interactive scorer
│   ├── chat.html        # Claude chat demo
│   ├── developer.html   # Developer portal
│   ├── dashboard.html   # Real-time SSE feed
│   ├── embed/
│   │   └── widget.js    # Embeddable chat widget
│   └── ...              # Guides, blog posts
├── mcp/
│   └── server.js        # MCP server for Claude Desktop
├── docs/
│   ├── architecture_customer.md   # Customer architecture doc
│   ├── architecture_internal.md   # This file
│   └── widget_site_context.md     # Widget scraping docs
├── data/
│   └── keys.json        # Local key store (dev/test)
└── server.test.js       # 162 tests
```
