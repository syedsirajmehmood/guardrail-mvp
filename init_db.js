#!/usr/bin/env node
'use strict';

/**
 * Guardrail AI — Database Initialization
 * 
 * Run once to create tables and migrate existing keys from data/keys.json.
 * Usage: DATABASE_URL=postgres://... node init_db.js
 */

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
    console.error('❌ DATABASE_URL not set. Run with: DATABASE_URL=postgres://... node init_db.js');
    process.exit(1);
}

const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

async function run() {
    console.log('🗄️  Connecting to PostgreSQL...');

    // ── Create tables ─────────────────────────────────────────────────────────
    await pool.query(`
        CREATE TABLE IF NOT EXISTS customers (
            id SERIAL PRIMARY KEY,
            api_key VARCHAR(64) UNIQUE NOT NULL,
            email VARCHAR(255),
            label VARCHAR(255) DEFAULT 'unnamed',
            plan VARCHAR(20) DEFAULT 'free',
            requests INT DEFAULT 0,
            checks_limit INT DEFAULT 1000,
            deliver_count INT DEFAULT 0,
            flag_count INT DEFAULT 0,
            escalate_count INT DEFAULT 0,
            created_at TIMESTAMP DEFAULT NOW(),
            updated_at TIMESTAMP DEFAULT NOW()
        );
    `);
    console.log('✅ Table "customers" ready');

    await pool.query(`
        CREATE TABLE IF NOT EXISTS usage_logs (
            id SERIAL PRIMARY KEY,
            customer_api_key VARCHAR(64) REFERENCES customers(api_key) ON DELETE CASCADE,
            score REAL,
            decision VARCHAR(20),
            flags_triggered TEXT[],
            context VARCHAR(100) DEFAULT 'general',
            response_length INT DEFAULT 0,
            created_at TIMESTAMP DEFAULT NOW()
        );
    `);
    console.log('✅ Table "usage_logs" ready');

    // ── Create indexes ────────────────────────────────────────────────────────
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_customers_email ON customers(email);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_usage_logs_key ON usage_logs(customer_api_key);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_usage_logs_created ON usage_logs(created_at);`);
    console.log('✅ Indexes created');

    // ── Migrate existing keys from data/keys.json ─────────────────────────────
    const KEYS_FILE = path.join(__dirname, 'data', 'keys.json');
    if (fs.existsSync(KEYS_FILE)) {
        const keys = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8'));
        const entries = Object.entries(keys);
        let migrated = 0;
        let skipped = 0;

        for (const [apiKey, data] of entries) {
            try {
                // Check if key already exists
                const { rows } = await pool.query('SELECT id FROM customers WHERE api_key = $1', [apiKey]);
                if (rows.length > 0) {
                    skipped++;
                    continue;
                }
                await pool.query(
                    `INSERT INTO customers (api_key, email, label, requests, deliver_count, flag_count, escalate_count, created_at)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                    [
                        apiKey,
                        data.email || null,
                        data.label || data.email || 'unnamed',
                        data.requests || 0,
                        (data.decisions && data.decisions.deliver) || 0,
                        (data.decisions && data.decisions.flag) || 0,
                        (data.decisions && data.decisions.escalate) || 0,
                        data.created || new Date().toISOString()
                    ]
                );
                migrated++;
            } catch (e) {
                console.error(`  ⚠️  Failed to migrate key ${apiKey.substring(0, 12)}...: ${e.message}`);
            }
        }
        console.log(`✅ Migration: ${migrated} keys imported, ${skipped} already existed (${entries.length} total in file)`);
    } else {
        console.log('ℹ️  No data/keys.json found — nothing to migrate');
    }

    // ── Summary ───────────────────────────────────────────────────────────────
    const { rows } = await pool.query('SELECT COUNT(*) as count FROM customers');
    console.log(`\n🎉 Done! ${rows[0].count} customers in database.`);

    await pool.end();
}

run().catch(e => {
    console.error('❌ Init failed:', e.message);
    process.exit(1);
});
