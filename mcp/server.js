#!/usr/bin/env node
'use strict';
/**
 * Guardrail MCP Server v1.1.0
 * Exposes Guardrail confidence-scoring as MCP tools for Claude Desktop and other MCP clients.
 * Now with context-aware scoring: pass userQuery for question-aware analysis.
 *
 * Setup (Claude Desktop):
 *   ~/Library/Application Support/Claude/claude_desktop_config.json
 *   {
 *     "mcpServers": {
 *       "guardrail": {
 *         "command": "npx",
 *         "args": ["guardrail-ai-mcp", "--key", "gr_live_xxx"]
 *       }
 *     }
 *   }
 */

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');

const ENDPOINT = process.env.GUARDRAIL_ENDPOINT || 'https://guardrail-mvp-production.up.railway.app';
const API_KEY  = process.env.GUARDRAIL_API_KEY  || '';

if (!API_KEY) {
    process.stderr.write('[guardrail-mcp] WARNING: GUARDRAIL_API_KEY not set. Requests will fail.\n');
}

// ── HTTP helper ──────────────────────────────────────────────────────────────
async function guardrailFetch(path, opts = {}) {
    const url = ENDPOINT.replace(/\/$/, '') + path;
    const res = await fetch(url, {
        ...opts,
        headers: {
            'Content-Type': 'application/json',
            'X-Guardrail-Key': API_KEY,
            ...(opts.headers || {}),
        },
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
    return json;
}

// ── MCP Server ───────────────────────────────────────────────────────────────
const server = new Server(
    { name: 'guardrail', version: '1.1.0' },
    { capabilities: { tools: {} } }
);

// ── Tool definitions ─────────────────────────────────────────────────────────
server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
        {
            name: 'check_confidence',
            description:
                'Score an AI response for confidence and safety. Returns a decision ' +
                '(deliver / flag / escalate), a confidence score 0-1, and the reasons ' +
                'behind the score. Use this before showing any AI-generated answer to a user ' +
                'to detect uncertainty, hallucinations, or high-stakes domain risks. ' +
                'For best results, include the user\'s original question in userQuery — ' +
                'this enables relevance checking and question-type-aware scoring.',
            inputSchema: {
                type: 'object',
                properties: {
                    text: {
                        type: 'string',
                        description: 'The AI response text to evaluate.',
                    },
                    userQuery: {
                        type: 'string',
                        description: 'The original user question/message that prompted this AI response. Enables context-aware scoring (relevance, scope, refusal audit).',
                    },
                    context: {
                        type: 'string',
                        enum: ['general', 'medical', 'legal', 'financial', 'security', 'safety'],
                        description: 'Domain context. Defaults to general.',
                    },
                    userId: {
                        type: 'string',
                        description: 'Optional user identifier for tracking.',
                    },
                },
                required: ['text'],
            },
        },
        {
            name: 'get_my_stats',
            description:
                'Retrieve your Guardrail usage statistics: total checks run, and ' +
                'breakdown of deliver / flag / escalate decisions.',
            inputSchema: {
                type: 'object',
                properties: {},
            },
        },
        {
            name: 'score_and_explain',
            description:
                'Score an AI response AND return a human-readable explanation of the ' +
                'decision suitable for showing to end users or logging. Returns the full ' +
                'result plus a plain English summary. For best results, include the ' +
                'user\'s original question in userQuery for context-aware analysis.',
            inputSchema: {
                type: 'object',
                properties: {
                    text: {
                        type: 'string',
                        description: 'The AI response text to evaluate.',
                    },
                    userQuery: {
                        type: 'string',
                        description: 'The original user question/message. Enables context-aware scoring.',
                    },
                    context: {
                        type: 'string',
                        enum: ['general', 'medical', 'legal', 'financial', 'security', 'safety'],
                        description: 'Domain context.',
                    },
                },
                required: ['text'],
            },
        },
    ],
}));

// ── Tool handlers ────────────────────────────────────────────────────────────
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
        if (name === 'check_confidence') {
            const body = {
                text: args.text,
                context: args.context || 'general',
                userId: args.userId || 'mcp-user',
            };
            if (args.userQuery) body.userQuery = args.userQuery;

            const result = await guardrailFetch('/api/check', {
                method: 'POST',
                body: JSON.stringify(body),
            });

            const emoji = { deliver: '✅', flag: '⚠️', escalate: '🔴' }[result.decision] || '❓';
            const output = {
                decision:   result.decision,
                confidence: result.confidence,
                reasons:    result.reasons,
                id:         result.id,
                summary:    `${emoji} ${result.decision.toUpperCase()} — confidence ${(result.confidence * 100).toFixed(0)}%`
                    + (result.reasons.length ? '\n• ' + result.reasons.join('\n• ') : ''),
            };
            if (result.queryAnalysis) output.queryAnalysis = result.queryAnalysis;

            return {
                content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
            };
        }

        if (name === 'get_my_stats') {
            const data = await guardrailFetch('/api/developer/me');
            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        email:     data.email,
                        requests:  data.requests,
                        decisions: data.decisions,
                        summary:   `Total: ${data.requests} | ✅ ${data.decisions.deliver} delivered, ⚠️ ${data.decisions.flag} flagged, 🔴 ${data.decisions.escalate} escalated`,
                    }, null, 2),
                }],
            };
        }

        if (name === 'score_and_explain') {
            const body = {
                text:    args.text,
                context: args.context || 'general',
                userId:  'mcp-user',
            };
            if (args.userQuery) body.userQuery = args.userQuery;

            const result = await guardrailFetch('/api/check', {
                method: 'POST',
                body: JSON.stringify(body),
            });

            const DECISION_COPY = {
                deliver:  'This response appears reliable and can be shown to the user.',
                flag:     'This response has some uncertainty. Consider adding a disclaimer or reviewing before showing.',
                escalate: 'This response has high uncertainty or risk. Do NOT show to user — escalate to a human.',
            };

            const parts = [
                `**Decision: ${result.decision.toUpperCase()}** (confidence: ${(result.confidence * 100).toFixed(0)}%)`,
                '',
                DECISION_COPY[result.decision] || '',
                '',
                result.reasons.length
                    ? '**Signals detected:**\n' + result.reasons.map(r => `• ${r}`).join('\n')
                    : '**No risk signals detected.**',
            ];

            if (result.queryAnalysis) {
                parts.push('', '**Query analysis:**');
                if (result.queryAnalysis.questionType) parts.push(`• Question type: ${result.queryAnalysis.questionType}`);
                if (result.queryAnalysis.relevanceScore !== undefined) parts.push(`• Relevance: ${(result.queryAnalysis.relevanceScore * 100).toFixed(0)}%`);
                if (result.queryAnalysis.signals && result.queryAnalysis.signals.length > 0) {
                    parts.push('• Context signals: ' + result.queryAnalysis.signals.join(', '));
                }
            }

            return {
                content: [{ type: 'text', text: parts.join('\n') }],
            };
        }

        throw new Error(`Unknown tool: ${name}`);
    } catch (err) {
        return {
            content: [{ type: 'text', text: `Error: ${err.message}` }],
            isError: true,
        };
    }
});

// ── Start ────────────────────────────────────────────────────────────────────
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    process.stderr.write(`[guardrail-mcp] Server v1.1.0 running. Endpoint: ${ENDPOINT}\n`);
}

main().catch((err) => {
    process.stderr.write(`[guardrail-mcp] Fatal: ${err.message}\n`);
    process.exit(1);
});
