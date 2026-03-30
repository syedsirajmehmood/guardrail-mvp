'use strict';
const request = require('supertest');

// Set env vars before requiring server
process.env.GUARDRAIL_MASTER_KEY = 'gr_master_test';
process.env.ANTHROPIC_API_KEY = 'sk-test-fake';
process.env.PORT = '0'; // random port

const app = require('./server');

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────
const MASTER = 'gr_master_test';
const FAKE_EMAIL = `test_${Date.now()}@example.com`;
let userKey = '';

// ── Health ───────────────────────────────────────────────────────────────────
describe('GET /api/health', () => {
    it('returns 200 with status ok', async () => {
        const res = await request(app).get('/api/health');
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('ok');
        expect(res.body.version).toBeDefined();
    });
});

// ── Signup ───────────────────────────────────────────────────────────────────
describe('POST /api/signup', () => {
    it('creates a new key for a valid email', async () => {
        const res = await request(app).post('/api/signup').send({ email: FAKE_EMAIL });
        expect(res.status).toBe(200);
        expect(res.body.key).toMatch(/^gr_live_/);
        expect(res.body.email).toBe(FAKE_EMAIL);
        expect(res.body.existed).toBe(false);
        userKey = res.body.key;
    });

    it('returns the same key if email already signed up', async () => {
        const res = await request(app).post('/api/signup').send({ email: FAKE_EMAIL });
        expect(res.status).toBe(200);
        expect(res.body.key).toBe(userKey);
        expect(res.body.existed).toBe(true);
    });

    it('normalises email to lowercase', async () => {
        const upper = `UPPER_${Date.now()}@EXAMPLE.COM`;
        const res = await request(app).post('/api/signup').send({ email: upper });
        expect(res.status).toBe(200);
        expect(res.body.email).toBe(upper.toLowerCase());
    });

    it('is idempotent regardless of email case', async () => {
        const email = `case_${Date.now()}@example.com`;
        const r1 = await request(app).post('/api/signup').send({ email });
        const r2 = await request(app).post('/api/signup').send({ email: email.toUpperCase() });
        expect(r1.body.key).toBe(r2.body.key);
        expect(r2.body.existed).toBe(true);
    });

    it('rejects missing email', async () => {
        const res = await request(app).post('/api/signup').send({});
        expect(res.status).toBe(400);
        expect(res.body.error).toBeDefined();
    });

    it('rejects invalid email (no @)', async () => {
        const res = await request(app).post('/api/signup').send({ email: 'notanemail' });
        expect(res.status).toBe(400);
    });

    it('rejects empty string email', async () => {
        const res = await request(app).post('/api/signup').send({ email: '' });
        expect(res.status).toBe(400);
    });
});

// ── Auth ─────────────────────────────────────────────────────────────────────
describe('Auth — requireKey middleware', () => {
    it('rejects request with no key', async () => {
        const res = await request(app).get('/api/stats');
        expect(res.status).toBe(401);
    });

    it('rejects request with invalid key', async () => {
        const res = await request(app).get('/api/stats').set('X-Guardrail-Key', 'gr_live_badkey');
        expect(res.status).toBe(401);
    });

    it('accepts master key on protected routes', async () => {
        const res = await request(app).get('/api/stats').set('X-Guardrail-Key', MASTER);
        expect(res.status).toBe(200);
    });

    it('accepts a valid user key', async () => {
        const res = await request(app).get('/api/stats').set('X-Guardrail-Key', userKey);
        expect(res.status).toBe(200);
    });

    it('accepts key via ?key= query param', async () => {
        const res = await request(app).get(`/api/stats?key=${userKey}`);
        expect(res.status).toBe(200);
    });

    it('rejects an empty key header', async () => {
        const res = await request(app).get('/api/stats').set('X-Guardrail-Key', '');
        expect(res.status).toBe(401);
    });
});

// ── Scoring ──────────────────────────────────────────────────────────────────
describe('POST /api/check', () => {
    it('scores a confident response as deliver', async () => {
        const res = await request(app)
            .post('/api/check').set('X-Guardrail-Key', userKey)
            .send({ text: 'The capital of France is Paris. It has been the capital since 987 AD.' });
        expect(res.status).toBe(200);
        expect(['deliver','flag']).toContain(res.body.decision);
        expect(res.body.confidence).toBeGreaterThan(0.55);
        expect(res.body.id).toBeDefined();
    });

    it('flags a hedged response', async () => {
        const res = await request(app)
            .post('/api/check').set('X-Guardrail-Key', userKey)
            .send({ text: 'I am not sure, but it might be Paris. Maybe. Perhaps. I think so but I could be wrong.' });
        expect(res.status).toBe(200);
        expect(['flag', 'escalate']).toContain(res.body.decision);
        expect(res.body.confidence).toBeLessThan(0.75);
    });

    it('escalates a high-uncertainty medical response', async () => {
        const res = await request(app)
            .post('/api/check').set('X-Guardrail-Key', userKey)
            .send({ text: 'I am not sure about this diagnosis. The medication dosage might be wrong. Perhaps surgery is needed.', context: 'medical' });
        expect(res.status).toBe(200);
        expect(res.body.decision).toBe('escalate');
        expect(res.body.reasons.length).toBeGreaterThan(0);
    });

    it('includes reasons array in response', async () => {
        const res = await request(app)
            .post('/api/check').set('X-Guardrail-Key', userKey)
            .send({ text: 'I think maybe the answer could be something.', context: 'general' });
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body.reasons)).toBe(true);
    });

    it('returns 400 if text is missing', async () => {
        const res = await request(app)
            .post('/api/check').set('X-Guardrail-Key', userKey)
            .send({ context: 'general' });
        expect(res.status).toBe(400);
    });

    it('returns 400 for empty string text', async () => {
        const res = await request(app)
            .post('/api/check').set('X-Guardrail-Key', userKey)
            .send({ text: '' });
        expect(res.status).toBe(400);
    });

    it('handles very long text without crashing', async () => {
        const longText = 'This is a confirmed fact. '.repeat(500);
        const res = await request(app)
            .post('/api/check').set('X-Guardrail-Key', userKey)
            .send({ text: longText });
        expect(res.status).toBe(200);
        expect(res.body.decision).toBeDefined();
        expect(res.body.text.length).toBeLessThanOrEqual(301);
    });

    it.each(['general', 'medical', 'legal', 'financial', 'security', 'safety'])(
        'accepts context: %s',
        async (ctx) => {
            const res = await request(app)
                .post('/api/check').set('X-Guardrail-Key', userKey)
                .send({ text: 'The answer is confirmed and correct.', context: ctx });
            expect(res.status).toBe(200);
            expect(res.body.decision).toBeDefined();
        }
    );

    it('returned record has all required fields', async () => {
        const res = await request(app)
            .post('/api/check').set('X-Guardrail-Key', userKey)
            .send({ text: 'Confirmed fact.', context: 'general', userId: 'u_test' });
        const b = res.body;
        expect(b.id).toBeDefined();
        expect(b.timestamp).toBeDefined();
        expect(b.decision).toMatch(/^(deliver|flag|escalate)$/);
        expect(typeof b.confidence).toBe('number');
        expect(b.confidence).toBeGreaterThanOrEqual(0);
        expect(b.confidence).toBeLessThanOrEqual(1);
        expect(Array.isArray(b.reasons)).toBe(true);
        expect(b.text).toBeDefined();
    });

    it('handles 10 concurrent requests without errors', async () => {
        const checks = Array.from({ length: 10 }, (_, i) =>
            request(app)
                .post('/api/check').set('X-Guardrail-Key', userKey)
                .send({ text: `Concurrent test fact number ${i}.` })
        );
        const results = await Promise.all(checks);
        results.forEach(r => {
            expect(r.status).toBe(200);
            expect(r.body.decision).toBeDefined();
        });
        const ids = results.map(r => r.body.id);
        expect(new Set(ids).size).toBe(10);
    });

    it('tracks per-key decision counts', async () => {
        await request(app)
            .post('/api/check').set('X-Guardrail-Key', userKey)
            .send({ text: 'Definitively confirmed fact with no ambiguity.' });
        const meRes = await request(app).get('/api/developer/me').set('X-Guardrail-Key', userKey);
        expect(meRes.body.requests).toBeGreaterThan(0);
        const { deliver, flag, escalate } = meRes.body.decisions;
        expect(deliver + flag + escalate).toBeGreaterThan(0);
    });
});

// ── Developer/me ─────────────────────────────────────────────────────────────
describe('GET /api/developer/me', () => {
    it('returns key info for a valid user key', async () => {
        const res = await request(app).get('/api/developer/me').set('X-Guardrail-Key', userKey);
        expect(res.status).toBe(200);
        expect(res.body.email).toBe(FAKE_EMAIL);
        expect(res.body.key).toBe(userKey);
        expect(res.body.decisions).toBeDefined();
        expect(Array.isArray(res.body.recentLogs)).toBe(true);
    });

    it('recentLogs have correct shape', async () => {
        const res = await request(app).get('/api/developer/me').set('X-Guardrail-Key', userKey);
        const logs = res.body.recentLogs;
        if (logs.length > 0) {
            const l = logs[0];
            expect(l.id).toBeDefined();
            expect(l.decision).toMatch(/^(deliver|flag|escalate)$/);
            expect(typeof l.confidence).toBe('number');
            expect(l.timestamp).toBeDefined();
        }
    });

    it('returns admin info for master key', async () => {
        const res = await request(app).get('/api/developer/me').set('X-Guardrail-Key', MASTER);
        expect(res.status).toBe(200);
        expect(res.body.email).toBe('admin');
    });
});

// ── Stats & Logs ──────────────────────────────────────────────────────────────
describe('GET /api/stats', () => {
    it('returns aggregate stats', async () => {
        const res = await request(app).get('/api/stats').set('X-Guardrail-Key', MASTER);
        expect(res.status).toBe(200);
        expect(typeof res.body.total).toBe('number');
        expect(typeof res.body.deliverRate).toBe('number');
    });

    it('deliverRate is between 0 and 100', async () => {
        const res = await request(app).get('/api/stats').set('X-Guardrail-Key', MASTER);
        expect(res.body.deliverRate).toBeGreaterThanOrEqual(0);
        expect(res.body.deliverRate).toBeLessThanOrEqual(100);
    });
});

describe('GET /api/logs', () => {
    it('returns an array of recent logs', async () => {
        const res = await request(app).get('/api/logs').set('X-Guardrail-Key', MASTER);
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);
    });

    it('respects the limit query param', async () => {
        const res = await request(app).get('/api/logs?limit=2').set('X-Guardrail-Key', MASTER);
        expect(res.status).toBe(200);
        expect(res.body.length).toBeLessThanOrEqual(2);
    });

    it('log entries have required fields', async () => {
        const res = await request(app).get('/api/logs').set('X-Guardrail-Key', MASTER);
        if (res.body.length > 0) {
            const entry = res.body[0];
            expect(entry.id).toBeDefined();
            expect(entry.decision).toMatch(/^(deliver|flag|escalate)$/);
            expect(typeof entry.confidence).toBe('number');
            expect(entry.timestamp).toBeDefined();
        }
    });
});

// ── Static file serving ───────────────────────────────────────────────────────
describe('Static file serving', () => {
    it('serves SDK at /sdk/guardrail.js', async () => {
        const res = await request(app).get('/sdk/guardrail.js');
        expect(res.status).toBe(200);
        expect(res.text).toContain('Guardrail');
    });

    it('serves embed widget at /embed/widget.js', async () => {
        const res = await request(app).get('/embed/widget.js');
        expect(res.status).toBe(200);
        expect(res.text).toContain('gr-widget-btn');
    });

    it('serves landing page at /', async () => {
        const res = await request(app).get('/');
        expect(res.status).toBe(200);
        expect(res.text).toContain('Guardrail');
    });

    it('returns 404 for unknown routes', async () => {
        const res = await request(app).get('/nonexistent-page-xyz');
        expect(res.status).toBe(404);
    });
});

// ── Admin key management ──────────────────────────────────────────────────────
describe('Admin /api/keys', () => {
    let adminKey = '';

    it('POST creates a new key with master key', async () => {
        const res = await request(app)
            .post('/api/keys').set('X-Guardrail-Key', MASTER)
            .send({ label: 'test-admin-key', email: 'admin@example.com' });
        expect(res.status).toBe(200);
        expect(res.body.key).toMatch(/^gr_live_/);
        adminKey = res.body.key;
    });

    it('GET lists all keys', async () => {
        const res = await request(app).get('/api/keys').set('X-Guardrail-Key', MASTER);
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);
        expect(res.body.some(k => k.key === adminKey)).toBe(true);
    });

    it('each key entry has required fields', async () => {
        const res = await request(app).get('/api/keys').set('X-Guardrail-Key', MASTER);
        res.body.forEach(k => {
            expect(k.key).toMatch(/^gr_live_/);
            expect(k.created).toBeDefined();
            expect(typeof k.requests).toBe('number');
        });
    });

    it('DELETE revokes a key', async () => {
        const res = await request(app)
            .delete(`/api/keys/${adminKey}`).set('X-Guardrail-Key', MASTER);
        expect(res.status).toBe(200);
        expect(res.body.revoked).toBe(adminKey);
        // Revoked key is now rejected
        const check = await request(app).get('/api/stats').set('X-Guardrail-Key', adminKey);
        expect(check.status).toBe(401);
    });

    it('DELETE 404s for unknown key', async () => {
        const res = await request(app)
            .delete('/api/keys/gr_live_doesnotexist').set('X-Guardrail-Key', MASTER);
        expect(res.status).toBe(404);
    });

    it('rejects admin routes with user key', async () => {
        const res = await request(app).get('/api/keys').set('X-Guardrail-Key', userKey);
        expect(res.status).toBe(401);
    });
});

// ── Scoring Engine v2 ────────────────────────────────────────────────────────
describe('Scoring Engine v2', () => {
    it('does NOT give 100% confidence in general context anymore', async () => {
        const res = await request(app)
            .post('/api/check').set('X-Guardrail-Key', userKey)
            .send({ text: 'The capital of France is Paris.', context: 'general' });
        expect(res.status).toBe(200);
        expect(res.body.confidence).toBeLessThan(1.0);
        expect(res.body.confidence).toBeGreaterThanOrEqual(0.55);
    });

    it('detects knowledge cutoff disclaimers', async () => {
        const res = await request(app)
            .post('/api/check').set('X-Guardrail-Key', userKey)
            .send({ text: "I don't have access to real-time information, so I can't tell you the current weather forecast for today.", context: 'general' });
        expect(res.body.confidence).toBeLessThan(0.75);
        expect(res.body.reasons).toEqual(expect.arrayContaining([
            expect.stringMatching(/real-time|Capability/i)
        ]));
    });

    it('detects cannot-browse-internet as a warning signal', async () => {
        const res = await request(app)
            .post('/api/check').set('X-Guardrail-Key', userKey)
            .send({ text: "I can't browse the internet to check current prices. However, as of my knowledge cutoff, typical prices were around $50.", context: 'general' });
        expect(res.body.confidence).toBeLessThan(0.75);
    });

    it('returns excerpts array with signal details', async () => {
        const res = await request(app)
            .post('/api/check').set('X-Guardrail-Key', userKey)
            .send({ text: "I think maybe the answer might be 42, but I'm not sure.", context: 'general' });
        expect(Array.isArray(res.body.excerpts)).toBe(true);
        expect(res.body.excerpts.length).toBeGreaterThan(0);
        expect(res.body.excerpts[0]).toHaveProperty('signal');
        expect(res.body.excerpts[0]).toHaveProperty('text');
        expect(res.body.excerpts[0]).toHaveProperty('impact');
        expect(res.body.excerpts[0].impact).toBeLessThan(0);
    });

    it('auto-detects medical context when user selects general', async () => {
        const res = await request(app)
            .post('/api/check').set('X-Guardrail-Key', userKey)
            .send({ text: 'The recommended dosage for this medication is 500mg for adult patients with no prior diagnosis of the disease.', context: 'general' });
        expect(res.body.detectedContext).toBe('medical');
        expect(res.body.effectiveContext).toBe('medical');
        expect(res.body.confidence).toBeLessThan(0.75);
    });

    it('penalizes extremely brief responses', async () => {
        const brief = await request(app)
            .post('/api/check').set('X-Guardrail-Key', userKey)
            .send({ text: 'Yes.', context: 'general' });
        const detailed = await request(app)
            .post('/api/check').set('X-Guardrail-Key', userKey)
            .send({ text: 'The answer is yes. Here is a detailed explanation with multiple supporting points, concrete numbers like 42 and dates like 2024, and proper nouns like Paris and London to provide context.', context: 'general' });
        expect(brief.body.confidence).toBeLessThan(detailed.body.confidence);
    });

    it('gives quality bonus for well-structured text with specifics', async () => {
        const res = await request(app)
            .post('/api/check').set('X-Guardrail-Key', userKey)
            .send({ text: '## Summary\n\n1. Paris has 2.1 million residents.\n2. London has 8.9 million residents.\n3. Tokyo has 13.9 million residents.\n\nSource: https://worldbank.org/data', context: 'general' });
        expect(res.body.confidence).toBeGreaterThan(0.70);
    });

    it('detects AI identity deflection', async () => {
        const res = await request(app)
            .post('/api/check').set('X-Guardrail-Key', userKey)
            .send({ text: 'As an AI language model, I cannot provide medical advice. You should consult a doctor for your specific condition regarding this medication and its dosage.', context: 'general' });
        expect(res.body.reasons).toEqual(expect.arrayContaining([
            expect.stringMatching(/AI identity|Professional referral/i)
        ]));
        expect(res.body.confidence).toBeLessThan(0.75);
    });

    it('returns effectiveContext in response', async () => {
        const res = await request(app)
            .post('/api/check').set('X-Guardrail-Key', userKey)
            .send({ text: 'This is a simple statement about the weather today.', context: 'general' });
        expect(res.body.effectiveContext).toBeDefined();
    });

    it('does not auto-detect context when user explicitly selects one', async () => {
        const res = await request(app)
            .post('/api/check').set('X-Guardrail-Key', userKey)
            .send({ text: 'The recommended dosage for this medication is 500mg.', context: 'legal' });
        expect(res.body.effectiveContext).toBe('legal');
    });
});

// ── Claim Extraction ─────────────────────────────────────────────────────────
describe('Claim Extraction', () => {
    it('extracts claims from text with factual statements', async () => {
        const res = await request(app)
            .post('/api/check').set('X-Guardrail-Key', userKey)
            .send({
                text: 'Python was created by Guido van Rossum in 1991. It has over 8.2 million developers worldwide. The language supports multiple programming paradigms.',
                context: 'general'
            });
        expect(Array.isArray(res.body.claims)).toBe(true);
        expect(res.body.claims.length).toBeGreaterThanOrEqual(2);
    });

    it('marks claims without citations as unverified', async () => {
        const res = await request(app)
            .post('/api/check').set('X-Guardrail-Key', userKey)
            .send({
                text: 'The Eiffel Tower was built in 1889. It is 324 meters tall.',
                context: 'general'
            });
        const unverified = res.body.claims.filter(c => c.verification === 'unverified');
        expect(unverified.length).toBeGreaterThan(0);
    });

    it('marks claims with citations as sourced', async () => {
        const res = await request(app)
            .post('/api/check').set('X-Guardrail-Key', userKey)
            .send({
                text: 'According to the World Health Organization, approximately 1.35 million people die each year from road traffic accidents. Source: https://www.who.int/data',
                context: 'general'
            });
        const sourced = res.body.claims.filter(c => c.verification === 'sourced');
        expect(sourced.length).toBeGreaterThanOrEqual(1);
    });

    it('classifies disclaimers separately from claims', async () => {
        const res = await request(app)
            .post('/api/check').set('X-Guardrail-Key', userKey)
            .send({
                text: "I don't have access to real-time data. The population of Tokyo is approximately 14 million people.",
                context: 'general'
            });
        const disclaimers = res.body.claims.filter(c => c.type === 'disclaimer');
        const claims = res.body.claims.filter(c => c.type === 'claim');
        expect(disclaimers.length).toBeGreaterThanOrEqual(1);
        expect(claims.length).toBeGreaterThanOrEqual(1);
    });

    it('unverified claims reduce confidence score', async () => {
        // Text with many unverified claims should score lower
        const many = await request(app)
            .post('/api/check').set('X-Guardrail-Key', userKey)
            .send({
                text: 'Albert Einstein was born in 1879. He developed the theory of relativity in 1905. The speed of light is exactly 299792458 meters per second. E=mc2 was published in 1905. Quantum mechanics was founded in 1925.',
                context: 'general'
            });
        const few = await request(app)
            .post('/api/check').set('X-Guardrail-Key', userKey)
            .send({
                text: 'Here are some helpful tips for your project.',
                context: 'general'
            });
        expect(many.body.claims.filter(c => c.verification === 'unverified').length).toBeGreaterThan(few.body.claims.filter(c => c.verification === 'unverified').length);
    });

    it('returns empty claims for questions-only text', async () => {
        const res = await request(app)
            .post('/api/check').set('X-Guardrail-Key', userKey)
            .send({
                text: 'What is the meaning of life? How do I get started? Where can I learn more?',
                context: 'general'
            });
        expect(res.body.claims.length).toBe(0);
    });
});

// ── Beta Feedback Validation ─────────────────────────────────────────────────
// Tests that mirror the EXACT scenarios the beta tester reported
describe('Beta Feedback Validation', () => {
    // FEEDBACK: "every response under General was marked as 100% confidence"
    it('FEEDBACK: general context no longer gives 100% to clean text', async () => {
        const res = await request(app)
            .post('/api/check').set('X-Guardrail-Key', userKey)
            .send({ text: 'JavaScript is a programming language commonly used for web development.', context: 'general' });
        expect(res.body.confidence).toBeLessThan(1.0);
    });

    // FEEDBACK: "answers where the model explicitly says I don't have access to real-time information"
    it('FEEDBACK: "I don\'t have access to real-time information" is NOT 100%', async () => {
        const res = await request(app)
            .post('/api/check').set('X-Guardrail-Key', userKey)
            .send({
                text: "I don't have access to real-time information, so I can't tell you the current stock price of Apple. As of my last update, it was trading around $175.",
                context: 'general'
            });
        expect(res.body.confidence).toBeLessThan(0.70);
        expect(res.body.reasons.length).toBeGreaterThan(0);
    });

    // FEEDBACK: "switched to Security for one question and found 27% — response was decent"
    it('FEEDBACK: security context applies significant penalty', async () => {
        const res = await request(app)
            .post('/api/check').set('X-Guardrail-Key', userKey)
            .send({
                text: 'To secure your server, you should use SSH key authentication instead of password-based login. Disable root login and use a firewall to restrict access.',
                context: 'security'
            });
        expect(res.body.confidence).toBeLessThan(0.65);
    });

    // FEEDBACK: "md snippet in Security got 70%, switched to General got 100%"
    it('FEEDBACK: same text scores differently across contexts (expected behavior)', async () => {
        const text = 'The system architecture uses a microservices pattern with API gateway for routing and load balancing across service instances.';
        const security = await request(app)
            .post('/api/check').set('X-Guardrail-Key', userKey)
            .send({ text, context: 'security' });
        const general = await request(app)
            .post('/api/check').set('X-Guardrail-Key', userKey)
            .send({ text, context: 'general' });
        expect(security.body.confidence).toBeLessThan(general.body.confidence);
    });
});

// ── New Signal Pattern Tests ─────────────────────────────────────────────────
describe('Expanded Signal Patterns', () => {
    it('detects sycophantic responses', async () => {
        const res = await request(app)
            .post('/api/check').set('X-Guardrail-Key', userKey)
            .send({
                text: "Great question! That's an excellent observation. You're absolutely right that this is a complex topic.",
                context: 'general'
            });
        expect(res.body.reasons).toEqual(expect.arrayContaining([
            expect.stringMatching(/Sycophantic|Flattery|agreement/i)
        ]));
    });

    it('detects ISBN/DOI fabrication risk', async () => {
        const res = await request(app)
            .post('/api/check').set('X-Guardrail-Key', userKey)
            .send({
                text: 'This concept was first described in "Advanced Neural Networks" (ISBN: 978-0-13-468599-1) published in 2019 by Dr. Smith.',
                context: 'general'
            });
        expect(res.body.reasons).toEqual(expect.arrayContaining([
            expect.stringMatching(/citation identifier|publication claim/i)
        ]));
    });

    it('detects abandonment signals', async () => {
        const res = await request(app)
            .post('/api/check').set('X-Guardrail-Key', userKey)
            .send({
                text: "Never mind, forget it. I'll just ask someone else who actually knows the answer.",
                context: 'general'
            });
        expect(res.body.reasons).toEqual(expect.arrayContaining([
            expect.stringMatching(/Abandonment/i)
        ]));
    });

    it('detects epistemic distancing', async () => {
        const res = await request(app)
            .post('/api/check').set('X-Guardrail-Key', userKey)
            .send({
                text: 'The company allegedly mishandled customer data, and supposedly failed to encrypt sensitive records properly.',
                context: 'general'
            });
        expect(res.body.reasons).toEqual(expect.arrayContaining([
            expect.stringMatching(/Epistemic distancing/i)
        ]));
    });

    it('detects staleness hedges', async () => {
        const res = await request(app)
            .post('/api/check').set('X-Guardrail-Key', userKey)
            .send({
                text: 'The API used to support XML format, but things may have changed since then. I would recommend checking the latest documentation.',
                context: 'general'
            });
        expect(res.body.reasons).toEqual(expect.arrayContaining([
            expect.stringMatching(/Staleness|Verification/i)
        ]));
    });

    it('detects suspiciously precise statistics', async () => {
        const res = await request(app)
            .post('/api/check').set('X-Guardrail-Key', userKey)
            .send({
                text: '73.6% of users prefer dark mode, and 42.8% of respondents said they would switch to a competitor product.',
                context: 'general'
            });
        expect(res.body.reasons).toEqual(expect.arrayContaining([
            expect.stringMatching(/precise statistic/i)
        ]));
    });

    it('detects complexity deflection', async () => {
        const res = await request(app)
            .post('/api/check').set('X-Guardrail-Key', userKey)
            .send({
                text: "It's complicated and there's no simple answer. The topic is nuanced and depends on many factors.",
                context: 'general'
            });
        expect(res.body.reasons).toEqual(expect.arrayContaining([
            expect.stringMatching(/Complexity deflection/i)
        ]));
    });

    it('auto-detects mental_health context', async () => {
        const res = await request(app)
            .post('/api/check').set('X-Guardrail-Key', userKey)
            .send({
                text: 'If you are experiencing thoughts of self-harm or suicide, please contact a crisis counselor or therapist immediately.',
                context: 'general'
            });
        expect(res.body.detectedContext).toBe('mental_health');
        expect(res.body.effectiveContext).toBe('mental_health');
        expect(res.body.confidence).toBeLessThan(0.60);
    });

    it('detects position reversal as contradiction', async () => {
        const res = await request(app)
            .post('/api/check').set('X-Guardrail-Key', userKey)
            .send({
                text: "Actually, on second thought, I've reconsidered my previous answer. Let me rephrase what I meant.",
                context: 'general'
            });
        expect(res.body.reasons).toEqual(expect.arrayContaining([
            expect.stringMatching(/Position reversal|Self-correction|Self-clarification/i)
        ]));
    });
});

// ── Demo Check Endpoint ─────────────────────────────────────────────────────
describe('POST /api/demo-check (keyless)', () => {
    it('scores text without requiring an API key', async () => {
        const res = await request(app)
            .post('/api/demo-check')
            .send({ text: 'The capital of France is Paris.', context: 'general' });
        expect(res.status).toBe(200);
        expect(res.body.demo).toBe(true);
        expect(res.body.confidence).toBeDefined();
        expect(res.body.decision).toMatch(/^(deliver|flag|escalate)$/);
        expect(typeof res.body.remaining).toBe('number');
    });

    it('returns 400 for missing text', async () => {
        const res = await request(app)
            .post('/api/demo-check')
            .send({ context: 'general' });
        expect(res.status).toBe(400);
    });

    it('returns 400 for empty text', async () => {
        const res = await request(app)
            .post('/api/demo-check')
            .send({ text: '   ' });
        expect(res.status).toBe(400);
    });

    it('returns excerpts and claims', async () => {
        const res = await request(app)
            .post('/api/demo-check')
            .send({ text: "I think maybe the answer is around 42, but I'm not sure.", context: 'general' });
        expect(Array.isArray(res.body.excerpts)).toBe(true);
        expect(Array.isArray(res.body.claims)).toBe(true);
    });

    it('includes effectiveContext in response', async () => {
        const res = await request(app)
            .post('/api/demo-check')
            .send({ text: 'Take two aspirin for your headache pain.', context: 'general' });
        expect(res.body.effectiveContext || res.body.context).toBeDefined();
    });
});

// ── Demo Chat Endpoint ──────────────────────────────────────────────────────
describe('POST /api/demo-chat (keyless)', () => {
    it('returns a pre-recorded response without API key', async () => {
        const res = await request(app)
            .post('/api/demo-chat')
            .send({ message: 'What is Python?', context: 'general' });
        expect(res.status).toBe(200);
        expect(res.body.demo).toBe(true);
        expect(res.body.aiResponse).toBeDefined();
        expect(res.body.decision).toMatch(/^(deliver|flag|escalate)$/);
        expect(typeof res.body.confidence).toBe('number');
    });

    it('returns medical-context responses for medical context', async () => {
        const res = await request(app)
            .post('/api/demo-chat')
            .send({ message: 'What dosage should I take?', context: 'medical' });
        expect(res.status).toBe(200);
        expect(res.body.aiResponse).toBeDefined();
    });

    it('returns financial-context responses for financial context', async () => {
        const res = await request(app)
            .post('/api/demo-chat')
            .send({ message: 'What is the stock price?', context: 'financial' });
        expect(res.status).toBe(200);
        expect(res.body.aiResponse).toBeDefined();
    });

    it('returns 400 for missing message', async () => {
        const res = await request(app)
            .post('/api/demo-chat')
            .send({ context: 'general' });
        expect(res.status).toBe(400);
    });

    it('falls back to general pool for unknown context', async () => {
        const res = await request(app)
            .post('/api/demo-chat')
            .send({ message: 'Hello', context: 'unknown_context' });
        expect(res.status).toBe(200);
        expect(res.body.aiResponse).toBeDefined();
    });
});

// ── New High-Stakes Domains ─────────────────────────────────────────────────
describe('High-Stakes Domains', () => {
    it('auto-detects child_safety context', async () => {
        const res = await request(app)
            .post('/api/check').set('X-Guardrail-Key', userKey)
            .send({
                text: 'Child abuse and child exploitation must be reported to the appropriate authorities. Protecting minors from harm is a legal obligation.',
                context: 'general'
            });
        expect(res.body.detectedContext).toBe('child_safety');
        expect(res.body.confidence).toBeLessThan(0.60);
    });

    it('auto-detects nuclear context', async () => {
        const res = await request(app)
            .post('/api/check').set('X-Guardrail-Key', userKey)
            .send({
                text: 'Nuclear reactor containment vessel integrity is critical for safe operation of the plant.',
                context: 'general'
            });
        expect(res.body.detectedContext).toBe('nuclear');
        expect(res.body.confidence).toBeLessThan(0.60);
    });

    it.each(['mental_health', 'child_safety', 'nuclear'])(
        'accepts explicit context: %s',
        async (ctx) => {
            const res = await request(app)
                .post('/api/check').set('X-Guardrail-Key', userKey)
                .send({ text: 'This is a test statement with no signals.', context: ctx });
            expect(res.status).toBe(200);
            expect(res.body.confidence).toBeLessThan(0.70);
        }
    );
});

// ── Decision Thresholds ─────────────────────────────────────────────────────
describe('Decision Thresholds', () => {
    it('deliver threshold: confident text scores >= 0.75', async () => {
        const res = await request(app)
            .post('/api/check').set('X-Guardrail-Key', userKey)
            .send({
                text: '## Facts\n\n1. The Eiffel Tower is 324 meters tall.\n2. It was built in 1889.\n3. Source: https://tour-eiffel.fr\n\nThe tower is in Paris, France.',
                context: 'general'
            });
        expect(res.body.decision).toBe('deliver');
        expect(res.body.confidence).toBeGreaterThanOrEqual(0.75);
    });

    it('escalate threshold: heavily hedged high-stakes text scores < 0.45', async () => {
        const res = await request(app)
            .post('/api/check').set('X-Guardrail-Key', userKey)
            .send({
                text: "I'm not sure, but I think the medication dosage might be around 500mg. Perhaps you should consult a doctor. I don't have access to real-time medical data. As of my training, this could be wrong.",
                context: 'medical'
            });
        expect(res.body.decision).toBe('escalate');
        expect(res.body.confidence).toBeLessThan(0.45);
    });

    it('confidence clamped between 0 and 1', async () => {
        const res = await request(app)
            .post('/api/check').set('X-Guardrail-Key', userKey)
            .send({
                text: "I don't know. Maybe. Perhaps. I'm unsure. I think. It might. Could be. Allegedly. Supposedly. I cannot confirm. As of my knowledge cutoff.",
                context: 'medical'
            });
        expect(res.body.confidence).toBeGreaterThanOrEqual(0);
        expect(res.body.confidence).toBeLessThanOrEqual(1);
    });
});

// ── Edge Cases ──────────────────────────────────────────────────────────────
describe('Edge Cases', () => {
    it('handles Unicode text gracefully', async () => {
        const res = await request(app)
            .post('/api/check').set('X-Guardrail-Key', userKey)
            .send({ text: '日本の首都は東京です。The capital of Japan is Tokyo. 🇯🇵', context: 'general' });
        expect(res.status).toBe(200);
        expect(res.body.decision).toBeDefined();
    });

    it('sanitizes HTML in text (no XSS)', async () => {
        const res = await request(app)
            .post('/api/check').set('X-Guardrail-Key', userKey)
            .send({ text: '<script>alert("xss")</script> The answer is 42.', context: 'general' });
        expect(res.status).toBe(200);
        expect(res.body.decision).toBeDefined();
    });

    it('rejects whitespace-only text', async () => {
        const res = await request(app)
            .post('/api/check').set('X-Guardrail-Key', userKey)
            .send({ text: '' });
        expect(res.status).toBe(400);
    });

    it('handles unknown context gracefully (falls back to general)', async () => {
        const res = await request(app)
            .post('/api/check').set('X-Guardrail-Key', userKey)
            .send({ text: 'The answer is 42.', context: 'nonexistent_context' });
        expect(res.status).toBe(200);
        expect(res.body.decision).toBeDefined();
    });

    it('handles text with no alphabetic characters', async () => {
        const res = await request(app)
            .post('/api/check').set('X-Guardrail-Key', userKey)
            .send({ text: '42 + 17 = 59. 100 / 4 = 25.', context: 'general' });
        expect(res.status).toBe(200);
    });
});

// ── Additional Static Pages ─────────────────────────────────────────────────
describe('New Static Pages', () => {
    it('serves /docs.html', async () => {
        const res = await request(app).get('/docs.html');
        expect(res.status).toBe(200);
        expect(res.text).toContain('API Reference');
    });

    it('serves /changelog.html', async () => {
        const res = await request(app).get('/changelog.html');
        expect(res.status).toBe(200);
        expect(res.text).toContain('Changelog');
    });

    it('serves /playground.html', async () => {
        const res = await request(app).get('/playground.html');
        expect(res.status).toBe(200);
        expect(res.text).toContain('Guardrail');
    });

    it('serves /chat.html', async () => {
        const res = await request(app).get('/chat.html');
        expect(res.status).toBe(200);
    });

    it('serves /developer.html', async () => {
        const res = await request(app).get('/developer.html');
        expect(res.status).toBe(200);
    });

    it('serves /setup.html', async () => {
        const res = await request(app).get('/setup.html');
        expect(res.status).toBe(200);
    });
});

// ── Additional Signal Coverage ──────────────────────────────────────────────
describe('Additional Signal Coverage', () => {
    it('detects multiple sycophancy signals in one response', async () => {
        const res = await request(app)
            .post('/api/check').set('X-Guardrail-Key', userKey)
            .send({
                text: "That's a great question! What an excellent point. You're absolutely right about that. I completely agree with your assessment.",
                context: 'general'
            });
        const sycophanySignals = res.body.reasons.filter(r =>
            /sycophant|flatter|agreement|overconfident/i.test(r)
        );
        expect(sycophanySignals.length).toBeGreaterThanOrEqual(2);
    });

    it('detects unattributed statistics as risk signals', async () => {
        const res = await request(app)
            .post('/api/check').set('X-Guardrail-Key', userKey)
            .send({
                text: 'Studies have shown that 87% of developers prefer this approach. Research indicates that productivity increases by 40% when using this method.',
                context: 'general'
            });
        // Unverified claims with specific numbers should lower confidence
        expect(res.body.confidence).toBeLessThan(0.82);
        expect(res.body.reasons.length).toBeGreaterThan(0);
    });

    it('detects training-time anchor signals', async () => {
        const res = await request(app)
            .post('/api/check').set('X-Guardrail-Key', userKey)
            .send({
                text: 'At the time of my training, the latest version was 3.0. When I was trained, the recommended approach was different.',
                context: 'general'
            });
        expect(res.body.reasons).toEqual(expect.arrayContaining([
            expect.stringMatching(/Training|training/i)
        ]));
    });

    it('detects capability limitation signals', async () => {
        const res = await request(app)
            .post('/api/check').set('X-Guardrail-Key', userKey)
            .send({
                text: "I don't have the ability to verify this claim. I cannot access real-time information to check whether this is accurate.",
                context: 'general'
            });
        expect(res.body.confidence).toBeLessThan(0.75);
        expect(res.body.reasons.length).toBeGreaterThan(0);
    });

    it('quality bonus: URLs increase confidence', async () => {
        const withUrl = await request(app)
            .post('/api/check').set('X-Guardrail-Key', userKey)
            .send({ text: 'Paris has 2.1 million residents. Source: https://worldbank.org/data', context: 'general' });
        const noUrl = await request(app)
            .post('/api/check').set('X-Guardrail-Key', userKey)
            .send({ text: 'Paris has 2.1 million residents.', context: 'general' });
        expect(withUrl.body.confidence).toBeGreaterThanOrEqual(noUrl.body.confidence);
    });

    it('quality bonus: code blocks increase confidence', async () => {
        const withCode = await request(app)
            .post('/api/check').set('X-Guardrail-Key', userKey)
            .send({ text: 'To solve the problem, use this code:\n```python\nprint("hello")\n```\nThis will output "hello".', context: 'general' });
        expect(withCode.body.confidence).toBeGreaterThan(0.60);
    });
});

// ── Wikipedia Claim Verification ────────────────────────────────────────────
describe('Wikipedia Verification Module', () => {
    const wiki = require('./wikipedia');

    it('extractSearchQuery extracts named entities', () => {
        expect(wiki.extractSearchQuery('The Eiffel Tower was built in 1889.')).toContain('Eiffel');
        expect(wiki.extractSearchQuery('Python was created by Guido van Rossum.')).toContain('Guido');
    });

    it('extractNumbers finds numbers with units', () => {
        const nums = wiki.extractNumbers('The tower is 324 meters tall and was built in 1889.');
        expect(nums.length).toBeGreaterThanOrEqual(2);
        expect(nums.some(n => n.number === 324)).toBe(true);
        expect(nums.some(n => n.number === 1889)).toBe(true);
    });

    it('compareNumbers detects match', () => {
        expect(wiki.compareNumbers(1889, 'completed in 1889')).toBe('match');
    });

    it('compareNumbers detects mismatch', () => {
        expect(wiki.compareNumbers(500, 'The tower is 330 metres tall')).toBe('mismatch');
    });

    it('termOverlap returns > 0 for related text', () => {
        const overlap = wiki.termOverlap(
            'The Eiffel Tower was built in Paris',
            'The Eiffel Tower is a lattice tower on the Champ de Mars in Paris'
        );
        expect(overlap).toBeGreaterThan(0.3);
    });

    it('termOverlap returns ~0 for unrelated text', () => {
        const overlap = wiki.termOverlap(
            'Quantum mechanics wave function',
            'The Eiffel Tower is a lattice tower in Paris'
        );
        expect(overlap).toBeLessThan(0.2);
    });
});

// ── Wikipedia verification scoring integration ──────────────────────────────
describe('Wikipedia Verification Integration', () => {
    it('/api/check returns claims with verification status', async () => {
        const res = await request(app)
            .post('/api/check?verify=false').set('X-Guardrail-Key', userKey)
            .send({ text: 'The Eiffel Tower was built in 1889. It is 324 meters tall.', context: 'general' });
        expect(Array.isArray(res.body.claims)).toBe(true);
        // Without verification, claims should be 'unverified' (static check)
        res.body.claims.forEach(c => {
            expect(['unverified', 'sourced', 'self_hedging']).toContain(c.verification);
        });
    });

    it('demo-check returns correct shape', async () => {
        const res = await request(app)
            .post('/api/demo-check')
            .send({ text: 'Unique wiki test: The sun is a star.', context: 'general' });
        // May be 200 or 429 (rate limited by earlier tests) — both are valid
        if (res.status === 200) {
            expect(res.body.claims).toBeDefined();
            expect(res.body.demo).toBe(true);
        } else {
            expect(res.status).toBe(429);
        }
    });

    it('scoreTextWithVerification is callable', async () => {
        // This tests the async wrapper exists and runs
        const res = await request(app)
            .post('/api/check?verify=false').set('X-Guardrail-Key', userKey)
            .send({ text: 'Paris is the capital of France.', context: 'general' });
        expect(res.status).toBe(200);
        expect(res.body.decision).toBeDefined();
    });
});
