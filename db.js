'use strict';

/**
 * Guardrail AI — Database Layer
 * 
 * Uses PostgreSQL when DATABASE_URL is set.
 * Falls back to in-memory Map + data/keys.json when it's not (local dev, tests).
 */

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const DATA_DIR = path.join(__dirname, 'data');
const KEYS_FILE = path.join(DATA_DIR, 'keys.json');

const usePostgres = !!process.env.DATABASE_URL;
let pool = null;

if (usePostgres) {
    pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
        max: 10,
        idleTimeoutMillis: 30000,
    });
    pool.on('error', (err) => console.error('[db] Pool error:', err.message));
    console.log('[db] PostgreSQL mode — connected via DATABASE_URL');
} else {
    console.log('[db] In-memory mode — no DATABASE_URL set');
}

// ── In-memory fallback (existing behavior) ───────────────────────────────────
const memoryKeys = new Map();

function loadKeysFromDisk() {
    try {
        if (fs.existsSync(KEYS_FILE)) {
            const obj = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8'));
            for (const [k, v] of Object.entries(obj)) memoryKeys.set(k, v);
            console.log(`[db] Loaded ${memoryKeys.size} keys from disk`);
        }
    } catch (e) { console.error('[db] Load failed:', e.message); }
}

function saveKeysToDisk() {
    try {
        if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
        const obj = {};
        memoryKeys.forEach((v, k) => { obj[k] = v; });
        fs.writeFileSync(KEYS_FILE, JSON.stringify(obj, null, 2));
    } catch (e) { console.error('[db] Save failed:', e.message); }
}

if (!usePostgres) loadKeysFromDisk();

// ── Unified API ──────────────────────────────────────────────────────────────

/**
 * Get a customer by API key.
 * Returns { email, label, api_key, plan, requests, checks_limit, decisions, created } or null.
 */
async function getCustomerByKey(key) {
    if (usePostgres) {
        const { rows } = await pool.query(
            'SELECT * FROM customers WHERE api_key = $1', [key]
        );
        if (rows.length === 0) return null;
        const r = rows[0];
        return {
            email: r.email,
            label: r.label,
            api_key: r.api_key,
            plan: r.plan,
            requests: r.requests,
            checks_limit: r.checks_limit,
            decisions: { deliver: r.deliver_count, flag: r.flag_count, escalate: r.escalate_count },
            created: r.created_at.toISOString()
        };
    }
    const entry = memoryKeys.get(key);
    if (!entry) return null;
    return { ...entry, api_key: key };
}

/**
 * Get a customer by email.
 */
async function getCustomerByEmail(email) {
    if (usePostgres) {
        const { rows } = await pool.query(
            'SELECT * FROM customers WHERE email = $1', [email.toLowerCase().trim()]
        );
        if (rows.length === 0) return null;
        const r = rows[0];
        return {
            email: r.email,
            label: r.label,
            api_key: r.api_key,
            plan: r.plan,
            requests: r.requests,
            checks_limit: r.checks_limit,
            decisions: { deliver: r.deliver_count, flag: r.flag_count, escalate: r.escalate_count },
            created: r.created_at.toISOString()
        };
    }
    for (const [k, v] of memoryKeys.entries()) {
        if (v.email === email.toLowerCase().trim()) {
            return { ...v, api_key: k };
        }
    }
    return null;
}

/**
 * Create a new customer and return { api_key, email, label, created }.
 */
async function createCustomer(email, label) {
    const key = 'gr_live_' + uuidv4().replace(/-/g, '');
    const now = new Date().toISOString();

    if (usePostgres) {
        await pool.query(
            `INSERT INTO customers (api_key, email, label, plan, requests, checks_limit, deliver_count, flag_count, escalate_count)
             VALUES ($1, $2, $3, 'free', 0, 1000, 0, 0, 0)`,
            [key, email ? email.toLowerCase().trim() : null, label || email || 'unnamed']
        );
        return { api_key: key, email: email ? email.toLowerCase().trim() : null, label: label || email || 'unnamed', created: now };
    }

    memoryKeys.set(key, {
        email: email ? email.toLowerCase().trim() : null,
        label: label || email || 'unnamed',
        created: now,
        requests: 0,
        decisions: { deliver: 0, flag: 0, escalate: 0 }
    });
    saveKeysToDisk();
    return { api_key: key, email: email ? email.toLowerCase().trim() : null, label: label || email || 'unnamed', created: now };
}

/**
 * Delete a customer by API key. Returns true if deleted.
 */
async function deleteCustomer(key) {
    if (usePostgres) {
        const result = await pool.query('DELETE FROM customers WHERE api_key = $1', [key]);
        return result.rowCount > 0;
    }
    if (!memoryKeys.has(key)) return false;
    memoryKeys.delete(key);
    saveKeysToDisk();
    return true;
}

/**
 * List all customers.
 */
async function listCustomers() {
    if (usePostgres) {
        const { rows } = await pool.query('SELECT * FROM customers ORDER BY created_at DESC');
        return rows.map(r => ({
            key: r.api_key,
            email: r.email,
            label: r.label,
            plan: r.plan,
            requests: r.requests,
            checks_limit: r.checks_limit,
            decisions: { deliver: r.deliver_count, flag: r.flag_count, escalate: r.escalate_count },
            created: r.created_at.toISOString()
        }));
    }
    const list = [];
    memoryKeys.forEach((val, key) => list.push({ key, ...val }));
    return list;
}

/**
 * Increment usage and record the decision for a key.
 */
async function incrementUsage(key, decision) {
    if (usePostgres) {
        const col = decision === 'deliver' ? 'deliver_count'
                  : decision === 'flag' ? 'flag_count'
                  : 'escalate_count';
        await pool.query(
            `UPDATE customers SET requests = requests + 1, ${col} = ${col} + 1 WHERE api_key = $1`,
            [key]
        );
        return;
    }
    const entry = memoryKeys.get(key);
    if (entry) {
        entry.requests++;
        if (entry.decisions[decision] !== undefined) entry.decisions[decision]++;
    }
}

/**
 * Log a check result to the usage_logs table (PG only, no-op in memory mode).
 */
async function logCheck(record) {
    if (!usePostgres) return;
    try {
        await pool.query(
            `INSERT INTO usage_logs (customer_api_key, score, decision, flags_triggered, context, response_length, user_query)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
                record.apiKey,
                record.confidence,
                record.decision,
                record.reasons || [],
                record.context || 'general',
                record.text ? record.text.length : 0,
                record.userQuery || null
            ]
        );
    } catch (e) {
        console.error('[db] logCheck failed:', e.message);
    }
}

/**
 * Check if PostgreSQL is being used.
 */
function isPostgres() {
    return usePostgres;
}

/**
 * Close the pool (for graceful shutdown).
 */
async function close() {
    if (pool) await pool.end();
}

module.exports = {
    getCustomerByKey,
    getCustomerByEmail,
    createCustomer,
    deleteCustomer,
    listCustomers,
    incrementUsage,
    logCheck,
    isPostgres,
    close
};
