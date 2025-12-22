/**
 * XLN Comparative Analysis Submission API
 * Simple Bun server for collecting AI model evaluations
 */

import { serve } from "bun";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

const PORT = 3001;
const DATA_DIR = join(import.meta.dir, "data");
const PENDING_FILE = join(DATA_DIR, "pending-submissions.json");
const APPROVED_FILE = join(DATA_DIR, "comparative-results.json");

// Ensure data directory exists
if (!existsSync(DATA_DIR)) {
  mkdirSync(DATA_DIR, { recursive: true });
}

// Initialize files if they don't exist
if (!existsSync(PENDING_FILE)) {
  writeFileSync(PENDING_FILE, JSON.stringify({ submissions: [] }, null, 2));
}
if (!existsSync(APPROVED_FILE)) {
  writeFileSync(APPROVED_FILE, JSON.stringify({ results: [], lastUpdated: new Date().toISOString() }, null, 2));
}

interface Submission {
  id: string;
  timestamp: string;
  shareUrl?: string;
  rawText: string;
  model?: string;
  evaluator?: string;
  status: "pending" | "approved" | "rejected";
}

interface RankingRow {
  solution: string;
  innovation: number;
  scalability: number;
  security: number;
  decentralization: number;
  ux: number;
  capitalEfficiency: number;
  total: number;
}

interface ComparisonResult {
  model: string;
  date: string;
  evaluator?: string;
  shareableLink?: string;
  rankings: RankingRow[];
  insights: string[];
}

function parseTa

ble(text: string): RankingRow[] | null {
  const lines = text.split('\n');
  const dataLines = lines.filter(line => line.trim().startsWith('|') && !line.includes('---'));

  if (dataLines.length < 2) return null; // Need at least header + 1 data row

  const rows: RankingRow[] = [];

  for (let i = 1; i < dataLines.length; i++) { // Skip header
    const parts = dataLines[i].split('|').map(p => p.trim()).filter(p => p);
    if (parts.length < 8) continue;

    rows.push({
      solution: parts[0],
      innovation: parseInt(parts[1]) || 0,
      scalability: parseInt(parts[2]) || 0,
      security: parseInt(parts[3]) || 0,
      decentralization: parseInt(parts[4]) || 0,
      ux: parseInt(parts[5]) || 0,
      capitalEfficiency: parseInt(parts[6]) || 0,
      total: parseInt(parts[7]) || 0,
    });
  }

  return rows.length > 0 ? rows : null;
}

function parseSubmission(text: string): Partial<ComparisonResult> | null {
  const modelMatch = text.match(/MODEL:\s*(.+)/i);
  const dateMatch = text.match(/DATE:\s*(\d{4}-\d{2}-\d{2})/i);
  const evaluatorMatch = text.match(/EVALUATOR:\s*(.+)/i);
  const shareMatch = text.match(/SHARE URL:\s*(.+)/i);

  const rankings = parseTable(text);
  if (!rankings) return null;

  const insightsSection = text.split(/KEY INSIGHTS?:/i)[1];
  const insights: string[] = [];
  if (insightsSection) {
    const lines = insightsSection.split('\n');
    for (const line of lines) {
      const match = line.match(/^\d+\.\s*(.+)/);
      if (match) insights.push(match[1].trim());
    }
  }

  return {
    model: modelMatch?.[1]?.trim() || "Unknown",
    date: dateMatch?.[1] || new Date().toISOString().split('T')[0],
    evaluator: evaluatorMatch?.[1]?.trim(),
    shareableLink: shareMatch?.[1]?.trim(),
    rankings,
    insights,
  };
}

serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    // CORS headers
    const headers = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Content-Type": "application/json",
    };

    if (req.method === "OPTIONS") {
      return new Response(null, { headers });
    }

    // GET /api/results - Get approved results
    if (url.pathname === "/api/results" && req.method === "GET") {
      const data = readFileSync(APPROVED_FILE, "utf-8");
      return new Response(data, { headers });
    }

    // POST /api/submit - Submit new evaluation
    if (url.pathname === "/api/submit" && req.method === "POST") {
      try {
        const body = await req.json();
        const { shareUrl, rawText } = body;

        if (!rawText || rawText.length < 100) {
          return new Response(JSON.stringify({ error: "Invalid submission: text too short" }), {
            status: 400,
            headers
          });
        }

        // Parse submission
        const parsed = parseSubmission(rawText);
        if (!parsed || !parsed.rankings) {
          return new Response(JSON.stringify({ error: "Invalid format: Could not parse table" }), {
            status: 400,
            headers
          });
        }

        // Create submission
        const submission: Submission = {
          id: `sub_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
          timestamp: new Date().toISOString(),
          shareUrl: shareUrl || parsed.shareableLink,
          rawText,
          model: parsed.model,
          evaluator: parsed.evaluator,
          status: "pending",
        };

        // Add to pending
        const pendingData = JSON.parse(readFileSync(PENDING_FILE, "utf-8"));
        pendingData.submissions.push(submission);
        writeFileSync(PENDING_FILE, JSON.stringify(pendingData, null, 2));

        return new Response(JSON.stringify({
          success: true,
          submissionId: submission.id,
          parsed: parsed
        }), { headers });

      } catch (error) {
        return new Response(JSON.stringify({ error: "Failed to process submission" }), {
          status: 500,
          headers
        });
      }
    }

    // GET /api/pending - Get pending submissions (admin only - add auth later)
    if (url.pathname === "/api/pending" && req.method === "GET") {
      const data = readFileSync(PENDING_FILE, "utf-8");
      return new Response(data, { headers });
    }

    // POST /api/approve/:id - Approve submission (admin only)
    if (url.pathname.startsWith("/api/approve/") && req.method === "POST") {
      try {
        const id = url.pathname.split("/").pop();

        const pendingData = JSON.parse(readFileSync(PENDING_FILE, "utf-8"));
        const submission = pendingData.submissions.find((s: Submission) => s.id === id);

        if (!submission) {
          return new Response(JSON.stringify({ error: "Submission not found" }), {
            status: 404,
            headers
          });
        }

        // Parse and add to approved
        const parsed = parseSubmission(submission.rawText);
        if (parsed && parsed.rankings) {
          const approvedData = JSON.parse(readFileSync(APPROVED_FILE, "utf-8"));
          approvedData.results.push({
            ...parsed,
            submissionId: submission.id,
            approvedAt: new Date().toISOString(),
          });
          approvedData.lastUpdated = new Date().toISOString();
          writeFileSync(APPROVED_FILE, JSON.stringify(approvedData, null, 2));

          // Also copy to frontend/static for deployment
          const frontendPath = join(import.meta.dir, "frontend/static/comparative-results.json");
          writeFileSync(frontendPath, JSON.stringify(approvedData, null, 2));
        }

        // Remove from pending
        pendingData.submissions = pendingData.submissions.filter((s: Submission) => s.id !== id);
        writeFileSync(PENDING_FILE, JSON.stringify(pendingData, null, 2));

        return new Response(JSON.stringify({ success: true }), { headers });

      } catch (error) {
        return new Response(JSON.stringify({ error: "Failed to approve" }), {
          status: 500,
          headers
        });
      }
    }

    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
      headers
    });
  },
});

console.log(`✅ XLN API Server running on http://localhost:${PORT}`);
console.log(`📊 Data directory: ${DATA_DIR}`);
console.log(`\nEndpoints:`);
console.log(`  POST /api/submit - Submit evaluation`);
console.log(`  GET  /api/results - Get approved results`);
console.log(`  GET  /api/pending - Get pending submissions (admin)`);
console.log(`  POST /api/approve/:id - Approve submission (admin)`);
