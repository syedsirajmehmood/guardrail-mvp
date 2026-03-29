#!/usr/bin/env node
'use strict';

/**
 * guardrail-mcp CLI
 * Usage: npx guardrail-mcp --key gr_live_xxx [--endpoint https://...]
 *
 * Starts a Guardrail MCP server that connects to Claude Desktop.
 */

const args = process.argv.slice(2);

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
  2. Add to your Claude Desktop config (~/.config/claude/claude_desktop_config.json):

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
  • get_my_stats      — View your usage statistics
  • score_and_explain — Score + human-readable explanation

DOCS: https://guardrail-mvp-production.up.railway.app/docs.html
`);
    process.exit(0);
}

// Parse arguments
const keyIdx = args.indexOf('--key');
const endIdx = args.indexOf('--endpoint');

if (keyIdx === -1 || !args[keyIdx + 1]) {
    console.error('❌ Missing --key argument.');
    console.error('   Usage: npx guardrail-mcp --key gr_live_xxx');
    console.error('   Run with --help for full usage.');
    process.exit(1);
}

// Set environment variables BEFORE loading the MCP server
process.env.GUARDRAIL_API_KEY = args[keyIdx + 1];
process.env.GUARDRAIL_ENDPOINT = (endIdx !== -1 && args[endIdx + 1])
    ? args[endIdx + 1]
    : 'https://guardrail-mvp-production.up.railway.app';

const key = process.env.GUARDRAIL_API_KEY;
const endpoint = process.env.GUARDRAIL_ENDPOINT;

process.stderr.write(`🛡️  Guardrail MCP Server starting...\n`);
process.stderr.write(`   Key: ${key.slice(0, 12)}...\n`);
process.stderr.write(`   Endpoint: ${endpoint}\n`);

// Load the self-contained MCP server (same directory)
require('../server.js');
