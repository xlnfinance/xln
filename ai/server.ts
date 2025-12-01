/**
 * XLN AI Server - Local AI Council
 *
 * Combines:
 * - Karpathy's LLM Council (3-stage deliberation with anonymized peer review)
 * - XLN multiagent protocol (file-based coordination, papertrail)
 * - Local models via Ollama + MLX
 *
 * @see https://github.com/karpathy/llm-council
 * @see .agents/multiagent.md
 */

import { serve } from "bun";
import { spawn } from "child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "fs";
import { join } from "path";

const PORT = 3031;
const OLLAMA_URL = "http://localhost:11434";
const MLX_GEMMA_URL = "http://localhost:8082";   // Gemma3 27B MLX
const MLX_DEEPSEEK_URL = "http://localhost:8081"; // DeepSeek-V3 MLX (when ready)
const MLX_URL = MLX_GEMMA_URL; // Default MLX endpoint
const CHATS_DIR = "/Users/zigota/ai/chats";
const AGENTS_DIR = "/Users/zigota/xln/.agents";

// Ensure directories exist
[CHATS_DIR, `${CHATS_DIR}/audio`, `${AGENTS_DIR}/papertrail`].forEach(dir => {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
});

// ============================================================================
// MODEL REGISTRY
// ============================================================================

interface ModelInfo {
  name: string;
  params: string;
  backend: "ollama" | "mlx" | "mlx_vision";
  vision: boolean;
  path?: string;
  command?: string;
}

const MODELS: Record<string, ModelInfo> = {
  // Ollama models (GGUF)
  "gpt-oss:120b": { name: "GPT-OSS 120B", params: "120B", backend: "ollama", vision: false },
  "huihui_ai/qwen3-abliterated:235b": { name: "Qwen3 Abliterated 235B", params: "235B", backend: "ollama", vision: false },
  "qwen3-coder:latest": { name: "Qwen3 Coder 32B", params: "32B", backend: "ollama", vision: false },
  // MLX models (native Apple Silicon) - actual models on disk
  "qwen3-235b-mlx": { name: "Qwen3 235B MLX", params: "235B", backend: "mlx", vision: false, path: "~/models/Qwen3-235B-MLX-4bit" },
  "gpt-oss-120b-mlx": { name: "GPT-OSS 120B MLX", params: "120B", backend: "mlx", vision: false, path: "~/models/gpt-oss-120b-heretic-mlx" },
  "deepseek-v3-mlx": { name: "DeepSeek-V3 MLX", params: "671B", backend: "mlx", vision: false, path: "~/models/DeepSeek-V3-MLX-4bit" },
  "deepseek-v3.1-mlx": { name: "DeepSeek-V3.1 MLX", params: "671B", backend: "mlx", vision: false, path: "~/models/DeepSeek-V3.1-4bit-mlx" },
  "glm-4.5-mlx": { name: "GLM-4.5 Air MLX", params: "9B", backend: "mlx", vision: false, path: "~/models/GLM-4.5-Air-mlx" },
  "minimax-m2-mlx": { name: "MiniMax M2 MLX", params: "8B", backend: "mlx", vision: false, path: "~/models/MiniMax-M2-8bit-mlx" },
  "kimi-vl-mlx": { name: "Kimi-VL A3B MLX", params: "3B", backend: "mlx_vision", vision: true, path: "~/models/Kimi-VL-A3B-Thinking-8bit-mlx" },
};

// Default model
const DEFAULT_MODEL = "huihui_ai/qwen3-abliterated:235b";

// Council configuration
const COUNCIL_MODELS = ["gpt-oss:120b", "qwen3-coder:latest", "huihui_ai/qwen3-abliterated:235b"];
const CHAIRMAN_MODEL = "gpt-oss:120b";

// ============================================================================
// TYPES
// ============================================================================

interface Message {
  role: "user" | "assistant" | "system";
  content: string;
  images?: string[];
  model?: string;
  timestamp?: string;
}

interface CouncilResponse {
  stage1: Record<string, string>;  // model -> response
  stage2: Record<string, { rankings: Record<string, number>; reasoning: string }>;
  stage3: string;  // chairman synthesis
  chairman: string;
}

interface ChatSession {
  id: string;
  title: string;
  messages: Message[];
  council_mode: boolean;
  created_at: string;
  updated_at: string;
}

// ============================================================================
// OLLAMA API
// ============================================================================

async function queryOllama(
  model: string,
  messages: Message[],
  options: { stream?: boolean; images?: string[] } = {}
): Promise<Response | string> {
  const { stream = false, images } = options;

  // Add images to last user message if provided
  const processedMessages = messages.map((m, i) => {
    if (i === messages.length - 1 && m.role === "user" && images?.length) {
      return { ...m, images };
    }
    return { role: m.role, content: m.content };
  });

  const body = { model, messages: processedMessages, stream };

  const response = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (stream) return response;

  const data = await response.json();
  return data.message?.content || "";
}

// ============================================================================
// MLX API (OpenAI compatible)
// ============================================================================

async function queryMLX(
  messages: Message[],
  options: { stream?: boolean; model?: string } = {}
): Promise<Response | string> {
  const { stream = false, model = "gemma3-27b-mlx" } = options;

  // Select endpoint based on model
  const endpoint = model.includes("deepseek") ? MLX_DEEPSEEK_URL : MLX_GEMMA_URL;

  const body = {
    model: "default",
    messages: messages.map(m => ({ role: m.role, content: m.content })),
    stream,
    max_tokens: 2048,
  };

  const response = await fetch(`${endpoint}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (stream) return response;

  const data = await response.json();
  return data.choices?.[0]?.message?.content || "";
}

// ============================================================================
// COUNCIL MODE (Karpathy-style 3-stage deliberation)
// ============================================================================

async function runCouncil(query: string, models: string[] = COUNCIL_MODELS): Promise<CouncilResponse> {
  const timestamp = new Date().toISOString();

  // Stage 1: Get individual responses
  console.log("Council Stage 1: Gathering individual responses...");
  const stage1: Record<string, string> = {};

  await Promise.all(models.map(async (model) => {
    try {
      const response = await queryOllama(model, [{ role: "user", content: query }]);
      stage1[model] = response as string;
    } catch (e) {
      stage1[model] = `[Error: ${e instanceof Error ? e.message : "Unknown error"}]`;
    }
  }));

  // Stage 2: Peer review (anonymized)
  console.log("Council Stage 2: Peer review...");
  const stage2: Record<string, { rankings: Record<string, number>; reasoning: string }> = {};

  const anonymousLabels = ["Response A", "Response B", "Response C", "Response D", "Response E"];
  const modelToLabel: Record<string, string> = {};
  const labelToModel: Record<string, string> = {};

  models.forEach((model, i) => {
    modelToLabel[model] = anonymousLabels[i];
    labelToModel[anonymousLabels[i]] = model;
  });

  const reviewPrompt = (reviewerModel: string) => {
    const otherResponses = models
      .filter(m => m !== reviewerModel)
      .map(m => `### ${modelToLabel[m]}\n${stage1[m]}`)
      .join("\n\n");

    return `You are reviewing responses to this query:
"${query}"

Here are the anonymized responses from other council members:

${otherResponses}

Your task:
1. Rank each response from 1-10 on: accuracy, insight, clarity
2. Identify the best response and explain why
3. Note any errors or improvements

Format your response as:
RANKINGS:
${models.filter(m => m !== reviewerModel).map(m => `- ${modelToLabel[m]}: [score]/10`).join("\n")}

BEST: [label]

REASONING: [your analysis]`;
  };

  await Promise.all(models.map(async (model) => {
    try {
      const response = await queryOllama(model, [
        { role: "system", content: "You are a thoughtful reviewer evaluating AI responses." },
        { role: "user", content: reviewPrompt(model) }
      ]) as string;

      // Parse rankings (simple extraction)
      const rankings: Record<string, number> = {};
      const rankingMatches = response.matchAll(/Response ([A-E]):\s*(\d+)/g);
      for (const match of rankingMatches) {
        const label = `Response ${match[1]}`;
        if (labelToModel[label]) {
          rankings[labelToModel[label]] = parseInt(match[2]);
        }
      }

      stage2[model] = { rankings, reasoning: response };
    } catch (e) {
      stage2[model] = { rankings: {}, reasoning: `[Error: ${e instanceof Error ? e.message : "Unknown"}]` };
    }
  }));

  // Stage 3: Chairman synthesis
  console.log("Council Stage 3: Chairman synthesis...");
  const allResponses = models
    .map(m => `### ${m}\n${stage1[m]}`)
    .join("\n\n");

  const allReviews = models
    .map(m => `### Review by ${m}\n${stage2[m].reasoning}`)
    .join("\n\n");

  const synthesisPrompt = `You are the Chairman of an LLM Council. Your task is to synthesize the best possible answer from multiple AI responses and their peer reviews.

ORIGINAL QUERY:
"${query}"

INDIVIDUAL RESPONSES:
${allResponses}

PEER REVIEWS:
${allReviews}

Your task:
1. Identify the strongest insights from each response
2. Correct any errors noted in reviews
3. Synthesize a comprehensive, accurate final answer
4. Be concise but thorough

FINAL SYNTHESIS:`;

  let stage3: string;
  try {
    stage3 = await queryOllama(CHAIRMAN_MODEL, [
      { role: "system", content: "You are the Chairman of an LLM Council, synthesizing the best answer." },
      { role: "user", content: synthesisPrompt }
    ]) as string;
  } catch (e) {
    stage3 = `[Chairman error: ${e instanceof Error ? e.message : "Unknown"}]`;
  }

  // Log to papertrail
  const papertrailPath = join(AGENTS_DIR, "papertrail", new Date().toISOString().split("T")[0]);
  if (!existsSync(papertrailPath)) mkdirSync(papertrailPath, { recursive: true });

  const logContent = `# Council Deliberation @ ${timestamp}

## Query
${query}

## Stage 1: Individual Responses
${Object.entries(stage1).map(([m, r]) => `### ${m}\n${r}`).join("\n\n")}

## Stage 2: Peer Reviews
${Object.entries(stage2).map(([m, r]) => `### ${m}\n${r.reasoning}`).join("\n\n")}

## Stage 3: Chairman Synthesis (${CHAIRMAN_MODEL})
${stage3}
`;

  writeFileSync(join(papertrailPath, `council-${Date.now()}.md`), logContent);

  return { stage1, stage2, stage3, chairman: CHAIRMAN_MODEL };
}

// ============================================================================
// SPEECH-TO-TEXT (mlx-whisper)
// ============================================================================

async function transcribeAudio(audioPath: string): Promise<string> {
  const MLX_WHISPER_URL = "http://localhost:5001/transcribe";

  try {
    // Try HTTP server first (faster, recommended)
    const audioBuffer = readFileSync(audioPath);
    const formData = new FormData();
    formData.append("file", new Blob([audioBuffer]), "audio.webm");

    const response = await fetch(MLX_WHISPER_URL, {
      method: "POST",
      body: formData,
    });

    if (response.ok) {
      const result = await response.json();
      return result.text || result.transcription || "";
    }

    // Fallback to CLI if HTTP fails
    console.log("MLX Whisper HTTP unavailable, falling back to CLI...");
  } catch (e) {
    console.log("MLX Whisper HTTP error, falling back to CLI:", e);
  }

  // CLI fallback
  return new Promise((resolve, reject) => {
    const proc = spawn("mlx_whisper", [audioPath, "--model", "large-v3", "--output-format", "txt"]);

    let output = "";
    let error = "";

    proc.stdout.on("data", (d) => { output += d.toString(); });
    proc.stderr.on("data", (d) => { error += d.toString(); });

    proc.on("close", (code) => {
      if (code === 0) {
        const txtPath = audioPath.replace(/\.[^.]+$/, ".txt");
        if (existsSync(txtPath)) {
          resolve(readFileSync(txtPath, "utf-8").trim());
        } else {
          resolve(output.trim());
        }
      } else {
        reject(new Error(error || `Exit code ${code}`));
      }
    });
  });
}

// ============================================================================
// TEXT-TO-SPEECH (piper)
// ============================================================================

async function synthesizeSpeech(text: string, outputPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn("piper", ["--model", "en_US-lessac-medium", "--output_file", outputPath]);
    } catch (err: any) {
      // Bun throws synchronously on ENOENT
      if (err.code === "ENOENT") {
        return reject(new Error("TTS_NOT_AVAILABLE: piper not installed. Install with: brew install piper"));
      }
      return reject(err);
    }

    proc.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        reject(new Error("TTS_NOT_AVAILABLE: piper not installed. Install with: brew install piper"));
      } else {
        reject(err);
      }
    });

    proc.stdin.write(text);
    proc.stdin.end();

    let error = "";
    proc.stderr.on("data", (d) => { error += d.toString(); });

    proc.on("close", (code) => {
      if (code === 0) resolve(outputPath);
      else reject(new Error(error || `Exit code ${code}`));
    });
  });
}

// ============================================================================
// CHAT PERSISTENCE (Obsidian-compatible .md)
// ============================================================================

function saveChatToMarkdown(session: ChatSession): void {
  const filename = `${session.id}.md`;
  const filepath = join(CHATS_DIR, filename);

  const content = `---
id: ${session.id}
title: "${session.title}"
council_mode: ${session.council_mode}
created: ${session.created_at}
updated: ${session.updated_at}
---

# ${session.title}

${session.messages.map(m => {
  const prefix = m.role === "user" ? "**User**" : m.role === "assistant" ? `**${m.model || "Assistant"}**` : "**System**";
  const time = m.timestamp ? ` (${m.timestamp})` : "";
  return `${prefix}${time}:\n${m.content}\n`;
}).join("\n---\n\n")}
`;

  writeFileSync(filepath, content);
}

function loadChat(id: string): ChatSession | null {
  const filepath = join(CHATS_DIR, `${id}.md`);
  if (!existsSync(filepath)) return null;

  const content = readFileSync(filepath, "utf-8");

  // Parse YAML frontmatter
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!frontmatterMatch) return null;

  const frontmatter = frontmatterMatch[1];
  const idMatch = frontmatter.match(/id:\s*(.+)/);
  const titleMatch = frontmatter.match(/title:\s*"(.+)"/);
  const councilMatch = frontmatter.match(/council_mode:\s*(.+)/);
  const createdMatch = frontmatter.match(/created:\s*(.+)/);
  const updatedMatch = frontmatter.match(/updated:\s*(.+)/);

  // Parse messages (simplified)
  const messages: Message[] = [];
  const messageBlocks = content.split(/\n---\n\n/).slice(1);

  for (const block of messageBlocks) {
    const userMatch = block.match(/\*\*User\*\*[^:]*:\n([\s\S]*)/);
    const assistantMatch = block.match(/\*\*([^*]+)\*\*[^:]*:\n([\s\S]*)/);

    if (userMatch) {
      messages.push({ role: "user", content: userMatch[1].trim() });
    } else if (assistantMatch) {
      messages.push({ role: "assistant", content: assistantMatch[2].trim(), model: assistantMatch[1] });
    }
  }

  return {
    id: idMatch?.[1] || id,
    title: titleMatch?.[1] || "Untitled",
    messages,
    council_mode: councilMatch?.[1] === "true",
    created_at: createdMatch?.[1] || new Date().toISOString(),
    updated_at: updatedMatch?.[1] || new Date().toISOString(),
  };
}

function listChats(): { id: string; title: string; updated: string }[] {
  if (!existsSync(CHATS_DIR)) return [];

  const files = readdirSync(CHATS_DIR).filter(f => f.endsWith(".md"));
  const chats: { id: string; title: string; updated: string }[] = [];

  for (const file of files) {
    const content = readFileSync(join(CHATS_DIR, file), "utf-8");
    const titleMatch = content.match(/title:\s*"(.+)"/);
    const updatedMatch = content.match(/updated:\s*(.+)/);

    chats.push({
      id: file.replace(".md", ""),
      title: titleMatch?.[1] || "Untitled",
      updated: updatedMatch?.[1] || "",
    });
  }

  return chats.sort((a, b) => b.updated.localeCompare(a.updated));
}

// ============================================================================
// SERVICE HEALTH
// ============================================================================

async function checkServices(): Promise<Record<string, boolean>> {
  const services: Record<string, boolean> = {};

  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(2000) });
    services.ollama = res.ok;
  } catch { services.ollama = false; }

  try {
    const res = await fetch(`${MLX_GEMMA_URL}/v1/models`, { signal: AbortSignal.timeout(2000) });
    services.mlx_gemma = res.ok;
  } catch { services.mlx_gemma = false; }

  try {
    const res = await fetch(`${MLX_DEEPSEEK_URL}/v1/models`, { signal: AbortSignal.timeout(2000) });
    services.mlx_deepseek = res.ok;
  } catch { services.mlx_deepseek = false; }

  return services;
}

async function getOllamaModels(): Promise<string[]> {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`);
    const data = await res.json();
    return data.models?.map((m: { name: string }) => m.name) || [];
  } catch { return []; }
}

// ============================================================================
// HTTP SERVER
// ============================================================================

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

    // ========================================================================
    // GET /api/models - List available models
    // ========================================================================
    if (url.pathname === "/api/models" && req.method === "GET") {
      const services = await checkServices();
      const ollamaModels = services.ollama ? await getOllamaModels() : [];

      // Combine Ollama + MLX models
      const allModels = [
        // Ollama models
        ...ollamaModels.map(name => ({
          id: name,
          name,
          backend: "ollama" as const,
          available: true,
          vision: name.includes("vl") || name.includes("vision"),
        })),
        // MLX models from MODELS registry
        ...Object.entries(MODELS)
          .filter(([_, info]) => info.backend === "mlx" || info.backend === "mlx_vision")
          .map(([id, info]) => ({
            id,
            name: info.name,
            backend: info.backend,
            params: info.params,
            available: services.mlx_gemma || services.mlx_deepseek, // simplified check
            vision: info.vision,
            path: info.path,
          })),
      ];

      return new Response(JSON.stringify({
        services,
        default_model: DEFAULT_MODEL,
        council_models: COUNCIL_MODELS,
        chairman_model: CHAIRMAN_MODEL,
        models: allModels,
      }), { headers });
    }

    // ========================================================================
    // POST /api/chat - Single model chat (with optional streaming)
    // ========================================================================
    if (url.pathname === "/api/chat" && req.method === "POST") {
      try {
        const body = await req.json();
        const { model = DEFAULT_MODEL, messages, stream = false, images } = body;

        // Route to MLX if model is MLX-based
        const isMLX = model.includes("-mlx") || model.includes("gemma3-27b") || model.includes("deepseek-v3");

        if (isMLX) {
          // MLX models - OpenAI compatible API
          const response = await queryMLX(messages, { stream, model }) as Response | string;

          if (stream && response instanceof Response) {
            // Transform MLX SSE to our format
            const transformStream = new TransformStream({
              async transform(chunk, controller) {
                const text = new TextDecoder().decode(chunk);
                const lines = text.split("\n").filter(l => l.startsWith("data: "));

                for (const line of lines) {
                  const jsonStr = line.slice(6);
                  if (jsonStr === "[DONE]") {
                    controller.enqueue(new TextEncoder().encode(`data: [DONE]\n\n`));
                    continue;
                  }
                  try {
                    const data = JSON.parse(jsonStr);
                    const content = data.choices?.[0]?.delta?.content || "";
                    if (content) {
                      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ content })}\n\n`));
                    }
                  } catch {}
                }
              }
            });

            return new Response(response.body?.pipeThrough(transformStream), {
              headers: { ...headers, "Content-Type": "text/event-stream", "Cache-Control": "no-cache" }
            });
          }

          return new Response(JSON.stringify({ content: response, model }), { headers });
        }

        // Ollama models
        if (stream) {
          const response = await queryOllama(model, messages, { stream: true, images }) as Response;

          const transformStream = new TransformStream({
            async transform(chunk, controller) {
              const text = new TextDecoder().decode(chunk);
              const lines = text.split("\n").filter(l => l.trim());

              for (const line of lines) {
                try {
                  const data = JSON.parse(line);
                  const content = data.message?.content || "";
                  if (content) {
                    controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ content })}\n\n`));
                  }
                  if (data.done) {
                    controller.enqueue(new TextEncoder().encode(`data: [DONE]\n\n`));
                  }
                } catch {}
              }
            }
          });

          return new Response(response.body?.pipeThrough(transformStream), {
            headers: { ...headers, "Content-Type": "text/event-stream", "Cache-Control": "no-cache" }
          });
        }

        const response = await queryOllama(model, messages, { images }) as string;
        return new Response(JSON.stringify({ content: response, model }), { headers });

      } catch (error) {
        return new Response(JSON.stringify({ error: String(error) }), { status: 500, headers });
      }
    }

    // ========================================================================
    // POST /api/council - Council mode (3-stage deliberation)
    // ========================================================================
    if (url.pathname === "/api/council" && req.method === "POST") {
      try {
        const body = await req.json();
        const { query, models = COUNCIL_MODELS } = body;

        const result = await runCouncil(query, models);

        return new Response(JSON.stringify(result), { headers });
      } catch (error) {
        return new Response(JSON.stringify({ error: String(error) }), { status: 500, headers });
      }
    }

    // ========================================================================
    // POST /api/vision - Vision model query
    // ========================================================================
    if (url.pathname === "/api/vision" && req.method === "POST") {
      try {
        const formData = await req.formData();
        const model = formData.get("model") as string || "qwen3-vl:4b";
        const prompt = formData.get("prompt") as string || "What do you see?";
        const image = formData.get("image") as File;

        if (!image) {
          return new Response(JSON.stringify({ error: "No image" }), { status: 400, headers });
        }

        const buffer = await image.arrayBuffer();
        const base64 = Buffer.from(buffer).toString("base64");

        const response = await queryOllama(model, [
          { role: "user", content: prompt }
        ], { images: [base64] }) as string;

        return new Response(JSON.stringify({ content: response, model }), { headers });
      } catch (error) {
        return new Response(JSON.stringify({ error: String(error) }), { status: 500, headers });
      }
    }

    // ========================================================================
    // POST /api/transcribe - Speech-to-Text
    // ========================================================================
    if (url.pathname === "/api/transcribe" && req.method === "POST") {
      try {
        const formData = await req.formData();
        const audio = formData.get("audio") as File;

        if (!audio) {
          return new Response(JSON.stringify({ error: "No audio" }), { status: 400, headers });
        }

        const tmpPath = `/tmp/xln_audio_${Date.now()}.wav`;
        const buffer = await audio.arrayBuffer();
        writeFileSync(tmpPath, Buffer.from(buffer));

        const transcript = await transcribeAudio(tmpPath);

        return new Response(JSON.stringify({ transcript }), { headers });
      } catch (error) {
        return new Response(JSON.stringify({ error: String(error) }), { status: 500, headers });
      }
    }

    // ========================================================================
    // POST /api/synthesize - Text-to-Speech
    // ========================================================================
    if (url.pathname === "/api/synthesize" && req.method === "POST") {
      try {
        const body = await req.json();
        const { text } = body;

        if (!text) {
          return new Response(JSON.stringify({ error: "No text" }), { status: 400, headers });
        }

        const outputPath = `/tmp/xln_tts_${Date.now()}.wav`;
        await synthesizeSpeech(text, outputPath);

        const audioBuffer = readFileSync(outputPath);
        return new Response(audioBuffer, {
          headers: { ...headers, "Content-Type": "audio/wav" }
        });
      } catch (error) {
        return new Response(JSON.stringify({ error: String(error) }), { status: 500, headers });
      }
    }

    // ========================================================================
    // GET /api/chats - List saved chats
    // ========================================================================
    if (url.pathname === "/api/chats" && req.method === "GET") {
      return new Response(JSON.stringify({ chats: listChats() }), { headers });
    }

    // ========================================================================
    // GET /api/chats/:id - Load specific chat
    // ========================================================================
    if (url.pathname.startsWith("/api/chats/") && req.method === "GET") {
      const id = url.pathname.split("/").pop();
      if (!id) {
        return new Response(JSON.stringify({ error: "No ID" }), { status: 400, headers });
      }

      const chat = loadChat(id);
      if (!chat) {
        return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers });
      }

      return new Response(JSON.stringify(chat), { headers });
    }

    // ========================================================================
    // POST /api/chats - Save chat
    // ========================================================================
    if (url.pathname === "/api/chats" && req.method === "POST") {
      try {
        const session: ChatSession = await req.json();
        session.updated_at = new Date().toISOString();
        saveChatToMarkdown(session);
        return new Response(JSON.stringify({ success: true, id: session.id }), { headers });
      } catch (error) {
        return new Response(JSON.stringify({ error: String(error) }), { status: 500, headers });
      }
    }

    // ========================================================================
    // GET /api/health
    // ========================================================================
    if (url.pathname === "/api/health") {
      const services = await checkServices();
      return new Response(JSON.stringify({ status: "ok", services }), { headers });
    }

    return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers });
  },
});

console.log(`
╔══════════════════════════════════════════════════════════════════╗
║                    XLN AI Council Server                         ║
╠══════════════════════════════════════════════════════════════════╣
║  Port: ${PORT}                                                      ║
║  URL:  http://localhost:${PORT}                                     ║
╠══════════════════════════════════════════════════════════════════╣
║  Endpoints:                                                      ║
║    GET  /api/models      - List available models                 ║
║    POST /api/chat        - Single model chat (streaming)         ║
║    POST /api/council     - Council mode (3-stage deliberation)   ║
║    POST /api/vision      - Vision model query                    ║
║    POST /api/transcribe  - Speech-to-text (mlx-whisper)          ║
║    POST /api/synthesize  - Text-to-speech (piper)                ║
║    GET  /api/chats       - List saved chats                      ║
║    POST /api/chats       - Save chat (Obsidian .md)              ║
╠══════════════════════════════════════════════════════════════════╣
║  Council: ${COUNCIL_MODELS.join(", ").slice(0, 40)}...            ║
║  Chairman: ${CHAIRMAN_MODEL}                                      ║
╚══════════════════════════════════════════════════════════════════╝
`);
