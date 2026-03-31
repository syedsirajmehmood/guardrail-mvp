'use strict';
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const db = require('./db');
const Anthropic = require('@anthropic-ai/sdk');
const { verifyAllClaims } = require('./wikipedia');

const app = express();
const PORT = process.env.PORT || 3001;

// ── Master key (set GUARDRAIL_MASTER_KEY in .env) ─────────────────────────────
const MASTER_KEY = process.env.GUARDRAIL_MASTER_KEY || 'gr_master_changeme';

// ── API Key store backed by PostgreSQL (with in-memory fallback) ──────────────
// See db.js for implementation — uses DATABASE_URL when available

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
    db.getCustomerByKey(key).then(entry => {
        if (!entry) {
            return res.status(401).json({ error: 'Invalid or revoked API key.' });
        }
        req.guardrailKey = key;
        req.guardrailCustomer = entry;
        next();
    }).catch(err => {
        console.error('[auth] DB error:', err.message);
        return res.status(500).json({ error: 'Internal auth error.' });
    });
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
    { pat: /\b(allegedly|supposedly|purportedly|ostensibly)\b/i, weight: 0.10, label: 'Epistemic distancing' },
    { pat: /\b(to my (knowledge|understanding|recollection)|as far as i (know|can tell|recall))\b/i, weight: 0.14, label: 'Scoped knowledge claim' },
    { pat: /\b(roughly|approximately|around|somewhere (around|between)|give or take)\b/i, weight: 0.08, label: 'Approximate quantification' },
    { pat: /\b(i('m| am) (not entirely|not fully|not 100%) sure)\b/i, weight: 0.12, label: 'Partial uncertainty' },
];

const KNOWLEDGE_CUTOFF_SIGNALS = [
    { pat: /\b(as of my (knowledge|training|last)( cutoff| update)?|my (knowledge|training) (cutoff|date|only goes))\b/i, weight: 0.20, label: 'Knowledge cutoff disclaimer' },
    { pat: /\b(i (don'?t|do not|cannot|can't) have access to (real[- ]time|current|live|latest))\b/i, weight: 0.22, label: 'No real-time access disclaimer' },
    { pat: /\b(i (can'?t|cannot|don'?t) (browse|search|access) (the )?(internet|web|real[- ]time))\b/i, weight: 0.22, label: 'Cannot browse internet' },
    { pat: /\b(my (information|data|knowledge) (may|might|could) (be|not be) (up to date|current|accurate|outdated))\b/i, weight: 0.18, label: 'Outdated information warning' },
    { pat: /\b(i (don'?t|do not) have (access|the ability) to)\b/i, weight: 0.15, label: 'Capability limitation' },
    { pat: /\b(i (should note|must note|want to clarify) that i)\b/i, weight: 0.08, label: 'Model self-reference' },
    { pat: /\b(things? (may|might|could) have changed|this (may|might) (have changed|be outdated))\b/i, weight: 0.16, label: 'Staleness hedge' },
    { pat: /\b(at the time of (my training|writing|this response)|when i was trained)\b/i, weight: 0.18, label: 'Training-time anchor' },
    { pat: /\b(i('d| would) (recommend|suggest) (checking|verifying|confirming) (this|that))\b/i, weight: 0.10, label: 'Verification nudge' },
    { pat: /\b(please (verify|check|confirm|look up|consult) (the )?(latest|current|recent|official))\b/i, weight: 0.12, label: 'Explicit verification request' },
];

const CONTRADICTION_SIGNALS = [
    { pat: /\b(actually|in fact|wait|correction|let me correct|i made an error)\b/i, weight: 0.14, label: 'Self-correction' },
    { pat: /\b(to clarify|let me rephrase|what i meant (was|is)|more precisely|to be more accurate)\b/i, weight: 0.12, label: 'Self-clarification' },
    { pat: /\b(on (second|further) thought|i('ve| have) reconsidered|revising (that|my answer))\b/i, weight: 0.14, label: 'Position reversal' },
    { pat: /\b(that (said|being said)|although|but (actually|in fact))\b/i, weight: 0.06, label: 'Soft contradiction pivot' },
];

const EVASION_SIGNALS = [
    { pat: /\b(i'?m (just )?an? (ai|language model|assistant|chatbot)|as an ai)\b/i, weight: 0.10, label: 'AI identity deflection' },
    { pat: /\b(you should (consult|speak to|ask|see|contact) (a|an|your) (doctor|lawyer|financial|professional|expert|specialist))\b/i, weight: 0.08, label: 'Professional referral deflection' },
    { pat: /\b(this is not (medical|legal|financial) advice)\b/i, weight: 0.06, label: 'Not-advice disclaimer' },
    { pat: /\b(it('s| is) (complicated|complex|nuanced)|there('s| is) no (simple|easy|one-size) answer)\b/i, weight: 0.08, label: 'Complexity deflection' },
    { pat: /\b(i('m| am) not (qualified|in a position|the right (source|person)) to)\b/i, weight: 0.10, label: 'Competence deflection' },
    { pat: /\b(that (falls outside|is beyond|is outside) (my|the scope))\b/i, weight: 0.10, label: 'Scope deflection' },
    { pat: /\b(i (prefer|choose|want) not to (comment|speculate|say))\b/i, weight: 0.12, label: 'Explicit refusal' },
];

const HALLUCINATION_SIGNALS = [
    { pat: /\b([A-Z][a-z]+ [A-Z][a-z]+), (born|died|founded) in \d{4}\b/, weight: 0.12, label: 'Unverifiable biographical claim' },
    { pat: /\b(exact(ly)? \$?\d[\d,.]* (billion|million|thousand))\b/i, weight: 0.10, label: 'Suspiciously precise number' },
    { pat: /\b(studies show|research (shows|suggests|proves)|experts say|according to experts)\b/i, weight: 0.10, label: 'Unattributed authority claim' },
    { pat: /\b(in (his|her|their) (landmark|seminal|groundbreaking|famous) (paper|study|book|work))\b/i, weight: 0.14, label: 'Unverifiable citation framing' },
    { pat: /\b(ISBN|DOI|arXiv)[\s:][\d\w./-]{5,}\b/i, weight: 0.20, label: 'Specific citation identifier (possible fabrication)' },
    { pat: /\b(published in \d{4} (by|in))\b/i, weight: 0.12, label: 'Unverifiable publication claim' },
    { pat: /\b(the (study|paper|report|survey) (found|showed|concluded|reported))\b/i, weight: 0.10, label: 'Unattributed study claim' },
    { pat: /\b(as (reported|documented|noted|stated) (by|in))\b/i, weight: 0.08, label: 'Vague attribution' },
    { pat: /\b(\d{1,3}(\.\d+)?% of (people|users|respondents|Americans|patients))\b/i, weight: 0.12, label: 'Suspiciously precise statistic' },
];

const FRUSTRATION_SIGNALS = [
    { pat: /\b(wrong|incorrect|mistake|error|that's not right|you're wrong|bad answer|useless)\b/i, weight: 0.10, label: 'User frustration' },
    { pat: /!{2,}|:{2,}/, weight: 0.06, label: 'Aggressive punctuation' },
    { pat: /\b(still (wrong|not right|incorrect)|again,? (that'?s? (wrong|not))|you (keep|still|again))\b/i, weight: 0.14, label: 'Repeated correction' },
    { pat: /\b(this is (terrible|awful|horrible|useless|garbage|trash)|what a (waste|joke))\b/i, weight: 0.12, label: 'Explicit negative evaluation' },
    { pat: /\b(never mind|forget (it|this)|i('ll| will) (just )?ask (elsewhere|someone else|google))\b/i, weight: 0.14, label: 'Abandonment signal' },
];

const SYCOPHANCY_SIGNALS = [
    { pat: /^(great question|excellent question|what a (great|wonderful|fantastic) question)/im, weight: 0.06, label: 'Sycophantic opener' },
    { pat: /\b(you('re| are) (absolutely|exactly|completely) right)\b/i, weight: 0.08, label: 'Excessive agreement' },
    { pat: /\b(that('s| is) (a |an )?(excellent|brilliant|fantastic|wonderful|great) (point|observation|insight|question))\b/i, weight: 0.06, label: 'Flattery' },
    { pat: /^(absolutely|certainly|of course|definitely)[.!,]/im, weight: 0.04, label: 'Overconfident affirmation' },
];

const HIGH_STAKES_PATTERNS = {
    medical: /\b(diagnosis|prescri|dosage|medication|treatment|symptom|disease|drug|surgery|patient)\b/i,
    legal: /\b(lawsuit|liability|legal advice|contract|court|attorney|regulation|compliance|statute)\b/i,
    financial: /\b(invest|portfolio|tax advice|financial advice|trade|stock|fund|pension|fiduciary)\b/i,
    safety: /\b(danger|hazard|risk|emergency|explosion|toxic|harmful|fatal|lethal)\b/i,
    security: /\b(password|credential|exploit|vulnerability|hack|breach|malware|phishing|encryption)\b/i,
    mental_health: /\b(suicide|self[- ]harm|overdose|crisis|therapist|psychiatrist|antidepressant|trauma|ptsd|bipolar)\b/i,
    child_safety: /\b(minor|child (abuse|safety)|grooming|exploitation|underage)\b/i,
    nuclear: /\b(radioactive|uranium|enrichment|reactor|fissile|criticality|rad(iation)? exposure)\b/i,
};

const CONTEXT_RISK = {
    medical: 0.25, legal: 0.25, financial: 0.20,
    safety: 0.30, security: 0.25, general: 0.00,
    mental_health: 0.35, child_safety: 0.35, nuclear: 0.35,
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

// ── Deterministic Claim Extraction ────────────────────────────────────────────
// Splits text into sentences, classifies each, flags unverified factual claims.
// No gen-AI — pure regex/rules.

const ABBREVIATIONS = /\b(mr|mrs|ms|dr|prof|sr|jr|etc|vs|approx|inc|ltd|corp|dept|est|vol|no)\./gi;
const DECIMAL_RE = /(\d)\.\s*(\d)/g; // "3.5" — not a sentence break

function splitSentences(text) {
    // Protect abbreviations and decimals from splitting
    let safe = text.replace(ABBREVIATIONS, (m) => m.replace('.', '〈DOT〉'));
    safe = safe.replace(DECIMAL_RE, '$1〈DOT〉$2');
    // Split on sentence boundaries
    const raw = safe.split(/(?<=[.!?])\s+(?=[A-Z"'`\-\[])|(?<=\n)\s*(?=\S)/);
    return raw
        .map(s => s.replace(/〈DOT〉/g, '.').trim())
        .filter(s => s.length > 5); // drop tiny fragments
}

// Sentence type patterns
const CLAIM_PATTERNS = [
    /\b\d{4}\b/,                                      // contains a year
    /\b\d[\d,.]+\s*(percent|%|million|billion|thousand|kg|mg|km|miles|hours|minutes|seconds|dollars|USD|EUR)\b/i,
    /\b(is|are|was|were|has|have|had|will|can|does|do)\b.*\b(the|a|an)\b/i, // declarative
    /\b(founded|invented|discovered|created|developed|released|published|launched|designed) (by|in)\b/i,
    /\b(according to|based on|research shows|data shows|statistics show)\b/i,
    /\b(always|never|every|all|none|must|guaranteed|certainly|definitely|proven)\b/i,
    /\b[A-Z][a-z]{2,}\s+[A-Z][a-z]{2,}\b.*\b(is|was|were|born|died|created|founded)\b/i, // Named entity + verb
];

const OPINION_PATTERNS = [
    /\b(i think|i believe|in my opinion|personally|i would say|i feel|arguably|it seems)\b/i,
    /\b(probably|likely|unlikely|possibly|perhaps|might|may|could)\b/i,
    /\b(best|worst|better|worse|greatest|most important|should|recommend)\b/i,
];

const INSTRUCTION_PATTERNS = [
    /^(run|install|click|open|go to|navigate|type|enter|copy|paste|create|add|remove|delete|update|set|configure|use|try|check)/i,
    /^(first|then|next|finally|step \d|note:|tip:|warning:)/i,
    /^(you (can|should|need to|must|will))\b/i,
];

const DISCLAIMER_PATTERNS = [
    /\b(i (don'?t|do not|cannot|can't) (have access|verify|confirm|guarantee))\b/i,
    /\b(as (of|an) (my|an?) (knowledge|ai|language model))\b/i,
    /\b(this is not .*(advice|recommendation)|consult .*(professional|expert|doctor|lawyer))\b/i,
    /\b(i'm not (sure|certain|able)|i (should|must) note)\b/i,
];

function classifySentence(sentence) {
    const s = sentence.trim();
    if (!s) return { type: 'filler', sentence: s };

    // Questions
    if (/\?\s*$/.test(s)) return { type: 'question', sentence: s };

    // Disclaimers (check before claims — "I can't verify" is not a claim)
    for (const pat of DISCLAIMER_PATTERNS) {
        if (pat.test(s)) return { type: 'disclaimer', sentence: s };
    }

    // Instructions
    for (const pat of INSTRUCTION_PATTERNS) {
        if (pat.test(s)) return { type: 'instruction', sentence: s };
    }

    // Opinions (check before claims — "I think X is true" is opinion, not claim)
    for (const pat of OPINION_PATTERNS) {
        if (pat.test(s)) return { type: 'opinion', sentence: s };
    }

    // Factual claims
    for (const pat of CLAIM_PATTERNS) {
        if (pat.test(s)) return { type: 'claim', sentence: s };
    }

    // Default: if it's a full sentence (has a verb-like word + subject), treat as claim
    if (s.length > 30 && /\b(is|are|was|were|has|have|had)\b/i.test(s)) {
        return { type: 'claim', sentence: s };
    }

    return { type: 'filler', sentence: s };
}

// Check if a claim has a source/citation
const SOURCE_PATTERNS = [
    /\b(according to|source:|cited in|per |as reported by|as stated by)\b/i,
    /https?:\/\/\S+/,
    /\b(doi:|isbn:|pmid:)\s*\S+/i,
    /\[[^\]]+\]\([^)]+\)/,  // markdown link
    /\(\d{4}\)/,            // academic citation (Author, 2024)
];

function checkVerification(sentence) {
    for (const pat of SOURCE_PATTERNS) {
        if (pat.test(sentence)) return 'sourced';
    }
    return 'unverified';
}

function extractClaims(text) {
    const sentences = splitSentences(text);
    const claims = [];

    for (const sentence of sentences) {
        const classified = classifySentence(sentence);

        if (classified.type === 'claim') {
            claims.push({
                text: sentence.length > 120 ? sentence.substring(0, 117) + '...' : sentence,
                type: 'claim',
                verification: checkVerification(sentence),
            });
        } else if (classified.type === 'disclaimer') {
            claims.push({
                text: sentence.length > 120 ? sentence.substring(0, 117) + '...' : sentence,
                type: 'disclaimer',
                verification: 'self_hedging',
            });
        }
    }

    return claims;
}


// ── Query Analysis — context-aware scoring ───────────────────────────────────
// When userQuery is provided, we can score the response in relation to the question.

const QUESTION_TYPE_PATTERNS = {
    fact: /^(what|who|when|where|which|how many|how much|how old|how long|how far|is |are |was |were |does |do |did |has |have |had )/i,
    opinion: /\b(should|recommend|suggest|think|best|prefer|better|worst|opinion|advice|would you|your (favorite|view|take|thoughts))\b/i,
    instruction: /\b(how (to|do|can|should)|steps? (to|for)|guide|tutorial|explain how|walk me through|show me how)\b/i,
    dangerous: /\b(dosage|medication|prescri(be|ption)|invest|buy (stock|crypto)|sue|lawsuit|file (a |for )?(claim|lawsuit)|self[- ]harm|suicid|kill|weapon|hack|exploit|bypass)\b/i,
};

function classifyQuestion(query) {
    if (!query) return { type: 'unknown', signals: [] };
    const q = query.trim();
    const signals = [];

    // Check for dangerous queries first (highest priority)
    if (QUESTION_TYPE_PATTERNS.dangerous.test(q)) {
        signals.push('dangerous-query');
        // Also classify the sub-type
        if (QUESTION_TYPE_PATTERNS.instruction.test(q)) return { type: 'dangerous-instruction', signals };
        if (QUESTION_TYPE_PATTERNS.fact.test(q)) return { type: 'dangerous-fact', signals };
        return { type: 'dangerous', signals };
    }

    if (QUESTION_TYPE_PATTERNS.instruction.test(q)) return { type: 'instruction', signals };
    if (QUESTION_TYPE_PATTERNS.opinion.test(q)) return { type: 'opinion', signals };
    if (QUESTION_TYPE_PATTERNS.fact.test(q)) return { type: 'fact', signals };

    return { type: 'general', signals };
}

function computeRelevance(query, response) {
    if (!query || !response) return 1.0; // no query = assume relevant
    // Extract meaningful words (>3 chars, not stopwords)
    const STOPWORDS = new Set(['this', 'that', 'with', 'from', 'they', 'them', 'their', 'what', 'when', 'where', 'which', 'about', 'have', 'been', 'will', 'would', 'could', 'should', 'your', 'some', 'more', 'very', 'just', 'also', 'into', 'than', 'then', 'only', 'most', 'such', 'each', 'much', 'well', 'here', 'there']);
    const queryWords = query.toLowerCase().split(/\W+/).filter(w => w.length > 3 && !STOPWORDS.has(w));
    if (queryWords.length === 0) return 1.0;

    const responseLower = response.toLowerCase();
    const found = queryWords.filter(w => responseLower.includes(w)).length;
    return found / queryWords.length;
}

function analyzeQueryContext(userQuery, responseText) {
    if (!userQuery) return null;

    const questionType = classifyQuestion(userQuery);
    const relevanceScore = computeRelevance(userQuery, responseText);

    // Scope analysis — is the response proportionate?
    const queryWordCount = userQuery.split(/\s+/).length;
    const responseWordCount = responseText.split(/\s+/).length;
    const scopeRatio = responseWordCount / Math.max(queryWordCount, 1);

    const analysis = {
        questionType: questionType.type,
        relevanceScore: parseFloat(relevanceScore.toFixed(2)),
        scopeRatio: parseFloat(scopeRatio.toFixed(1)),
        queryLength: queryWordCount,
        responseLength: responseWordCount,
        signals: [...questionType.signals],
    };

    // Flag low relevance
    if (relevanceScore < 0.25) {
        analysis.signals.push('low-relevance');
    }

    // Flag scope creep (response is 10x+ longer than question and question is short)
    if (scopeRatio > 10 && queryWordCount < 15) {
        analysis.signals.push('scope-creep');
    }

    // Flag dangerous query + free answer (no refusal detected)
    if (questionType.type.startsWith('dangerous')) {
        const hasRefusal = /\b(i (can'?t|cannot|won'?t|will not)|i'?m not (able|qualified|in a position)|not (medical|legal|financial) advice|consult (a|your) (doctor|lawyer|financial|professional))\b/i.test(responseText);
        if (!hasRefusal) {
            analysis.signals.push('no-refusal-on-dangerous');
        }
    }

    return analysis;
}


// --- Main scoring function ---
function scoreText(text, context, userQuery) {
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
    scanSignals(SYCOPHANCY_SIGNALS);

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

    // --- Claim extraction ---
    const claims = extractClaims(text);
    const unverifiedCount = claims.filter(function(c) { return c.verification === 'unverified'; }).length;
    if (unverifiedCount > 0) {
        const claimPenalty = Math.min(unverifiedCount * 0.03, 0.15); // cap at 15%
        totalPenalty += claimPenalty;
        excerpts.push({
            signal: unverifiedCount + ' unverified claim' + (unverifiedCount > 1 ? 's' : '') + ' detected',
            text: 'Factual statements without citations or sources',
            impact: -claimPenalty,
        });
    }

    // ── Query-aware scoring (when userQuery is provided) ─────────────────────
    let queryAnalysis = null;
    if (userQuery) {
        queryAnalysis = analyzeQueryContext(userQuery, text);

        // Relevance gap: response doesn't address the question
        if (queryAnalysis.relevanceScore < 0.25) {
            totalPenalty += 0.08;
            excerpts.push({
                signal: 'Low relevance to user query',
                text: `Only ${(queryAnalysis.relevanceScore * 100).toFixed(0)}% keyword overlap with question`,
                impact: -0.08,
            });
        }

        // Scope creep: response vastly exceeds the question scope
        if (queryAnalysis.signals.includes('scope-creep')) {
            totalPenalty += 0.04;
            excerpts.push({
                signal: 'Scope creep — response disproportionately long',
                text: `${queryAnalysis.responseLength} words for a ${queryAnalysis.queryLength}-word question`,
                impact: -0.04,
            });
        }

        // Dangerous question with no refusal
        if (queryAnalysis.signals.includes('no-refusal-on-dangerous')) {
            totalPenalty += 0.10;
            excerpts.push({
                signal: 'Dangerous query answered without appropriate refusal',
                text: `Question classified as ${queryAnalysis.questionType}`,
                impact: -0.10,
            });
        }

        // Bonus: when query is provided and response is relevant, slight confidence boost
        if (queryAnalysis.relevanceScore >= 0.5 && !queryAnalysis.signals.includes('no-refusal-on-dangerous')) {
            totalPenalty -= 0.03; // boost (negative penalty = positive)
            excerpts.push({
                signal: 'Query-context match — response addresses user question',
                text: `${(queryAnalysis.relevanceScore * 100).toFixed(0)}% relevance`,
                impact: 0.03,
            });
        }
    }

    // Base score: 0.82 — text must earn confidence through quality signals
    const baseScore = 0.82 + quality.qualityBonus;
    const confidence = Math.max(0, Math.min(1, baseScore - totalPenalty));

    var decision;
    if (confidence >= 0.75) decision = 'deliver';
    else if (confidence >= 0.45) decision = 'flag';
    else decision = 'escalate';

    const reasons = excerpts.map(function(e) { return e.signal; });

    const result = {
        confidence: parseFloat(confidence.toFixed(3)),
        decision,
        reasons,
        excerpts,
        claims,
        detectedContext: autoContext,
        effectiveContext: effectiveContext,
    };

    if (queryAnalysis) result.queryAnalysis = queryAnalysis;

    return result;
}

// Async wrapper: runs Wikipedia verification on extracted claims
async function scoreTextWithVerification(text, context, userQuery) {
    const result = scoreText(text, context, userQuery);
    if (result.claims && result.claims.length > 0) {
        // Verify claims against Wikipedia (parallel, with timeout)
        const verifiedClaims = await verifyAllClaims(result.claims);
        result.claims = verifiedClaims;

        // Recalculate claim impact on confidence
        const verified = verifiedClaims.filter(c => c.verification === 'verified').length;
        const contradicted = verifiedClaims.filter(c => c.verification === 'contradicted').length;
        const unverified = verifiedClaims.filter(c => c.verification === 'unverified').length;

        // Remove old claim excerpt and recalculate
        result.excerpts = result.excerpts.filter(e => !/unverified claim/.test(e.signal));

        let claimAdjustment = 0;
        if (verified > 0) {
            const bonus = Math.min(verified * 0.02, 0.10);
            claimAdjustment -= bonus; // negative penalty = bonus
            result.excerpts.push({ signal: verified + ' claim' + (verified > 1 ? 's' : '') + ' verified (Wikipedia)', text: 'Matched against Wikipedia', impact: bonus });
        }
        if (contradicted > 0) {
            const penalty = Math.min(contradicted * 0.08, 0.20);
            claimAdjustment += penalty;
            result.excerpts.push({ signal: contradicted + ' claim' + (contradicted > 1 ? 's' : '') + ' contradicted (Wikipedia)', text: 'Wikipedia data disagrees', impact: -penalty });
        }
        if (unverified > 0) {
            const penalty = Math.min(unverified * 0.03, 0.15);
            claimAdjustment += penalty;
            result.excerpts.push({ signal: unverified + ' unverified claim' + (unverified > 1 ? 's' : '') + ' detected', text: 'Factual statements without citations or sources', impact: -penalty });
        }

        // Recalculate confidence with new claim data
        const newConf = Math.max(0, Math.min(1, result.confidence + (verified * 0.02) - (contradicted * 0.08)));
        result.confidence = parseFloat(newConf.toFixed(3));

        // Recalculate decision
        if (result.confidence >= 0.75) result.decision = 'deliver';
        else if (result.confidence >= 0.45) result.decision = 'flag';
        else result.decision = 'escalate';

        result.reasons = result.excerpts.map(e => e.signal);
    }
    return result;
}


// ── Anthropic client ──────────────────────────────────────────────────────────
// Pass overrideKey to use the caller's own Anthropic key (their tokens, not ours)
function getAnthropic(overrideKey) {
    const key = overrideKey || process.env.ANTHROPIC_API_KEY;
    if (!key || key === 'your-key-here') return null;
    return new Anthropic({ apiKey: key });
}

// ── Demo endpoint — keyless playground (rate-limited to 5/ip/hour) ────────────
const demoLimits = {};
app.post('/api/demo-check', async (req, res) => {
    const ip = req.headers['x-forwarded-for'] || req.ip || 'unknown';
    const now = Date.now();
    if (!demoLimits[ip]) demoLimits[ip] = [];
    demoLimits[ip] = demoLimits[ip].filter(t => now - t < 3600000); // 1 hour window
    if (demoLimits[ip].length >= 5) {
        return res.status(429).json({ error: 'Demo limit reached (5/hour). Sign up for unlimited access — it\'s free!' });
    }
    demoLimits[ip].push(now);

    const { text, context } = req.body || {};
    if (!text || typeof text !== 'string' || !text.trim()) {
        return res.status(400).json({ error: 'text is required' });
    }
    // Demo mode: verify only if ?verify=true (keeps default fast)
    const shouldVerify = req.query.verify === 'true';
    const result = shouldVerify
        ? await scoreTextWithVerification(text, context || 'general')
        : scoreText(text, context || 'general');
    res.json({
        ...result,
        id: 'demo_' + Date.now().toString(36),
        context: result.effectiveContext,
        timestamp: new Date().toISOString(),
        demo: true,
        remaining: 5 - demoLimits[ip].length,
    });
});

// ── Public Signup ─────────────────────────────────────────────────────────────

// POST /api/signup — self-serve key generation
app.post('/api/signup', async (req, res) => {
    try {
        const { email } = req.body || {};
        if (!email || !email.includes('@')) {
            return res.status(400).json({ error: 'Valid email is required.' });
        }
        // Check if email already has a key
        const existing = await db.getCustomerByEmail(email);
        if (existing) {
            return res.json({ key: existing.api_key, email: existing.email, created: existing.created, existed: true });
        }
        const customer = await db.createCustomer(email.toLowerCase().trim());
        console.log(`[signup] New key created for ${email}: ${customer.api_key}`);
        res.json({ key: customer.api_key, email: customer.email, created: customer.created, existed: false });
    } catch (e) {
        console.error('[signup] Error:', e.message);
        res.status(500).json({ error: 'Signup failed.' });
    }
});

// GET /api/developer/me — per-key stats (self-serve)
app.get('/api/developer/me', requireKey, async (req, res) => {
    try {
        if (req.isMaster) {
            return res.json({ email: 'admin', key: MASTER_KEY, requests: store.stats.total, decisions: store.stats, created: 'N/A' });
        }
        const entry = req.guardrailCustomer || await db.getCustomerByKey(req.guardrailKey);
        const myLogs = store.logs.filter(l => l.apiKey === req.guardrailKey).slice(0, 100);
        res.json({
            email: entry.email,
            key: req.guardrailKey,
            created: entry.created,
            requests: entry.requests,
            decisions: entry.decisions,
            recentLogs: myLogs
        });
    } catch (e) {
        console.error('[developer/me] Error:', e.message);
        res.status(500).json({ error: 'Failed to fetch stats.' });
    }
});

// ── Key Management Routes (master-key protected) ──────────────────────────────

// POST /api/keys — generate a new API key (admin)
app.post('/api/keys', requireMasterKey, async (req, res) => {
    try {
        const { label, email } = req.body || {};
        const customer = await db.createCustomer(email, label);
        res.json({ key: customer.api_key, label: customer.label, created: customer.created });
    } catch (e) {
        console.error('[keys] Create error:', e.message);
        res.status(500).json({ error: 'Key creation failed.' });
    }
});

// GET /api/keys — list all keys
app.get('/api/keys', requireMasterKey, async (req, res) => {
    try {
        const list = await db.listCustomers();
        res.json(list);
    } catch (e) {
        console.error('[keys] List error:', e.message);
        res.status(500).json({ error: 'Failed to list keys.' });
    }
});

// DELETE /api/keys/:key — revoke a key
app.delete('/api/keys/:key', requireMasterKey, async (req, res) => {
    try {
        const { key } = req.params;
        const deleted = await db.deleteCustomer(key);
        if (!deleted) return res.status(404).json({ error: 'Key not found' });
        res.json({ revoked: key });
    } catch (e) {
        console.error('[keys] Delete error:', e.message);
        res.status(500).json({ error: 'Key deletion failed.' });
    }
});

// ── tawk.to Integration ──────────────────────────────────────────────────────

// POST /api/tawkto/webhook — receive tawk.to chat events and score messages
app.post('/api/tawkto/webhook', async (req, res) => {
    const apiKey = req.headers['x-guardrail-key'] || req.query.key;
    if (!apiKey) return res.status(401).json({ error: 'API key required. Add X-Guardrail-Key header or ?key= param.' });

    const event = req.body;
    const messages = event.message?.text ? [event.message] :
                     event.messages ? event.messages :
                     event.history ? event.history : [];

    const results = [];
    for (const msg of messages) {
        // Only score agent/system messages (not visitor messages)
        if (msg.sender?.type === 'visitor' || msg.type === 'visitor') continue;
        const text = msg.text || msg.msg || '';
        if (!text || text.length < 10) continue;

        const scored = scoreText(text, 'general');
        const record = {
            id: uuidv4(),
            timestamp: new Date().toISOString(),
            text: text.substring(0, 300),
            context: 'general',
            source: 'tawkto',
            ...scored
        };

        // Log to database
        try { await db.logCheck(record, apiKey); } catch(e) { /* skip db errors */ }
        results.push({ text: text.substring(0, 100) + '...', confidence: scored.confidence, decision: scored.decision, reasons: scored.reasons });
    }

    res.json({ processed: results.length, results });
});

// GET /api/tawkto/openapi.json — OpenAPI schema for tawk.to AI Assist Custom Tool
app.get('/api/tawkto/openapi.json', (req, res) => {
    res.json({
        openapi: '3.0.0',
        info: { title: 'Guardrail AI Safety Check', version: '1.0.0', description: 'Score AI responses for hallucinations, unsafe advice, and fabricated citations.' },
        servers: [{ url: 'https://guardrail-mvp-production.up.railway.app' }],
        paths: {
            '/api/check': {
                post: {
                    operationId: 'checkSafety',
                    summary: 'Score an AI response for safety and accuracy',
                    description: 'Analyzes text for hallucinations, unsafe advice, hedging, and fabricated citations. Returns a confidence score and deliver/flag/escalate decision.',
                    parameters: [{ name: 'X-Guardrail-Key', in: 'header', required: true, schema: { type: 'string' }, description: 'Your Guardrail API key' }],
                    requestBody: {
                        required: true,
                        content: { 'application/json': { schema: {
                            type: 'object',
                            required: ['text'],
                            properties: {
                                text: { type: 'string', description: 'The AI response text to score' },
                                userQuery: { type: 'string', description: 'The original user question (improves accuracy)' },
                                context: { type: 'string', enum: ['general', 'medical', 'financial', 'legal', 'security'], description: 'Domain context for scoring' }
                            }
                        }}}
                    },
                    responses: {
                        '200': { description: 'Safety score result', content: { 'application/json': { schema: {
                            type: 'object',
                            properties: {
                                confidence: { type: 'number', description: 'Confidence score 0-1' },
                                decision: { type: 'string', enum: ['deliver', 'flag', 'escalate'], description: 'Recommended action' },
                                reasons: { type: 'array', items: { type: 'string' }, description: 'Detected safety signals' }
                            }
                        }}}}
                    }
                }
            }
        }
    });
});


// ── Protected API Routes ──────────────────────────────────────────────────────

// POST /api/chat — call Claude then score

// ── Demo Chat — keyless with pre-recorded responses ──────────────────────────
const DEMO_RESPONSES = {
    'general': [
        "Python is a high-level, interpreted programming language. It was created by Guido van Rossum and first released in 1991. Python emphasizes code readability with its use of significant indentation. It supports multiple programming paradigms, including procedural, object-oriented, and functional programming.",
        "Machine learning is a subset of artificial intelligence that enables systems to learn and improve from experience without being explicitly programmed. Common approaches include supervised learning, unsupervised learning, and reinforcement learning.",
        "The internet works through a system of interconnected networks that communicate using standardized protocols. Data is broken into packets, routed through various nodes, and reassembled at the destination. The core protocols are TCP/IP, which handle addressing and reliable data transfer.",
    ],
    'medical': [
        "I believe the recommended dosage is around 500mg, but I'm not entirely sure — it might depend on the patient's weight and medical history. You should probably consult a doctor or pharmacist for the exact dosage. I don't have access to real-time medical databases.",
        "Based on my training data, the symptoms you describe could be associated with several conditions. However, I'm not qualified to make a diagnosis. I would strongly recommend consulting with a healthcare professional who can examine you in person.",
    ],
    'financial': [
        "I don't have access to real-time market data, so I can't tell you the current stock price. As of my last update, the company was trading around $175, but things may have changed significantly since then. I'd recommend checking a financial data provider for current prices.",
        "Generally speaking, diversification is considered a sound investment strategy. However, I should note that I'm not a licensed financial advisor. Your individual financial situation, risk tolerance, and goals should all be considered. You should consult a qualified financial professional.",
    ],
    'security': [
        "To secure your application, you should implement multiple layers of defense. Use HTTPS for all communications, implement proper authentication with hashed passwords, set up input validation, and follow the principle of least privilege. However, security requirements can vary — I'd recommend a professional security audit.",
    ],
};

app.post('/api/demo-chat', (req, res) => {
    const ip = req.headers['x-forwarded-for'] || req.ip || 'unknown';
    const now = Date.now();
    if (!demoLimits[ip]) demoLimits[ip] = [];
    demoLimits[ip] = demoLimits[ip].filter(t => now - t < 3600000);
    if (demoLimits[ip].length >= 10) {
        return res.status(429).json({ error: 'Demo limit reached (10/hour). Sign up for unlimited access — it\'s free!' });
    }
    demoLimits[ip].push(now);

    const { message, context } = req.body || {};
    if (!message) return res.status(400).json({ error: 'message is required' });

    const ctx = context || 'general';
    const pool = DEMO_RESPONSES[ctx] || DEMO_RESPONSES['general'];
    const aiText = pool[Math.floor(Math.random() * pool.length)];

    // Score it with Guardrail
    const guardrail = scoreText(aiText, ctx);

    res.json({
        aiResponse: aiText,
        confidence: guardrail.confidence,
        decision: guardrail.decision,
        reasons: guardrail.reasons,
        excerpts: guardrail.excerpts || [],
        claims: guardrail.claims || [],
        context: guardrail.effectiveContext,
        demo: true,
        remaining: 10 - demoLimits[ip].length,
    });
});

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
app.post('/api/check', requireKey, async (req, res) => {
    const { text, context, userId, metadata, userQuery } = req.body;
    if (!text) return res.status(400).json({ error: 'text is required' });

    // Use Wikipedia verification by default; skip with ?verify=false
    const shouldVerify = req.query.verify !== 'false';
    const scored = shouldVerify
        ? await scoreTextWithVerification(text, context || 'general', userQuery || null)
        : scoreText(text, context || 'general', userQuery || null);
    const record = {
        id: uuidv4(),
        timestamp: new Date().toISOString(),
        text: text.substring(0, 300),
        userQuery: userQuery ? userQuery.substring(0, 300) : null,
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
    // Per-key decision tracking — persist to database
    if (!req.isMaster) {
        db.incrementUsage(req.guardrailKey, record.decision).catch(e => console.error('[db] incrementUsage error:', e.message));
        db.logCheck(record).catch(e => console.error('[db] logCheck error:', e.message));
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
    res.setHeader('Content-Disposition', 'attachment; filename="guardrail-ai-mcp.js"');
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
module.exports.scoreText = scoreText;

