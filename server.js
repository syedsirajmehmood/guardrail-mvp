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

// ── Persistent API key store ──────────────────────────────────────────────────
// Keys persist in data/keys.json so they survive Railway redeploys
const fs = require('fs');
const DATA_DIR = path.join(__dirname, 'data');
const KEYS_FILE = path.join(DATA_DIR, 'keys.json');

const apiKeys = new Map();

function saveKeys() {
    try {
        if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
        const obj = {};
        apiKeys.forEach((v, k) => { obj[k] = v; });
        fs.writeFileSync(KEYS_FILE, JSON.stringify(obj, null, 2));
    } catch (e) { console.error('[keys] save failed:', e.message); }
}

function loadKeys() {
    try {
        if (fs.existsSync(KEYS_FILE)) {
            const obj = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8'));
            for (const [k, v] of Object.entries(obj)) apiKeys.set(k, v);
            console.log(`[keys] Loaded ${apiKeys.size} keys from disk`);
        }
    } catch (e) { console.error('[keys] load failed:', e.message); }
}
loadKeys();

function createKey(email, label) {
    const key = 'gr_live_' + uuidv4().replace(/-/g, '');
    apiKeys.set(key, {
        email: email || null,
        label: label || email || 'unnamed',
        created: new Date().toISOString(),
        requests: 0,
        decisions: { deliver: 0, flag: 0, escalate: 0 }
    });
    saveKeys();
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
// Prevent browsers caching HTML — ensures fresh JS after every Railway deploy
app.use((req, res, next) => {
    if (req.path.endsWith('.html') || req.path === '/') {
        res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
    next();
});
app.use(express.static(path.join(__dirname, 'public')));
// Serve SDK and embed widget publicly
app.use('/sdk', express.static(path.join(__dirname, 'sdk')));
app.use('/embed', express.static(path.join(__dirname, 'public/embed')));

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

// ── Confidence Scoring Engine v2 ──────────────────────────────────────────────
// Redesigned: text must EARN confidence (base ~0.82), not start at 100%.

// --- Signal patterns ---
const UNCERTAINTY_SIGNALS = [
    { pat: /\b(i (don'?t|do not) know|not sure|unclear|uncertain|i'm not certain|cannot say|hard to say)\b/i, weight: 0.18, label: 'Uncertainty language' },
    { pat: /\b(might|maybe|perhaps|possibly|could be|it depends|i think|i believe|i guess)\b/i, weight: 0.12, label: 'Hedged language' },
    { pat: /\b(no information|no data|limited information|beyond my knowledge)\b/i, weight: 0.18, label: 'Knowledge gap admission' },
    { pat: /\?{2,}/, weight: 0.08, label: 'Excessive question marks' },
];

const KNOWLEDGE_CUTOFF_SIGNALS = [
    { pat: /\b(as of my (knowledge|training|last)( cutoff| update)?|my (knowledge|training) (cutoff|date|only goes))\b/i, weight: 0.20, label: 'Knowledge cutoff disclaimer' },
    { pat: /\b(i (don'?t|do not|cannot|can't) have access to (real[- ]time|current|live|latest))\b/i, weight: 0.22, label: 'No real-time access disclaimer' },
    { pat: /\b(i (can'?t|cannot|don'?t) (browse|search|access) (the )?(internet|web|real[- ]time))\b/i, weight: 0.22, label: 'Cannot browse internet' },
    { pat: /\b(my (information|data|knowledge) (may|might|could) (be|not be) (up to date|current|accurate|outdated))\b/i, weight: 0.18, label: 'Outdated information warning' },
    { pat: /\b(i (don'?t|do not) have (access|the ability) to)\b/i, weight: 0.15, label: 'Capability limitation' },
    { pat: /\b(i (should note|must note|want to clarify) that i)\b/i, weight: 0.08, label: 'Model self-reference' },
];

const CONTRADICTION_SIGNALS = [
    { pat: /\b(actually|in fact|wait|correction|let me correct|i made an error)\b/i, weight: 0.14, label: 'Self-correction' },
];

const EVASION_SIGNALS = [
    { pat: /\b(i'?m (just )?an? (ai|language model|assistant|chatbot)|as an ai)\b/i, weight: 0.10, label: 'AI identity deflection' },
    { pat: /\b(you should (consult|speak to|ask|see|contact) (a|an|your) (doctor|lawyer|financial|professional|expert|specialist))\b/i, weight: 0.08, label: 'Professional referral deflection' },
    { pat: /\b(this is not (medical|legal|financial) advice)\b/i, weight: 0.06, label: 'Not-advice disclaimer' },
];

const HALLUCINATION_SIGNALS = [
    { pat: /\b([A-Z][a-z]+ [A-Z][a-z]+), (born|died|founded) in \d{4}\b/, weight: 0.12, label: 'Unverifiable biographical claim' },
    { pat: /\b(exact(ly)? \$?\d[\d,.]* (billion|million|thousand))\b/i, weight: 0.10, label: 'Suspiciously precise number' },
    { pat: /\b(studies show|research (shows|suggests|proves)|experts say|according to experts)\b/i, weight: 0.10, label: 'Unattributed authority claim' },
];

const FRUSTRATION_SIGNALS = [
    { pat: /\b(wrong|incorrect|mistake|error|that's not right|you're wrong|bad answer|useless)\b/i, weight: 0.10, label: 'User frustration' },
    { pat: /!{2,}|:{2,}/, weight: 0.06, label: 'Aggressive punctuation' },
];

const HIGH_STAKES_PATTERNS = {
    medical: /\b(diagnosis|prescri|dosage|medication|treatment|symptom|disease|drug|surgery|patient)\b/i,
    legal: /\b(lawsuit|liability|legal advice|contract|court|attorney|regulation|compliance|statute)\b/i,
    financial: /\b(invest|portfolio|tax advice|financial advice|trade|stock|fund|pension|fiduciary)\b/i,
    safety: /\b(danger|hazard|risk|emergency|explosion|toxic|harmful|fatal|lethal)\b/i,
    security: /\b(password|credential|exploit|vulnerability|hack|breach|malware|phishing|encryption)\b/i,
};

const CONTEXT_RISK = {
    medical: 0.25, legal: 0.25, financial: 0.20,
    safety: 0.30, security: 0.25, general: 0.00,
};

// --- Auto-context detection ---
function detectContext(text) {
    const scores = {};
    for (const [domain, pat] of Object.entries(HIGH_STAKES_PATTERNS)) {
        const matches = text.match(new RegExp(pat, 'gi'));
        if (matches) scores[domain] = matches.length;
    }
    if (Object.keys(scores).length === 0) return null;
    return Object.entries(scores).sort((a, b) => b[1] - a[1])[0][0];
}

// --- Specificity & quality scoring ---
function assessQuality(text) {
    const wordCount = text.split(/\s+/).filter(Boolean).length;
    let qualityBonus = 0;
    const qualitySignals = [];

    const numbers = (text.match(/\b\d[\d,.]*\b/g) || []).length;
    const urls = (text.match(/https?:\/\/\S+/g) || []).length;
    const codeBlocks = (text.match(/```[\s\S]*?```|`[^`]+`/g) || []).length;
    const properNouns = (text.match(/\b[A-Z][a-z]{2,}\b/g) || []).length;

    if (numbers >= 2) { qualityBonus += 0.03; qualitySignals.push('Contains specific numbers'); }
    if (urls >= 1) { qualityBonus += 0.03; qualitySignals.push('Contains URLs/references'); }
    if (codeBlocks >= 1) { qualityBonus += 0.04; qualitySignals.push('Contains code examples'); }
    if (properNouns >= 3) { qualityBonus += 0.02; qualitySignals.push('Contains proper nouns'); }

    const hasBullets = /^[\s]*[-*]\s/m.test(text);
    const hasNumberedList = /^[\s]*\d+[.)]\s/m.test(text);
    const hasHeadings = /^#{1,3}\s/m.test(text);

    if (hasBullets || hasNumberedList) { qualityBonus += 0.02; qualitySignals.push('Well-structured (lists)'); }
    if (hasHeadings) { qualityBonus += 0.02; qualitySignals.push('Well-structured (headings)'); }

    let shortPenalty = 0;
    if (wordCount < 10) { shortPenalty = 0.12; qualitySignals.push('Extremely brief response'); }
    else if (wordCount < 25) { shortPenalty = 0.06; qualitySignals.push('Brief response'); }

    return { qualityBonus: Math.min(qualityBonus, 0.10), shortPenalty, qualitySignals };
}

// --- Main scoring function ---
function scoreText(text, context) {
    const excerpts = [];
    let totalPenalty = 0;

    function scanSignals(signals) {
        signals.forEach(function(s) {
            var match = text.match(s.pat);
            if (match) {
                totalPenalty += s.weight;
                excerpts.push({ signal: s.label, text: match[0], impact: -s.weight });
            }
        });
    }

    scanSignals(UNCERTAINTY_SIGNALS);
    scanSignals(KNOWLEDGE_CUTOFF_SIGNALS);
    scanSignals(CONTRADICTION_SIGNALS);
    scanSignals(EVASION_SIGNALS);
    scanSignals(HALLUCINATION_SIGNALS);
    scanSignals(FRUSTRATION_SIGNALS);

    // Auto-context: detect domain even if user selected "general"
    const autoContext = detectContext(text);
    const effectiveContext = (context === 'general' && autoContext) ? autoContext : (context || 'general');
    if (autoContext && context === 'general') {
        excerpts.push({
            signal: 'Auto-detected domain: ' + autoContext,
            text: 'Text contains ' + autoContext + '-related terminology',
            impact: -(CONTEXT_RISK[autoContext] || 0),
        });
    }

    const domainRisk = CONTEXT_RISK[effectiveContext] || 0;
    if (domainRisk > 0) totalPenalty += domainRisk;

    if (HIGH_STAKES_PATTERNS[effectiveContext] && HIGH_STAKES_PATTERNS[effectiveContext].test(text)) {
        totalPenalty += 0.10;
        excerpts.push({
            signal: 'High-stakes ' + effectiveContext + ' content',
            text: (text.match(HIGH_STAKES_PATTERNS[effectiveContext]) || [''])[0],
            impact: -0.10,
        });
    }

    if (/[A-Z]{5,}/.test(text) || /[!?]{3,}/.test(text)) {
        totalPenalty += 0.06;
        excerpts.push({ signal: 'Unusual formatting', text: (text.match(/[A-Z]{5,}|[!?]{3,}/) || [''])[0], impact: -0.06 });
    }

    const quality = assessQuality(text);
    totalPenalty += quality.shortPenalty;
    if (quality.shortPenalty > 0) {
        excerpts.push({ signal: quality.qualitySignals[0] || 'Brief response', text: text.split(/\s+/).length + ' words', impact: -quality.shortPenalty });
    }

    // Base score: 0.82 — text must earn confidence through quality signals
    const baseScore = 0.82 + quality.qualityBonus;
    const confidence = Math.max(0, Math.min(1, baseScore - totalPenalty));

    var decision;
    if (confidence >= 0.75) decision = 'deliver';
    else if (confidence >= 0.45) decision = 'flag';
    else decision = 'escalate';

    const reasons = excerpts.map(function(e) { return e.signal; });

    return {
        confidence: parseFloat(confidence.toFixed(3)),
        decision,
        reasons,
        excerpts,
        detectedContext: autoContext,
        effectiveContext: effectiveContext,
    };
}


// ── Anthropic client ──────────────────────────────────────────────────────────
// Pass overrideKey to use the caller's own Anthropic key (their tokens, not ours)
function getAnthropic(overrideKey) {
    const key = overrideKey || process.env.ANTHROPIC_API_KEY;
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
    saveKeys();
    res.json({ revoked: key });
});

// ── Protected API Routes ──────────────────────────────────────────────────────

// POST /api/chat — call Claude then score
app.post('/api/chat', requireKey, async (req, res) => {
    const { message, context, userId, systemPrompt, anthropicKey } = req.body;
    if (!message) return res.status(400).json({ error: 'message is required' });

    // Use caller's own Anthropic key if provided, else fall back to server key
    const anthropic = getAnthropic(anthropicKey);
    if (!anthropic) {
        return res.status(503).json({
            error: 'No Anthropic API key available. Add your sk-ant- key in the chat sidebar or set ANTHROPIC_API_KEY on the server.'
        });
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

// MCP server download (public endpoint)
app.get('/api/mcp-download', (req, res) => {
    const mcpPath = require('path').join(__dirname, 'mcp', 'server.js');
    if (!require('fs').existsSync(mcpPath)) {
        return res.status(404).json({ error: 'MCP server file not found' });
    }
    res.setHeader('Content-Disposition', 'attachment; filename="guardrail-mcp-server.js"');
    res.setHeader('Content-Type', 'application/javascript');
    res.sendFile(mcpPath);
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

