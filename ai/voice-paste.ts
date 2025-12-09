/**
 * XLN Voice Paste - Push-to-talk transcription
 *
 * Usage: bun run voice-paste.ts
 * Default: Hold Left Ctrl to record, release to transcribe & paste
 */

import { GlobalKeyboardListener } from "node-global-key-listener";
import { spawn, ChildProcess } from "child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";

const RECORDS_DIR = join(process.env.HOME || "~", "records");
const CONFIG_PATH = join(process.env.HOME || "~", ".xln-voice-config.json");

// Ensure recordings directory exists
if (!existsSync(RECORDS_DIR)) {
  mkdirSync(RECORDS_DIR, { recursive: true });
}

// ============================================================================
// CONFIG
// ============================================================================

interface VoiceConfig {
  hotkey: string;           // e.g. "LEFT CTRL"
  model: string;            // whisper model size
  language?: string;        // optional language hint
  pasteDelay: number;       // ms delay before pasting (for app switching)
}

function loadConfig(): VoiceConfig {
  const defaults: VoiceConfig = {
    hotkey: "LEFT CTRL",
    model: "large-v3",
    pasteDelay: 100,
  };

  if (existsSync(CONFIG_PATH)) {
    try {
      const loaded = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
      return { ...defaults, ...loaded };
    } catch (e) {
      console.error("Failed to load config, using defaults:", e);
    }
  }

  return defaults;
}

function saveConfig(config: VoiceConfig): void {
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

// ============================================================================
// RECORDING STATE
// ============================================================================

let config = loadConfig();
let recording = false;
let recordingProcess: ChildProcess | null = null;
let currentRecordingPath: string | null = null;
let recordingStartTime: number = 0;
let statusInterval: NodeJS.Timeout | null = null;

// ============================================================================
// AUDIO RECORDING (sox)
// ============================================================================

function startRecording(): void {
  if (recording) return;

  recording = true;
  recordingStartTime = Date.now();

  // Create filename: YYYY-MM-DD/HH-MM-SS.wav
  const now = new Date();
  const dateStr = now.toISOString().split("T")[0];
  const timeStr = now.toTimeString().split(" ")[0].replace(/:/g, "-");

  const dayDir = join(RECORDS_DIR, dateStr);
  if (!existsSync(dayDir)) {
    mkdirSync(dayDir, { recursive: true });
  }

  currentRecordingPath = join(dayDir, `${timeStr}.wav`);

  // Start sox recording
  recordingProcess = spawn("rec", [
    currentRecordingPath,
    "rate", "16k",     // 16kHz sample rate (whisper standard)
    "channels", "1",   // mono
    "silence", "1", "0.1", "0.1%", // trim initial silence
  ]);

  console.log(`\n🎤 RECORDING... (${currentRecordingPath})`);

  // Show recording duration every second
  statusInterval = setInterval(() => {
    const duration = ((Date.now() - recordingStartTime) / 1000).toFixed(1);
    process.stdout.write(`\r🎤 RECORDING... (${duration}s)`);
  }, 100);

  recordingProcess.on("error", (err) => {
    console.error("\n❌ Recording error:", err.message);
    if (err.message.includes("ENOENT")) {
      console.error("   Install sox: brew install sox");
    }
    cleanup();
  });
}

function stopRecording(): void {
  if (!recording || !recordingProcess) return;

  recording = false;

  if (statusInterval) {
    clearInterval(statusInterval);
    statusInterval = null;
  }

  // Stop sox (SIGTERM = clean stop)
  recordingProcess.kill("SIGTERM");
  recordingProcess = null;

  const duration = ((Date.now() - recordingStartTime) / 1000).toFixed(1);
  console.log(`\n⏹️  Stopped (${duration}s) - Processing...`);

  // Transcribe after short delay (let sox finish writing)
  setTimeout(() => {
    if (currentRecordingPath) {
      transcribeAndPaste(currentRecordingPath);
    }
  }, 200);
}

function cleanup(): void {
  recording = false;
  recordingProcess = null;
  currentRecordingPath = null;
  if (statusInterval) {
    clearInterval(statusInterval);
    statusInterval = null;
  }
}

// ============================================================================
// TRANSCRIPTION (mlx-whisper)
// ============================================================================

async function transcribeAndPaste(audioPath: string): Promise<void> {
  if (!existsSync(audioPath)) {
    console.error("❌ Audio file not found:", audioPath);
    return;
  }

  try {
    // Try HTTP server first (faster)
    const MLX_WHISPER_URL = "http://localhost:5001/transcribe";

    try {
      const audioBuffer = readFileSync(audioPath);
      const formData = new FormData();
      formData.append("file", new Blob([audioBuffer]), "audio.wav");

      const response = await fetch(MLX_WHISPER_URL, {
        method: "POST",
        body: formData,
      });

      if (response.ok) {
        const result = await response.json();
        const text = result.text || result.transcription || "";

        if (text.trim()) {
          console.log(`✅ Transcribed: "${text}"`);
          await pasteText(text);
        } else {
          console.log("⚠️  Empty transcription (silence?)");
        }
        return;
      }
    } catch (e) {
      console.log("⚠️  HTTP server unavailable, using CLI...");
    }

    // Fallback to CLI
    await transcribeCLI(audioPath);

  } catch (error) {
    console.error("❌ Transcription error:", error);
  }
}

function transcribeCLI(audioPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = [audioPath, "--model", config.model, "--output-format", "txt"];
    if (config.language) {
      args.push("--language", config.language);
    }

    const proc = spawn("mlx_whisper", args);

    let output = "";
    let error = "";

    proc.stdout.on("data", (d) => { output += d.toString(); });
    proc.stderr.on("data", (d) => { error += d.toString(); });

    proc.on("error", (err) => {
      if (err.message.includes("ENOENT")) {
        console.error("❌ mlx_whisper not found. Install: pip install mlx-whisper");
      }
      reject(err);
    });

    proc.on("close", async (code) => {
      if (code === 0) {
        // Check for .txt file
        const txtPath = audioPath.replace(/\.[^.]+$/, ".txt");
        let text = "";

        if (existsSync(txtPath)) {
          text = readFileSync(txtPath, "utf-8").trim();
        } else {
          text = output.trim();
        }

        if (text) {
          console.log(`✅ Transcribed: "${text}"`);
          await pasteText(text);
        } else {
          console.log("⚠️  Empty transcription (silence?)");
        }
        resolve();
      } else {
        console.error("❌ Transcription failed:", error || `Exit code ${code}`);
        reject(new Error(error || `Exit code ${code}`));
      }
    });
  });
}

// ============================================================================
// PASTE (osascript)
// ============================================================================

async function pasteText(text: string): Promise<void> {
  // Wait for configured delay (allows app switching)
  if (config.pasteDelay > 0) {
    await new Promise(r => setTimeout(r, config.pasteDelay));
  }

  // Escape special characters for AppleScript
  const escaped = text
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n");

  // Use AppleScript to type the text
  const script = `tell application "System Events" to keystroke "${escaped}"`;

  const proc = spawn("osascript", ["-e", script]);

  proc.on("error", (err) => {
    console.error("❌ Paste error:", err.message);
    console.log("   Falling back to clipboard...");
    fallbackToClipboard(text);
  });

  proc.on("close", (code) => {
    if (code !== 0) {
      console.error("❌ Paste failed, falling back to clipboard...");
      fallbackToClipboard(text);
    }
  });
}

function fallbackToClipboard(text: string): void {
  const proc = spawn("pbcopy");
  proc.stdin.write(text);
  proc.stdin.end();

  proc.on("close", (code) => {
    if (code === 0) {
      console.log("📋 Copied to clipboard (paste with Cmd+V)");
    } else {
      console.error("❌ Clipboard failed");
    }
  });
}

// ============================================================================
// HOTKEY LISTENER
// ============================================================================

function startListener(): void {
  const listener = new GlobalKeyboardListener();

  console.log(`
╔══════════════════════════════════════════════════════════════════╗
║              XLN Voice Paste - Ready                             ║
╠══════════════════════════════════════════════════════════════════╣
║  Hotkey: ${config.hotkey.padEnd(55)} ║
║  Model:  ${config.model.padEnd(55)} ║
║  Output: ~/records/YYYY-MM-DD/HH-MM-SS.wav                       ║
╠══════════════════════════════════════════════════════════════════╣
║  Press and HOLD ${config.hotkey} to record                          ║
║  Release to transcribe and paste                                 ║
╠══════════════════════════════════════════════════════════════════╣
║  Config: ~/.xln-voice-config.json                                ║
║  Recordings: ~/records/                                          ║
╚══════════════════════════════════════════════════════════════════╝
`);

  listener.addListener((e, down) => {
    // Normalize key name
    const keyName = e.name.toUpperCase();
    const targetKey = config.hotkey.toUpperCase();

    if (keyName === targetKey) {
      if (down[keyName]) {
        startRecording();
      } else {
        stopRecording();
      }
    }
  });

  // Handle Ctrl+C gracefully
  process.on("SIGINT", () => {
    console.log("\n\n👋 Shutting down...");
    cleanup();
    process.exit(0);
  });
}

// ============================================================================
// MAIN
// ============================================================================

// Check dependencies on startup
async function checkDeps(): Promise<boolean> {
  let hasErrors = false;

  // Check sox
  try {
    await new Promise<void>((resolve, reject) => {
      const proc = spawn("which", ["rec"]);
      proc.on("close", (code) => code === 0 ? resolve() : reject());
    });
  } catch {
    console.error("❌ sox not found. Install: brew install sox");
    hasErrors = true;
  }

  // Check mlx_whisper
  try {
    await new Promise<void>((resolve, reject) => {
      const proc = spawn("which", ["mlx_whisper"]);
      proc.on("close", (code) => code === 0 ? resolve() : reject());
    });
  } catch {
    console.error("❌ mlx_whisper not found. Install: pip install mlx-whisper");
    hasErrors = true;
  }

  return !hasErrors;
}

// Entry point
(async () => {
  const depsOk = await checkDeps();

  if (!depsOk) {
    console.error("\n⚠️  Missing dependencies. Please install them first.\n");
    process.exit(1);
  }

  startListener();
})();
