'use strict';
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
const PORT = process.env.PORT || 3001;

// ── Master key (set GUARDRAIL_MASTER_KEY in .env) ─────────────────────────────
const MASTER_KEY = process.env.GUARDRAIL_MASTER_KEY || 'gr_master_changeme';

// ── In-memory API key store ───────────────────────────────────────────────────
// Map<key, { email, label, created, requests, decisions }>
const apiKeys = new Map();

function createKey(email, label) {
    const key = 'gr_live_' + uuidv4().replace(/-/g, '');
    apiKeys.set(key, {
        email: email || null,
        label: label || email || 'unnamed',
        created: new Date().toISOString(),
        requests: 0,
        decisions: { deliver: 0, flag: 0, escalate: 0 }
    });
    return key;
}

// ── In-memory event/log store ─────────────────────────────────────────────────
const store = { logs: [], clients: [], stats: { total: 0, deliver: 0, flag: 0, escalate: 0 } };

function broadcast(data) {
    store.clients.forEach(res => {
        try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch (_) { }
    });
}

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
// SDK is NOT served publicly anymore — users install via npm
// app.use('/sdk', express.static(path.join(__dirname, 'sdk')));

/** Validate a regular API key OR master key. */
function requireKey(req, res, next) {
    const key = req.headers['x-guardrail-key'] || req.query.key;
    if (!key) {
        return res.status(401).json({ error: 'API key required. Set X-Guardrail-Key header.' });
    }
    // Master key is always valid
    if (key === MASTER_KEY) {
        req.guardrailKey = key;
        req.isMaster = true;
        return next();
    }
    const entry = apiKeys.get(key);
    if (!entry) {
        return res.status(401).json({ error: 'Invalid or revoked API key.' });
    }
    entry.requests++;
    req.guardrailKey = key;
    next();
}

/** Validate the master admin key. */
function requireMasterKey(req, res, next) {
    const key = req.headers['x-guardrail-key'] || req.query.key;
    if (key !== MASTER_KEY) {
        return res.status(401).json({ error: 'Master key required.' });
    }
    next();
}

// ── Confidence Scoring Engine ─────────────────────────────────────────────────
const UNCERTAINTY_SIGNALS = [
    /\b(i (don'?t|do not) know|not sure|unclear|uncertain|i'm not certain|cannot say|hard to say)\b/i,
    /\b(might|maybe|perhaps|possibly|could be|it depends|i think|i believe|i guess)\b/i,
    /\b(no information|not sure|no data|limited information|beyond my knowledge)\b/i,
    /\?{2,}/, // multiple question marks
];

const CONTRADICTION_SIGNALS = [
    /\b(however|but|on the other hand|contradicts|contrary to|although|yet)\b/i,
    /\b(actually|in fact|wait|correction|let me correct)\b/i,
];

const HIGH_STAKES_PATTERNS = {
    medical: /\b(diagnosis|prescri|dosage|medication|treatment|symptom|disease|drug|surgery)\b/i,
    legal: /\b(lawsuit|liability|legal advice|contract|court|attorney|regulation|compliance)\b/i,
    financial: /\b(invest|portfolio|tax advice|financial advice|trade|stock|fund|pension)\b/i,
    safety: /\b(danger|hazard|risk|emergency|explosion|toxic|harmful|fatal)\b/i,
    security: /\b(password|credential|exploit|vulnerability|hack|breach|malware)\b/i,
};

const FRUSTRATION_SIGNALS = [
    /\b(wrong|incorrect|mistake|error|that's not right|you're wrong|bad answer|useless)\b/i,
    /\b(again|still|keep|repeatedly|always does this|never works)\b/i,
    /!{2,}|:{2,}/,
];

const HALLUCINATION_SIGNALS = [
    /\b(as of my (knowledge|training)|my (knowledge|training) (cutoff|date))\b/i,
    /\b([A-Z][a-z]+ [A-Z][a-z]+), (born|died) in \d{4}\b/,
    /\b(exact(ly)? \$?\d[\d,.]* (billion|million|thousand))\b/i,
    /\b(studies show|research (shows|suggests|proves)|experts say)\b/i,
];

const CONTEXT_RISK = {
    medical: 0.30, legal: 0.30, financial: 0.25,
    safety: 0.35, security: 0.30, general: 0.00,
};

function scoreText(text, context) {
    const reasons = [];
    let confidencePenalty = 0;

    let uncertaintyHits = 0;
    UNCERTAINTY_SIGNALS.forEach(pat => { if (pat.test(text)) uncertaintyHits++; });
    if (uncertaintyHits > 0) {
        confidencePenalty += 0.18 * uncertaintyHits;
        reasons.push(`Uncertainty language detected (${uncertaintyHits} signal${uncertaintyHits > 1 ? 's' : ''})`);
    }

    let contradictionHits = 0;
    CONTRADICTION_SIGNALS.forEach(pat => { if (pat.test(text)) contradictionHits++; });
    if (contradictionHits > 1) {
        confidencePenalty += 0.12 * contradictionHits;
        reasons.push('Potential contradictions in response');
    }

    let hallHits = 0;
    HALLUCINATION_SIGNALS.forEach(pat => { if (pat.test(text)) hallHits++; });
    if (hallHits > 0) {
        confidencePenalty += 0.15 * hallHits;
        reasons.push(`Hallucination risk patterns (${hallHits} detected)`);
    }

    let frustHits = 0;
    FRUSTRATION_SIGNALS.forEach(pat => { if (pat.test(text)) frustHits++; });
    if (frustHits > 0) {
        confidencePenalty += 0.10 * frustHits;
        reasons.push('User frustration signals present');
    }

    const domainRisk = CONTEXT_RISK[context] || 0;
    if (domainRisk > 0) {
        confidencePenalty += domainRisk;
        reasons.push(`High-stakes domain: ${context}`);
    }
    const ctx = context || 'general';
    if (HIGH_STAKES_PATTERNS[ctx] && HIGH_STAKES_PATTERNS[ctx].test(text)) {
        confidencePenalty += 0.15;
        reasons.push(`Domain-specific risk content detected (${ctx})`);
    }

    if (text.split(' ').length < 15 && domainRisk > 0) {
        confidencePenalty += 0.10;
        reasons.push('Unusually brief response for high-stakes context');
    }

    if (/[A-Z]{5,}/.test(text) || /[!?]{3,}/.test(text)) {
        confidencePenalty += 0.08;
        reasons.push('Unusual formatting detected');
    }

    const confidence = Math.max(0, Math.min(1, 1 - confidencePenalty));
    let decision;
    if (confidence >= 0.75) decision = 'deliver';
    else if (confidence >= 0.45) decision = 'flag';
    else decision = 'escalate';

    return { confidence: parseFloat(confidence.toFixed(3)), decision, reasons };
}

// ── Anthropic client ──────────────────────────────────────────────────────────
function getAnthropic() {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key || key === 'your-key-here') return null;
    return new Anthropic({ apiKey: key });
}

// ── Public Signup ─────────────────────────────────────────────────────────────

// POST /api/signup — self-serve key generation
app.post('/api/signup', (req, res) => {
    const { email } = req.body || {};
    if (!email || !email.includes('@')) {
        return res.status(400).json({ error: 'Valid email is required.' });
    }
    // Check if email already has a key
    for (const [k, v] of apiKeys.entries()) {
        if (v.email === email.toLowerCase().trim()) {
            return res.json({ key: k, email: v.email, created: v.created, existed: true });
        }
    }
    const key = createKey(email.toLowerCase().trim());
    const entry = apiKeys.get(key);
    console.log(`[signup] New key created for ${email}: ${key}`);
    res.json({ key, email: entry.email, created: entry.created, existed: false });
});

// GET /api/developer/me — per-key stats (self-serve)
app.get('/api/developer/me', requireKey, (req, res) => {
    if (req.isMaster) {
        return res.json({ email: 'admin', key: MASTER_KEY, requests: store.stats.total, decisions: store.stats, created: 'N/A' });
    }
    const entry = apiKeys.get(req.guardrailKey);
    const myLogs = store.logs.filter(l => l.apiKey === req.guardrailKey).slice(0, 100);
    res.json({
        email: entry.email,
        key: req.guardrailKey,
        created: entry.created,
        requests: entry.requests,
        decisions: entry.decisions,
        recentLogs: myLogs
    });
});

// ── Key Management Routes (master-key protected) ──────────────────────────────

// POST /api/keys — generate a new API key (admin)
app.post('/api/keys', requireMasterKey, (req, res) => {
    const { label, email } = req.body || {};
    const key = createKey(email, label);
    res.json({ key, label: label || 'unnamed', created: apiKeys.get(key).created });
});

// GET /api/keys — list all keys
app.get('/api/keys', requireMasterKey, (req, res) => {
    const list = [];
    apiKeys.forEach((val, key) => list.push({ key, ...val }));
    res.json(list);
});

// DELETE /api/keys/:key — revoke a key
app.delete('/api/keys/:key', requireMasterKey, (req, res) => {
    const { key } = req.params;
    if (!apiKeys.has(key)) return res.status(404).json({ error: 'Key not found' });
    apiKeys.delete(key);
    res.json({ revoked: key });
});

// ── Protected API Routes ──────────────────────────────────────────────────────

// POST /api/chat — call Claude then score
app.post('/api/chat', requireKey, async (req, res) => {
    const { message, context, userId, systemPrompt } = req.body;
    if (!message) return res.status(400).json({ error: 'message is required' });

    const anthropic = getAnthropic();
    if (!anthropic) {
        return res.status(503).json({ error: 'ANTHROPIC_API_KEY not configured on server.' });
    }

    try {
        const response = await anthropic.messages.create({
            model: 'claude-sonnet-4-5-20250929',
            max_tokens: 1024,
            system: systemPrompt || 'You are a helpful assistant. Answer questions directly and honestly.',
            messages: [{ role: 'user', content: message }],
        });
        const aiText = response.content[0].text;

        const scored = scoreText(aiText, context || 'general');
        const record = {
            id: uuidv4(),
            timestamp: new Date().toISOString(),
            text: aiText.substring(0, 300),
            context: context || 'general',
            userId: userId || 'anonymous',
            userMessage: message.substring(0, 200),
            model: 'claude-3-5-sonnet-20241022',
            inputTokens: response.usage.input_tokens,
            outputTokens: response.usage.output_tokens,
            ...scored
        };

        store.logs.unshift(record);
        if (store.logs.length > 500) store.logs.pop();
        store.stats.total++;
        store.stats[record.decision]++;
        broadcast(record);

        res.json({ ...record, fullText: aiText });
    } catch (err) {
        console.error('Anthropic error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// POST /api/check — main scoring endpoint
app.post('/api/check', requireKey, (req, res) => {
    const { text, context, userId, metadata } = req.body;
    if (!text) return res.status(400).json({ error: 'text is required' });

    const scored = scoreText(text, context || 'general');
    const record = {
        id: uuidv4(),
        timestamp: new Date().toISOString(),
        text: text.substring(0, 300),
        context: context || 'general',
        userId: userId || 'anonymous',
        metadata: metadata || {},
        apiKey: req.guardrailKey,
        ...scored
    };

    store.logs.unshift(record);
    if (store.logs.length > 500) store.logs.pop();
    store.stats.total++;
    store.stats[record.decision]++;
    // Per-key decision tracking
    if (!req.isMaster) {
        const entry = apiKeys.get(req.guardrailKey);
        if (entry) entry.decisions[record.decision]++;
    }
    broadcast(record);

    res.json(record);
});

// GET /api/logs — recent decisions
app.get('/api/logs', requireKey, (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    res.json(store.logs.slice(0, limit));
});

// GET /api/stats — aggregate counters
app.get('/api/stats', requireKey, (req, res) => {
    const { total, deliver, flag, escalate } = store.stats;
    res.json({
        total, deliver, flag, escalate,
        deliverRate: total ? parseFloat((deliver / total * 100).toFixed(1)) : 0,
        flagRate: total ? parseFloat((flag / total * 100).toFixed(1)) : 0,
        escalateRate: total ? parseFloat((escalate / total * 100).toFixed(1)) : 0,
    });
});

// GET /api/events — SSE stream (key validated via query param)
app.get('/api/events', requireKey, (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders();
    res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);
    store.clients.push(res);
    req.on('close', () => { store.clients = store.clients.filter(c => c !== res); });
});

// Health check (public)
app.get('/api/health', (req, res) => res.json({ status: 'ok', version: '2.0.0' }));

// Only start listening when run directly (not in tests)
if (require.main === module) {
    app.listen(PORT, () => {
        const hasAnthropicKey = process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY !== 'your-key-here';
        console.log(`\n🛡️  Guardrail API v2.0.0 running at http://localhost:${PORT}\n`);
        console.log(`   Dashboard  → http://localhost:${PORT}/dashboard.html`);
        console.log(`   Developer  → http://localhost:${PORT}/developer.html`);
        console.log(`   Health     → http://localhost:${PORT}/api/health`);
        console.log(`\n   Master Key → ${MASTER_KEY}`);
        console.log(`   Anthropic  → ${hasAnthropicKey ? '✅ loaded' : '❌ missing ANTHROPIC_API_KEY'}\n`);
    });
}

module.exports = app;

