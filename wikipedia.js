'use strict';
/**
 * Wikipedia Claim Verification Module
 * Verifies factual claims against Wikipedia using the free REST API.
 * No API key required.
 */

// ── LRU Cache ────────────────────────────────────────────────────────────────
const CACHE_MAX = 100;
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes
const cache = new Map();

function cacheGet(key) {
    const entry = cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.ts > CACHE_TTL) { cache.delete(key); return null; }
    return entry.value;
}

function cacheSet(key, value) {
    if (cache.size >= CACHE_MAX) {
        // evict oldest
        const oldest = cache.keys().next().value;
        cache.delete(oldest);
    }
    cache.set(key, { value, ts: Date.now() });
}

// ── Entity & number extraction ───────────────────────────────────────────────

/**
 * Extract key searchable terms from a claim sentence.
 * Returns the best search query for Wikipedia.
 */
function extractSearchQuery(claim) {
    // Extract named entities (capitalized words that aren't sentence starters)
    const words = claim.split(/\s+/);
    const entities = [];
    for (let i = 0; i < words.length; i++) {
        const w = words[i].replace(/[^a-zA-Z0-9'-]/g, '');
        if (!w) continue;
        // Capitalized word that's not the first word or after a period
        if (/^[A-Z]/.test(w) && w.length > 1) {
            // Check if next word is also capitalized (multi-word entity)
            if (i + 1 < words.length && /^[A-Z]/.test(words[i + 1])) {
                entities.push(w + ' ' + words[i + 1].replace(/[^a-zA-Z0-9'-]/g, ''));
                i++; // skip next
            } else {
                entities.push(w);
            }
        }
    }

    // If we found named entities, use those
    if (entities.length > 0) {
        return entities.slice(0, 3).join(' ');
    }

    // Fallback: use the most meaningful words (remove stop words)
    const STOP = new Set(['the', 'a', 'an', 'is', 'was', 'were', 'are', 'has', 'have', 'had',
        'been', 'be', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'from', 'it',
        'its', 'this', 'that', 'and', 'or', 'but', 'not', 'as', 'than', 'about', 'into']);
    const meaningful = words
        .map(w => w.replace(/[^a-zA-Z0-9]/g, '').toLowerCase())
        .filter(w => w.length > 2 && !STOP.has(w));
    return meaningful.slice(0, 4).join(' ');
}

/**
 * Extract numbers and their context from a claim for verification.
 * Returns array of { number, context } objects.
 */
function extractNumbers(claim) {
    const results = [];
    // Match numbers with optional commas, decimals, and units
    const numRe = /(\d[\d,]*\.?\d*)\s*(percent|%|million|billion|thousand|meters?|metres?|feet|ft|km|miles?|kg|mg|lbs?|dollars?|USD|EUR|years?|days?|hours?|minutes?|seconds?|people|residents|inhabitants)?/gi;
    let m;
    while ((m = numRe.exec(claim)) !== null) {
        const num = parseFloat(m[1].replace(/,/g, ''));
        results.push({ number: num, raw: m[0], unit: m[2] || '' });
    }
    // Also match years (4-digit numbers)
    const yearRe = /\b(1[0-9]{3}|20[0-9]{2})\b/g;
    while ((m = yearRe.exec(claim)) !== null) {
        const yr = parseInt(m[1]);
        if (!results.some(r => r.number === yr)) {
            results.push({ number: yr, raw: m[1], unit: 'year' });
        }
    }
    return results;
}

// ── Wikipedia API ────────────────────────────────────────────────────────────

const WIKI_SEARCH_URL = 'https://en.wikipedia.org/w/api.php';
const WIKI_SUMMARY_URL = 'https://en.wikipedia.org/api/rest_v1/page/summary';
const TIMEOUT_MS = 4000;

/**
 * Search Wikipedia for articles matching a query.
 * Returns top result title or null.
 */
async function searchWikipedia(query) {
    const cached = cacheGet('search:' + query);
    if (cached !== null) return cached;

    try {
        const params = new URLSearchParams({
            action: 'query',
            list: 'search',
            srsearch: query,
            srlimit: '3',
            format: 'json',
            origin: '*',
        });
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

        const res = await fetch(`${WIKI_SEARCH_URL}?${params}`, {
            signal: controller.signal,
            headers: { 'User-Agent': 'GuardrailMVP/1.0 (https://guardrail-mvp-production.up.railway.app)' },
        });
        clearTimeout(timeout);

        if (!res.ok) return null;
        const data = await res.json();
        const results = data.query?.search || [];
        const title = results.length > 0 ? results[0].title : null;

        cacheSet('search:' + query, title);
        return title;
    } catch (err) {
        return null; // timeout or network error → graceful fallback
    }
}

/**
 * Get the summary/extract for a Wikipedia article.
 */
async function getWikiSummary(title) {
    const cacheKey = 'summary:' + title;
    const cached = cacheGet(cacheKey);
    if (cached !== null) return cached;

    try {
        const encoded = encodeURIComponent(title.replace(/ /g, '_'));
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

        const res = await fetch(`${WIKI_SUMMARY_URL}/${encoded}`, {
            signal: controller.signal,
            headers: { 'User-Agent': 'GuardrailMVP/1.0 (https://guardrail-mvp-production.up.railway.app)' },
        });
        clearTimeout(timeout);

        if (!res.ok) return null;
        const data = await res.json();
        const result = {
            title: data.title,
            extract: data.extract || '',
            url: data.content_urls?.desktop?.page || `https://en.wikipedia.org/wiki/${encoded}`,
        };

        cacheSet(cacheKey, result);
        return result;
    } catch (err) {
        return null;
    }
}

// ── Fuzzy matching ───────────────────────────────────────────────────────────

/**
 * Check if a number from a claim approximately matches a number in the Wikipedia text.
 * Returns 'match', 'close', 'mismatch', or 'not_found'.
 */
function compareNumbers(claimNum, wikiText) {
    const wikiNumbers = extractNumbers(wikiText);
    if (wikiNumbers.length === 0) return 'not_found';

    for (const wn of wikiNumbers) {
        // Exact match
        if (Math.abs(claimNum - wn.number) < 0.01) return 'match';
        // Close match (within 5% — accounts for rounding)
        if (claimNum > 0 && Math.abs(claimNum - wn.number) / claimNum < 0.05) return 'close';
        // Year match — must be exact
        if (claimNum >= 1000 && claimNum <= 2100 && wn.number >= 1000 && wn.number <= 2100) {
            if (claimNum === wn.number) return 'match';
        }
    }

    // Check if any wiki number is in a similar order of magnitude but different
    for (const wn of wikiNumbers) {
        if (claimNum > 0 && wn.number > 0) {
            const ratio = claimNum / wn.number;
            if (ratio > 0.1 && ratio < 10) return 'mismatch'; // same order of magnitude but wrong
        }
    }

    return 'not_found';
}

/**
 * Check if key terms from the claim appear in the Wikipedia text.
 */
function termOverlap(claim, wikiText) {
    const STOP = new Set(['the', 'a', 'an', 'is', 'was', 'were', 'are', 'has', 'have', 'had',
        'been', 'be', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'from']);
    const claimTerms = claim.toLowerCase().split(/\s+/)
        .map(w => w.replace(/[^a-z0-9]/g, ''))
        .filter(w => w.length > 2 && !STOP.has(w));
    const wikiLower = wikiText.toLowerCase();
    const matches = claimTerms.filter(t => wikiLower.includes(t));
    return claimTerms.length > 0 ? matches.length / claimTerms.length : 0;
}

// ── Main verification function ───────────────────────────────────────────────

/**
 * Verify a single claim against Wikipedia.
 *
 * @param {string} claimText - The claim sentence to verify
 * @returns {{ status: string, source: string|null, snippet: string|null, wikiUrl: string|null }}
 */
async function verifyClaim(claimText) {
    const query = extractSearchQuery(claimText);
    if (!query || query.length < 3) {
        return { status: 'unverified', source: null, snippet: null, wikiUrl: null };
    }

    // Search Wikipedia
    const title = await searchWikipedia(query);
    if (!title) {
        return { status: 'unverified', source: null, snippet: null, wikiUrl: null };
    }

    // Get summary
    const summary = await getWikiSummary(title);
    if (!summary || !summary.extract) {
        return { status: 'unverified', source: null, snippet: null, wikiUrl: null };
    }

    const extract = summary.extract;
    const snippet = extract.length > 200 ? extract.substring(0, 197) + '...' : extract;

    // Check term overlap — does this article seem relevant?
    const overlap = termOverlap(claimText, extract);
    if (overlap < 0.15) {
        // Article doesn't seem related to the claim
        return { status: 'unverified', source: null, snippet: null, wikiUrl: null };
    }

    // Check numbers in the claim against Wikipedia
    const claimNumbers = extractNumbers(claimText);
    if (claimNumbers.length > 0) {
        let hasMatch = false;
        let hasMismatch = false;

        for (const cn of claimNumbers) {
            const result = compareNumbers(cn.number, extract);
            if (result === 'match' || result === 'close') hasMatch = true;
            if (result === 'mismatch') hasMismatch = true;
        }

        if (hasMismatch && !hasMatch) {
            return {
                status: 'contradicted',
                source: 'Wikipedia',
                snippet,
                wikiUrl: summary.url,
            };
        }

        if (hasMatch) {
            return {
                status: 'verified',
                source: 'Wikipedia',
                snippet,
                wikiUrl: summary.url,
            };
        }
    }

    // No numbers to check — if significant term overlap, mark as "supported"
    if (overlap > 0.4) {
        return {
            status: 'verified',
            source: 'Wikipedia',
            snippet,
            wikiUrl: summary.url,
        };
    }

    return { status: 'unverified', source: 'Wikipedia', snippet, wikiUrl: summary.url };
}

/**
 * Verify multiple claims in parallel.
 * @param {Array<{text: string, type: string, verification: string}>} claims
 * @returns {Promise<Array>} claims with updated verification fields
 */
async function verifyAllClaims(claims) {
    const results = await Promise.all(
        claims.map(async (claim) => {
            // Only verify factual claims that don't already have a source
            if (claim.type !== 'claim' || claim.verification === 'sourced') {
                return claim;
            }

            try {
                const result = await verifyClaim(claim.text);
                return {
                    ...claim,
                    verification: result.status,
                    source: result.source,
                    snippet: result.snippet,
                    wikiUrl: result.wikiUrl,
                };
            } catch (err) {
                return claim; // keep original on error
            }
        })
    );
    return results;
}

module.exports = {
    verifyClaim,
    verifyAllClaims,
    searchWikipedia,
    getWikiSummary,
    extractSearchQuery,
    extractNumbers,
    compareNumbers,
    termOverlap,
    // exposed for testing
    _cache: cache,
};
