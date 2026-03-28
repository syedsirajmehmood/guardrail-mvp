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

// ────────────────────────────────────────────────────────────────────────────
// Health
// ────────────────────────────────────────────────────────────────────────────
describe('GET /api/health', () => {
    it('returns 200 with status ok', async () => {
        const res = await request(app).get('/api/health');
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('ok');
        expect(res.body.version).toBeDefined();
    });
});

// ────────────────────────────────────────────────────────────────────────────
// Signup (public)
// ────────────────────────────────────────────────────────────────────────────
describe('POST /api/signup', () => {
    it('creates a new key for a valid email', async () => {
        const res = await request(app)
            .post('/api/signup')
            .send({ email: FAKE_EMAIL });
        expect(res.status).toBe(200);
        expect(res.body.key).toMatch(/^gr_live_/);
        expect(res.body.email).toBe(FAKE_EMAIL);
        expect(res.body.existed).toBe(false);
        userKey = res.body.key; // save for later tests
    });

    it('returns the same key if email already signed up', async () => {
        const res = await request(app)
            .post('/api/signup')
            .send({ email: FAKE_EMAIL });
        expect(res.status).toBe(200);
        expect(res.body.key).toBe(userKey);
        expect(res.body.existed).toBe(true);
    });

    it('rejects missing email', async () => {
        const res = await request(app).post('/api/signup').send({});
        expect(res.status).toBe(400);
        expect(res.body.error).toBeDefined();
    });

    it('rejects invalid email (no @)', async () => {
        const res = await request(app)
            .post('/api/signup')
            .send({ email: 'notanemail' });
        expect(res.status).toBe(400);
    });
});

// ────────────────────────────────────────────────────────────────────────────
// Auth
// ────────────────────────────────────────────────────────────────────────────
describe('Auth — requireKey middleware', () => {
    it('rejects request with no key', async () => {
        const res = await request(app).get('/api/stats');
        expect(res.status).toBe(401);
    });

    it('rejects request with invalid key', async () => {
        const res = await request(app)
            .get('/api/stats')
            .set('X-Guardrail-Key', 'gr_live_badkey');
        expect(res.status).toBe(401);
    });

    it('accepts master key on protected routes', async () => {
        const res = await request(app)
            .get('/api/stats')
            .set('X-Guardrail-Key', MASTER);
        expect(res.status).toBe(200);
    });

    it('accepts a valid user key', async () => {
        const res = await request(app)
            .get('/api/stats')
            .set('X-Guardrail-Key', userKey);
        expect(res.status).toBe(200);
    });
});

// ────────────────────────────────────────────────────────────────────────────
// POST /api/check (scoring)
// ────────────────────────────────────────────────────────────────────────────
describe('POST /api/check', () => {
    it('scores a confident response as deliver', async () => {
        const res = await request(app)
            .post('/api/check')
            .set('X-Guardrail-Key', userKey)
            .send({ text: 'The capital of France is Paris. It has been the capital since 987 AD.' });
        expect(res.status).toBe(200);
        expect(res.body.decision).toBe('deliver');
        expect(res.body.confidence).toBeGreaterThan(0.74);
        expect(res.body.id).toBeDefined();
    });

    it('flags a hedged response', async () => {
        const res = await request(app)
            .post('/api/check')
            .set('X-Guardrail-Key', userKey)
            .send({ text: 'I am not sure, but it might be Paris. Maybe. Perhaps. I think so but I could be wrong.' });
        expect(res.status).toBe(200);
        expect(['flag', 'escalate']).toContain(res.body.decision);
        expect(res.body.confidence).toBeLessThan(0.75);
    });

    it('escalates a high-uncertainty medical response', async () => {
        const res = await request(app)
            .post('/api/check')
            .set('X-Guardrail-Key', userKey)
            .send({
                text: 'I am not sure about this diagnosis. The medication dosage might be wrong. Perhaps surgery is needed.',
                context: 'medical'
            });
        expect(res.status).toBe(200);
        expect(res.body.decision).toBe('escalate');
        expect(res.body.reasons.length).toBeGreaterThan(0);
    });

    it('includes reasons array in response', async () => {
        const res = await request(app)
            .post('/api/check')
            .set('X-Guardrail-Key', userKey)
            .send({ text: 'I think maybe the answer could be something.', context: 'general' });
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body.reasons)).toBe(true);
    });

    it('returns 400 if text is missing', async () => {
        const res = await request(app)
            .post('/api/check')
            .set('X-Guardrail-Key', userKey)
            .send({ context: 'general' });
        expect(res.status).toBe(400);
    });

    it('tracks per-key decision counts', async () => {
        // Check once more to accumulate stats
        await request(app)
            .post('/api/check')
            .set('X-Guardrail-Key', userKey)
            .send({ text: 'Definitively confirmed fact with no ambiguity.' });

        const meRes = await request(app)
            .get('/api/developer/me')
            .set('X-Guardrail-Key', userKey);
        expect(meRes.body.requests).toBeGreaterThan(0);
        const { deliver, flag, escalate } = meRes.body.decisions;
        expect(deliver + flag + escalate).toBeGreaterThan(0);
    });
});

// ────────────────────────────────────────────────────────────────────────────
// GET /api/developer/me
// ────────────────────────────────────────────────────────────────────────────
describe('GET /api/developer/me', () => {
    it('returns key info for a valid user key', async () => {
        const res = await request(app)
            .get('/api/developer/me')
            .set('X-Guardrail-Key', userKey);
        expect(res.status).toBe(200);
        expect(res.body.email).toBe(FAKE_EMAIL);
        expect(res.body.key).toBe(userKey);
        expect(res.body.decisions).toBeDefined();
        expect(Array.isArray(res.body.recentLogs)).toBe(true);
    });

    it('returns admin info for master key', async () => {
        const res = await request(app)
            .get('/api/developer/me')
            .set('X-Guardrail-Key', MASTER);
        expect(res.status).toBe(200);
        expect(res.body.email).toBe('admin');
    });
});

// ────────────────────────────────────────────────────────────────────────────
// GET /api/stats & /api/logs
// ────────────────────────────────────────────────────────────────────────────
describe('GET /api/stats', () => {
    it('returns aggregate stats', async () => {
        const res = await request(app)
            .get('/api/stats')
            .set('X-Guardrail-Key', MASTER);
        expect(res.status).toBe(200);
        expect(typeof res.body.total).toBe('number');
        expect(typeof res.body.deliverRate).toBe('number');
    });
});

describe('GET /api/logs', () => {
    it('returns an array of recent logs', async () => {
        const res = await request(app)
            .get('/api/logs')
            .set('X-Guardrail-Key', MASTER);
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);
    });

    it('respects the limit query param', async () => {
        const res = await request(app)
            .get('/api/logs?limit=2')
            .set('X-Guardrail-Key', MASTER);
        expect(res.status).toBe(200);
        expect(res.body.length).toBeLessThanOrEqual(2);
    });
});

// ────────────────────────────────────────────────────────────────────────────
// Admin key management
// ────────────────────────────────────────────────────────────────────────────
describe('Admin /api/keys', () => {
    let adminKey = '';

    it('POST creates a new key with master key', async () => {
        const res = await request(app)
            .post('/api/keys')
            .set('X-Guardrail-Key', MASTER)
            .send({ label: 'test-admin-key', email: 'admin@example.com' });
        expect(res.status).toBe(200);
        expect(res.body.key).toMatch(/^gr_live_/);
        adminKey = res.body.key;
    });

    it('GET lists all keys', async () => {
        const res = await request(app)
            .get('/api/keys')
            .set('X-Guardrail-Key', MASTER);
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);
        expect(res.body.some(k => k.key === adminKey)).toBe(true);
    });

    it('DELETE revokes a key', async () => {
        const res = await request(app)
            .delete(`/api/keys/${adminKey}`)
            .set('X-Guardrail-Key', MASTER);
        expect(res.status).toBe(200);
        expect(res.body.revoked).toBe(adminKey);

        // Revoked key is now rejected
        const check = await request(app)
            .get('/api/stats')
            .set('X-Guardrail-Key', adminKey);
        expect(check.status).toBe(401);
    });

    it('rejects admin routes with user key', async () => {
        const res = await request(app)
            .get('/api/keys')
            .set('X-Guardrail-Key', userKey);
        expect(res.status).toBe(401);
    });
});
