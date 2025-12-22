/**
 * XLN News Summarization API
 * Fetches HN stories + comments, summarizes via Claude
 */

import { serve } from "bun";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import Anthropic from "@anthropic-ai/sdk";

const PORT = 3002;
const CACHE_DIR = join(import.meta.dir, "data/news-cache");
const BUDGET_FILE = join(import.meta.dir, "data/news-budget.json");
const MIN_POINTS_FOR_SUMMARY = 200; // admin configurable
const DAILY_BUDGET_USD = 20; // $20/day limit

// pricing per 1M tokens (sonnet 4)
const PRICE_INPUT_PER_M = 3;   // $3 per 1M input
const PRICE_OUTPUT_PER_M = 15; // $15 per 1M output

interface BudgetData {
  date: string;
  spent_usd: number;
  requests: number;
  tokens_in: number;
  tokens_out: number;
}

function getTodayBudget(): BudgetData {
  const today = new Date().toISOString().split("T")[0];
  if (existsSync(BUDGET_FILE)) {
    try {
      const data = JSON.parse(readFileSync(BUDGET_FILE, "utf-8"));
      if (data.date === today) return data;
    } catch {}
  }
  return { date: today, spent_usd: 0, requests: 0, tokens_in: 0, tokens_out: 0 };
}

function saveBudget(budget: BudgetData) {
  writeFileSync(BUDGET_FILE, JSON.stringify(budget, null, 2));
}

function trackUsage(inputTokens: number, outputTokens: number) {
  const budget = getTodayBudget();
  const cost = (inputTokens / 1_000_000) * PRICE_INPUT_PER_M +
               (outputTokens / 1_000_000) * PRICE_OUTPUT_PER_M;
  budget.spent_usd += cost;
  budget.requests++;
  budget.tokens_in += inputTokens;
  budget.tokens_out += outputTokens;
  saveBudget(budget);
  return budget;
}

function checkBudget(): { ok: boolean; remaining: number; spent: number } {
  const budget = getTodayBudget();
  return {
    ok: budget.spent_usd < DAILY_BUDGET_USD,
    remaining: Math.max(0, DAILY_BUDGET_USD - budget.spent_usd),
    spent: budget.spent_usd
  };
}

// load .env.news if exists
function loadEnvFile() {
  const envPath = join(import.meta.dir, ".env.news");
  if (existsSync(envPath)) {
    const content = readFileSync(envPath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("#")) {
        const [key, ...valueParts] = trimmed.split("=");
        const value = valueParts.join("=").trim();
        if (key && value) {
          process.env[key.trim()] = value;
        }
      }
    }
  }
}
loadEnvFile();

// ensure cache dir exists
if (!existsSync(CACHE_DIR)) {
  mkdirSync(CACHE_DIR, { recursive: true });
}

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

interface HNItem {
  id: number;
  title: string;
  url?: string;
  text?: string;
  by: string;
  time: number;
  score: number;
  descendants?: number;
  kids?: number[];
}

interface CachedSummary {
  hn_id: number;
  title: string;
  url?: string;
  summaries: {
    short?: string;
    medium?: string;
    long?: string;
  };
  created_at: string;
  updated_at: string;
}

// fetch HN item
async function fetchHNItem(id: number): Promise<HNItem | null> {
  try {
    const res = await fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`);
    return res.json();
  } catch {
    return null;
  }
}

// fetch article content via url
async function fetchArticleContent(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "XLN News Bot/1.0" },
      signal: AbortSignal.timeout(10000),
    });
    const html = await res.text();
    // basic html to text - strip tags, get text content
    const text = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 15000); // limit to ~15k chars
    return text;
  } catch {
    return null;
  }
}

// fetch top comments recursively
async function fetchComments(ids: number[], depth = 0, maxComments = 30): Promise<string[]> {
  if (!ids || ids.length === 0 || depth > 3) return [];

  const comments: string[] = [];
  const toFetch = ids.slice(0, Math.min(10, maxComments));

  for (const id of toFetch) {
    if (comments.length >= maxComments) break;

    const item = await fetchHNItem(id);
    if (!item || item.text === undefined || (item as any).deleted || (item as any).dead) continue;

    const indent = "  ".repeat(depth);
    const text = item.text
      .replace(/<[^>]+>/g, "")
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&#x27;/g, "'");

    comments.push(`${indent}[${item.by}]: ${text}`);

    if (item.kids && depth < 2) {
      const replies = await fetchComments(item.kids, depth + 1, maxComments - comments.length);
      comments.push(...replies);
    }
  }

  return comments;
}

// get cached summary
function getCached(hn_id: number): CachedSummary | null {
  const path = join(CACHE_DIR, `${hn_id}.json`);
  if (existsSync(path)) {
    return JSON.parse(readFileSync(path, "utf-8"));
  }
  return null;
}

// save to cache
function saveCache(summary: CachedSummary) {
  const path = join(CACHE_DIR, `${summary.hn_id}.json`);
  writeFileSync(path, JSON.stringify(summary, null, 2));
}

// generate summary with claude
async function generateSummary(
  item: HNItem,
  articleContent: string | null,
  comments: string[],
  mode: "short" | "medium" | "long"
): Promise<string> {

  const commentsText = comments.slice(0, mode === "short" ? 5 : mode === "medium" ? 15 : 30).join("\n\n");

  const prompts = {
    short: `summarize this hacker news story in 2-3 sentences. be concise and capture the key point.

title: ${item.title}
${item.url ? `url: ${item.url}` : ""}
${item.text ? `post text: ${item.text}` : ""}
${articleContent ? `article excerpt: ${articleContent.slice(0, 3000)}` : ""}

top comments:
${commentsText.slice(0, 2000)}

respond with a brief tl;dr in markdown. no preamble.`,

    medium: `create a medium-length summary of this hacker news story and discussion.

title: ${item.title}
${item.url ? `url: ${item.url}` : ""}
${item.text ? `post text: ${item.text}` : ""}
${articleContent ? `article content: ${articleContent.slice(0, 6000)}` : ""}

discussion (${item.descendants || 0} comments):
${commentsText.slice(0, 4000)}

format in markdown:
## tl;dr
(2-3 sentences)

## key points
- bullet points of main ideas

## discussion highlights
- notable arguments/perspectives from comments

no preamble, just the formatted summary.`,

    long: `create a comprehensive summary/memo of this hacker news story and its discussion.

title: ${item.title}
${item.url ? `url: ${item.url}` : ""}
${item.text ? `post text: ${item.text}` : ""}
${articleContent ? `full article content: ${articleContent}` : ""}

full discussion (${item.descendants || 0} comments):
${commentsText}

format as a detailed markdown memo:
## executive summary
(paragraph overview)

## article breakdown
### main thesis
### key arguments
### evidence/data presented

## community discussion
### top perspectives
(summarize main viewpoints with representative quotes)

### counterarguments
### consensus vs controversy

## takeaways
- actionable insights
- open questions

be thorough but organized. use quotes where relevant. no preamble.`
  };

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: mode === "short" ? 300 : mode === "medium" ? 800 : 2000,
    messages: [{ role: "user", content: prompts[mode] }],
  });

  // track token usage for budget
  trackUsage(response.usage.input_tokens, response.usage.output_tokens);

  return (response.content[0] as any).text;
}

serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    const headers = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Content-Type": "application/json",
    };

    if (req.method === "OPTIONS") {
      return new Response(null, { headers });
    }

    // GET /api/news/budget - check today's budget
    if (url.pathname === "/api/news/budget" && req.method === "GET") {
      const budget = checkBudget();
      const data = getTodayBudget();
      return new Response(JSON.stringify({
        ...budget,
        daily_limit: DAILY_BUDGET_USD,
        requests_today: data.requests,
        tokens_in: data.tokens_in,
        tokens_out: data.tokens_out,
      }), { headers });
    }

    // POST /api/news/summarize
    if (url.pathname === "/api/news/summarize" && req.method === "POST") {
      try {
        // check budget first
        const budget = checkBudget();
        if (!budget.ok) {
          return new Response(JSON.stringify({
            error: "daily budget exhausted",
            spent: budget.spent.toFixed(2),
            limit: DAILY_BUDGET_USD,
            retry_after: "tomorrow"
          }), { status: 429, headers });
        }

        const body = await req.json();
        const { hn_id, mode = "medium" } = body;

        if (!hn_id) {
          return new Response(JSON.stringify({ error: "hn_id required" }), { status: 400, headers });
        }

        if (!["short", "medium", "long"].includes(mode)) {
          return new Response(JSON.stringify({ error: "mode must be short, medium, or long" }), { status: 400, headers });
        }

        // check cache first
        let cached = getCached(hn_id);
        if (cached?.summaries[mode as keyof typeof cached.summaries]) {
          return new Response(JSON.stringify({
            summary: cached.summaries[mode as keyof typeof cached.summaries],
            cached: true,
            hn_id,
            mode,
          }), { headers });
        }

        // fetch HN item
        const item = await fetchHNItem(hn_id);
        if (!item) {
          return new Response(JSON.stringify({ error: "story not found" }), { status: 404, headers });
        }

        // check minimum points
        if (item.score < MIN_POINTS_FOR_SUMMARY) {
          return new Response(JSON.stringify({
            error: `story needs ${MIN_POINTS_FOR_SUMMARY}+ points for summarization`,
            current_score: item.score
          }), { status: 400, headers });
        }

        // fetch article content if url exists
        const articleContent = item.url ? await fetchArticleContent(item.url) : null;

        // fetch comments
        const comments = item.kids ? await fetchComments(item.kids) : [];

        // generate summary
        const summary = await generateSummary(item, articleContent, comments, mode as "short" | "medium" | "long");

        // update cache
        if (!cached) {
          cached = {
            hn_id,
            title: item.title,
            url: item.url,
            summaries: {},
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          };
        }
        cached.summaries[mode as keyof typeof cached.summaries] = summary;
        cached.updated_at = new Date().toISOString();
        saveCache(cached);

        return new Response(JSON.stringify({
          summary,
          cached: false,
          hn_id,
          mode,
          title: item.title,
        }), { headers });

      } catch (error) {
        console.error("summarize error:", error);
        return new Response(JSON.stringify({ error: "failed to generate summary" }), { status: 500, headers });
      }
    }

    // GET /api/news/cached/:id - get all cached summaries for a story
    if (url.pathname.startsWith("/api/news/cached/") && req.method === "GET") {
      const hn_id = parseInt(url.pathname.split("/").pop() || "");
      if (!hn_id) {
        return new Response(JSON.stringify({ error: "invalid id" }), { status: 400, headers });
      }

      const cached = getCached(hn_id);
      if (!cached) {
        return new Response(JSON.stringify({ error: "not cached" }), { status: 404, headers });
      }

      return new Response(JSON.stringify(cached), { headers });
    }

    // GET /api/news/config - get current config (min points etc)
    if (url.pathname === "/api/news/config" && req.method === "GET") {
      return new Response(JSON.stringify({
        min_points: MIN_POINTS_FOR_SUMMARY,
        modes: ["short", "medium", "long"],
      }), { headers });
    }

    return new Response(JSON.stringify({ error: "not found" }), { status: 404, headers });
  },
});

console.log(`⚡ XLN News API running on http://localhost:${PORT}`);
console.log(`📰 Min points for summary: ${MIN_POINTS_FOR_SUMMARY}`);
console.log(`💾 Cache dir: ${CACHE_DIR}`);
console.log(`\nEndpoints:`);
console.log(`  POST /api/news/summarize - Generate summary { hn_id, mode: short|medium|long }`);
console.log(`  GET  /api/news/cached/:id - Get cached summaries`);
console.log(`  GET  /api/news/config - Get config`);
