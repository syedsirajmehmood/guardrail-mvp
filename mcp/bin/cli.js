#!/usr/bin/env node
'use strict';

/**
 * guardrail-mcp CLI
 * Usage: npx guardrail-mcp --key gr_live_xxx [--endpoint https://...]
 *
 * Starts a Guardrail MCP server that connects to Claude Desktop.
 */

const args = process.argv.slice(2);
const keyIdx = args.indexOf('--key');
const endIdx = args.indexOf('--endpoint');

if (args.includes('--help') || args.includes('-h')) {
    console.log(`
🛡️  Guardrail MCP Server — AI Confidence Scoring for Claude Desktop

USAGE:
  npx guardrail-mcp --key <your-api-key> [--endpoint <url>]

OPTIONS:
  --key <key>       Your Guardrail API key (required). Get one free at:
                    https://guardrail-mvp-production.up.railway.app

  --endpoint <url>  Guardrail API URL (optional).
                    Default: https://guardrail-mvp-production.up.railway.app

  --help, -h        Show this help message

SETUP:
  1. Get a free API key at https://guardrail-mvp-production.up.railway.app
  2. Add to your Claude Desktop config:

     {
       "mcpServers": {
         "guardrail": {
           "command": "npx",
           "args": ["guardrail-mcp", "--key", "gr_live_xxx"]
         }
       }
     }

  3. Restart Claude Desktop — Guardrail tools will appear automatically.

TOOLS PROVIDED:
  • check_confidence  — Score any AI text for confidence (0-1)
  • explain_signals   — See which signals fired and why

DOCS: https://guardrail-mvp-production.up.railway.app/docs.html
`);
    process.exit(0);
}

if (keyIdx === -1 || !args[keyIdx + 1]) {
    console.error('❌ Missing --key argument. Run with --help for usage.');
    process.exit(1);
}

// Set environment variables for the MCP server
process.env.GUARDRAIL_API_KEY = args[keyIdx + 1];
if (endIdx !== -1 && args[endIdx + 1]) {
    process.env.GUARDRAIL_ENDPOINT = args[endIdx + 1];
} else {
    process.env.GUARDRAIL_ENDPOINT = 'https://guardrail-mvp-production.up.railway.app';
}

console.log('🛡️ Starting Guardrail MCP server...');
console.log(`   Key: ${process.env.GUARDRAIL_API_KEY.slice(0, 12)}...`);
console.log(`   Endpoint: ${process.env.GUARDRAIL_ENDPOINT}`);

// Load the MCP server
require('../server.js');
