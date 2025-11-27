#!/usr/bin/env bun
/**
 * xln news cron script
 * - hourly: summarize stories with 200+ points into 3 levels
 * - every 6h: compile rich comment digests with user links
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import Anthropic from "@anthropic-ai/sdk";

const DATA_DIR = join(import.meta.dir, "../data/news-cache");
const OUTPUT_DIR = join(import.meta.dir, "../frontend/static/news/data");
const MIN_POINTS = 200;
const MAX_STORIES_PER_RUN = 10;

// ensure dirs exist
[DATA_DIR, OUTPUT_DIR].forEach(dir => {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
});

const anthropic = new Anthropic();

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
  type?: string;
  deleted?: boolean;
  dead?: boolean;
}

interface HNUser {
  id: string;
  created: number;
  karma: number;
  about?: string;
}

interface CachedStory {
  hn_id: number;
  title: string;
  url?: string;
  by: string;
  score: number;
  comments_count: number;
  summaries: {
    short?: string;
    medium?: string;
    long?: string;
  };
  comment_digest?: string;
  created_at: string;
  updated_at: string;
  last_summary_at?: string;
  last_digest_at?: string;
}

// known hn personalities for rich formatting
const HN_PERSONALITIES: Record<string, string> = {
  "pg": "Paul Graham",
  "dang": "Daniel Gackle (HN mod)",
  "patio11": "Patrick McKenzie",
  "tptacek": "Thomas Ptacek",
  "jacquesm": "Jacques Mattheij",
  "cperciva": "Colin Percival",
  "sama": "Sam Altman",
  "paulg": "Paul Graham",
  "rauchg": "Guillermo Rauch",
  "antirez": "Salvatore Sanfilippo",
  "graydon": "Graydon Hoare",
  "jhuckaby": "Joseph Huckaby",
  "minimaxir": "Max Woolf",
  "simonw": "Simon Willison",
  "swyx": "Shawn Wang",
  "tlb": "Trevor Blackwell",
  "gruseom": "Dan Gackle",
  "kogir": "Scott Goodwin (HN)",
  "sctb": "Scott Bell (HN)",
};

// fetch HN item
async function fetchHNItem(id: number): Promise<HNItem | null> {
  try {
    const res = await fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`);
    return res.json();
  } catch {
    return null;
  }
}

// fetch HN user
async function fetchHNUser(username: string): Promise<HNUser | null> {
  try {
    const res = await fetch(`https://hacker-news.firebaseio.com/v0/user/${username}.json`);
    return res.json();
  } catch {
    return null;
  }
}

// fetch top stories
async function fetchTopStories(): Promise<number[]> {
  try {
    const res = await fetch("https://hacker-news.firebaseio.com/v0/topstories.json");
    return res.json();
  } catch {
    return [];
  }
}

// fetch article content
async function fetchArticleContent(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "xln-news-bot/1.0" },
      signal: AbortSignal.timeout(10000),
    });
    const html = await res.text();
    return html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 15000);
  } catch {
    return null;
  }
}

// format username with rich style
function formatUser(username: string): string {
  const displayName = HN_PERSONALITIES[username] || username;
  const link = `https://news.ycombinator.com/user?id=${username}`;

  if (HN_PERSONALITIES[username]) {
    return `**${displayName}** ([@${username}](${link}))`;
  }
  return `[@${username}](${link})`;
}

// fetch comments with rich formatting
async function fetchCommentsRich(
  ids: number[],
  depth = 0,
  maxComments = 50
): Promise<{ formatted: string; raw: string[] }[]> {
  if (!ids || ids.length === 0 || depth > 4) return [];

  const comments: { formatted: string; raw: string[] }[] = [];
  const toFetch = ids.slice(0, Math.min(15, maxComments));

  for (const id of toFetch) {
    if (comments.length >= maxComments) break;

    const item = await fetchHNItem(id);
    if (!item || !item.text || item.deleted || item.dead) continue;

    const text = item.text
      .replace(/<p>/g, "\n\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&#x27;/g, "'")
      .replace(/&#x2F;/g, "/");

    const indent = "  ".repeat(depth);
    const userFormatted = formatUser(item.by);
    const commentLink = `https://news.ycombinator.com/item?id=${id}`;

    const formatted = `${indent}> ${userFormatted} [↗](${commentLink})\n${indent}> \n${indent}> ${text.split('\n').join(`\n${indent}> `)}`;

    comments.push({
      formatted,
      raw: [item.by, text]
    });

    if (item.kids && depth < 3) {
      const replies = await fetchCommentsRich(item.kids, depth + 1, maxComments - comments.length);
      comments.push(...replies);
    }
  }

  return comments;
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
    short: `summarize this hacker news story in 2-3 punchy sentences. be concise, capture the key point. make it adhd-friendly - scannable and engaging.

title: ${item.title}
${item.url ? `url: ${item.url}` : ""}
${item.text ? `post text: ${item.text}` : ""}
${articleContent ? `article excerpt: ${articleContent.slice(0, 3000)}` : ""}

top comments:
${commentsText.slice(0, 2000)}

respond with a brief tl;dr in markdown. no preamble. use bold for key terms.`,

    medium: `create a medium-length summary of this hacker news story and discussion. make it adhd-friendly: use bullet points, bold key terms, keep paragraphs short.

title: ${item.title}
${item.url ? `url: ${item.url}` : ""}
${item.text ? `post text: ${item.text}` : ""}
${articleContent ? `article content: ${articleContent.slice(0, 6000)}` : ""}

discussion (${item.descendants || 0} comments):
${commentsText.slice(0, 4000)}

format in markdown:
## tl;dr
(2-3 punchy sentences with **bold** key terms)

## key points
- bullet points of main ideas (use **bold** for emphasis)

## discussion highlights
- notable arguments/perspectives from comments
- use emojis sparingly for visual breaks

no preamble, just the formatted summary.`,

    long: `create a comprehensive but scannable summary of this hacker news story and discussion. optimize for adhd readers: short paragraphs, lots of bullets, bold key terms, clear headers.

title: ${item.title}
${item.url ? `url: ${item.url}` : ""}
${item.text ? `post text: ${item.text}` : ""}
${articleContent ? `full article content: ${articleContent}` : ""}

full discussion (${item.descendants || 0} comments):
${commentsText}

format as a detailed markdown memo:
## 📌 executive summary
(paragraph overview with **bold** key terms)

## 📰 article breakdown
### main thesis
### key arguments
- bullets
### evidence/data

## 💬 community discussion
### top perspectives
(summarize viewpoints, attribute to usernames when notable)
### counterarguments
### 🔥 spicy takes

## ✅ takeaways
- actionable insights
- open questions

be thorough but scannable. use emojis as section markers. bold important terms. no preamble.`
  };

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: mode === "short" ? 300 : mode === "medium" ? 800 : 2000,
    messages: [{ role: "user", content: prompts[mode] }],
  });

  return (response.content[0] as any).text;
}

// generate comment digest
async function generateCommentDigest(
  item: HNItem,
  comments: { formatted: string; raw: string[] }[]
): Promise<string> {
  const commentsForClaude = comments.map(c => `${c.raw[0]}: ${c.raw[1]}`).join("\n\n");

  const prompt = `create an engaging comment digest for this hacker news discussion. make it feel like a conversation stream - easy to read, adhd-friendly.

story: "${item.title}"
${item.url ? `link: ${item.url}` : ""}
comments count: ${item.descendants || 0}

raw comments:
${commentsForClaude.slice(0, 8000)}

format as markdown:
## 💬 comment stream

organize comments into themes/threads. for each notable comment:
- attribute to username (i'll add links later)
- quote key parts
- add brief context if needed

use this format for quotes:
> **username** wrote:
> "the actual quote..."

highlight:
- 🔥 hot takes
- 💡 insights
- 🤔 debates
- 😂 funny moments (if any)

end with:
## 📊 discussion vibe
(1-2 sentences on overall tone and main takeaways)

make it scannable and engaging. no preamble.`;

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 2500,
    messages: [{ role: "user", content: prompt }],
  });

  let digest = (response.content[0] as any).text;

  // enrich with actual user links
  for (const [username, displayName] of Object.entries(HN_PERSONALITIES)) {
    const regex = new RegExp(`\\*\\*${username}\\*\\*`, 'gi');
    digest = digest.replace(regex, formatUser(username));
  }

  return digest;
}

// get cached story
function getCached(hn_id: number): CachedStory | null {
  const path = join(DATA_DIR, `${hn_id}.json`);
  if (existsSync(path)) {
    return JSON.parse(readFileSync(path, "utf-8"));
  }
  return null;
}

// save to cache
function saveCache(story: CachedStory) {
  const path = join(DATA_DIR, `${story.hn_id}.json`);
  writeFileSync(path, JSON.stringify(story, null, 2));
}

// output feed json for frontend
function outputFeed(stories: CachedStory[]) {
  const feed = {
    updated_at: new Date().toISOString(),
    stories: stories.map(s => ({
      hn_id: s.hn_id,
      title: s.title,
      url: s.url,
      by: s.by,
      score: s.score,
      comments_count: s.comments_count,
      summaries: s.summaries,
      has_digest: !!s.comment_digest,
    }))
  };

  writeFileSync(join(OUTPUT_DIR, "feed.json"), JSON.stringify(feed, null, 2));
  console.log(`📤 output feed.json with ${stories.length} stories`);
}

// main cron job
async function runCron(mode: "hourly" | "6hourly") {
  console.log(`\n⚡ xln news cron: ${mode} run at ${new Date().toISOString()}`);

  const topIds = await fetchTopStories();
  console.log(`📰 fetched ${topIds.length} top story ids`);

  const processedStories: CachedStory[] = [];
  let processed = 0;

  for (const id of topIds) {
    if (processed >= MAX_STORIES_PER_RUN) break;

    const item = await fetchHNItem(id);
    if (!item || item.score < MIN_POINTS) continue;

    console.log(`\n📝 processing: ${item.title} (${item.score} pts)`);

    let cached = getCached(id);
    const now = new Date();

    // create new cache entry if needed
    if (!cached) {
      cached = {
        hn_id: id,
        title: item.title,
        url: item.url,
        by: item.by,
        score: item.score,
        comments_count: item.descendants || 0,
        summaries: {},
        created_at: now.toISOString(),
        updated_at: now.toISOString(),
      };
    }

    // update score/comments count
    cached.score = item.score;
    cached.comments_count = item.descendants || 0;
    cached.updated_at = now.toISOString();

    // hourly: generate summaries if missing
    if (mode === "hourly") {
      const needsSummary = !cached.summaries.short || !cached.summaries.medium || !cached.summaries.long;

      if (needsSummary) {
        console.log("  📝 generating summaries...");

        const articleContent = item.url ? await fetchArticleContent(item.url) : null;
        const rawComments = await fetchCommentsRaw(item.kids || []);

        if (!cached.summaries.short) {
          cached.summaries.short = await generateSummary(item, articleContent, rawComments, "short");
          console.log("    ✓ short");
        }
        if (!cached.summaries.medium) {
          cached.summaries.medium = await generateSummary(item, articleContent, rawComments, "medium");
          console.log("    ✓ medium");
        }
        if (!cached.summaries.long) {
          cached.summaries.long = await generateSummary(item, articleContent, rawComments, "long");
          console.log("    ✓ long");
        }

        cached.last_summary_at = now.toISOString();
      } else {
        console.log("  ✓ summaries already cached");
      }
    }

    // 6hourly: generate comment digest
    if (mode === "6hourly") {
      const lastDigest = cached.last_digest_at ? new Date(cached.last_digest_at) : null;
      const sixHoursAgo = new Date(now.getTime() - 6 * 60 * 60 * 1000);

      if (!lastDigest || lastDigest < sixHoursAgo) {
        console.log("  💬 generating comment digest...");

        const richComments = await fetchCommentsRich(item.kids || []);
        cached.comment_digest = await generateCommentDigest(item, richComments);
        cached.last_digest_at = now.toISOString();

        // save individual digest file
        writeFileSync(
          join(OUTPUT_DIR, `digest-${id}.md`),
          `# ${item.title}\n\n${cached.comment_digest}`
        );
        console.log("    ✓ digest saved");
      } else {
        console.log("  ✓ digest recent enough");
      }
    }

    saveCache(cached);
    processedStories.push(cached);
    processed++;

    // small delay to be nice to HN api
    await new Promise(r => setTimeout(r, 500));
  }

  // output combined feed
  outputFeed(processedStories);

  console.log(`\n✅ cron complete: processed ${processed} stories`);
}

// helper: fetch raw comments (simpler format for summaries)
async function fetchCommentsRaw(ids: number[], depth = 0, maxComments = 30): Promise<string[]> {
  if (!ids || ids.length === 0 || depth > 3) return [];

  const comments: string[] = [];
  const toFetch = ids.slice(0, Math.min(10, maxComments));

  for (const id of toFetch) {
    if (comments.length >= maxComments) break;

    const item = await fetchHNItem(id);
    if (!item || !item.text || item.deleted || item.dead) continue;

    const text = item.text
      .replace(/<[^>]+>/g, "")
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&#x27;/g, "'");

    const indent = "  ".repeat(depth);
    comments.push(`${indent}[${item.by}]: ${text}`);

    if (item.kids && depth < 2) {
      const replies = await fetchCommentsRaw(item.kids, depth + 1, maxComments - comments.length);
      comments.push(...replies);
    }
  }

  return comments;
}

// CLI
const args = process.argv.slice(2);
const mode = args[0] as "hourly" | "6hourly" | undefined;

if (mode === "hourly" || mode === "6hourly") {
  runCron(mode).catch(console.error);
} else {
  console.log(`
xln news cron script

usage:
  bun scripts/news-cron.ts hourly    # generate summaries for 200+ pt stories
  bun scripts/news-cron.ts 6hourly   # generate comment digests

env:
  ANTHROPIC_API_KEY  - required for claude api

config:
  MIN_POINTS: ${MIN_POINTS}
  MAX_STORIES_PER_RUN: ${MAX_STORIES_PER_RUN}
  DATA_DIR: ${DATA_DIR}
  OUTPUT_DIR: ${OUTPUT_DIR}
`);
}
