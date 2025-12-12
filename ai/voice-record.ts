/**
 * XLN Voice Record - Simple command-line voice transcription
 *
 * Usage:
 *   bun run voice-record.ts
 *   (records until you press Enter, then transcribes and copies to clipboard)
 *
 * Bind to keyboard shortcut:
 *   macOS: System Settings → Keyboard → Keyboard Shortcuts → Services
 *   Or use Hammerspoon/Karabiner-Elements
 */

import { spawn } from "child_process";
import { existsSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";
import * as readline from "readline";

const RECORDS_DIR = join(process.env.HOME || "~", "records");

// Ensure recordings directory exists
if (!existsSync(RECORDS_DIR)) {
  mkdirSync(RECORDS_DIR, { recursive: true });
}

let recordingProcess: any = null;
let currentRecordingPath: string | null = null;

function startRecording(): void {
  const now = new Date();
  const dateStr = now.toISOString().split("T")[0];
  const timeStr = now.toTimeString().split(" ")[0].replace(/:/g, "-");

  const dayDir = join(RECORDS_DIR, dateStr);
  if (!existsSync(dayDir)) {
    mkdirSync(dayDir, { recursive: true });
  }

  currentRecordingPath = join(dayDir, `${timeStr}.wav`);

  console.log(`\n🎤 Recording to: ${currentRecordingPath}`);
  console.log("   Press ENTER to stop...\n");

  recordingProcess = spawn("rec", [
    currentRecordingPath,
    "rate", "16k",
    "channels", "1",
    "silence", "1", "0.1", "0.1%",
  ], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  recordingProcess.on("error", (err: Error) => {
    console.error("❌ Recording error:", err.message);
    if (err.message.includes("ENOENT")) {
      console.error("   Install sox: brew install sox");
    }
  });
}

function stopRecording(): void {
  if (recordingProcess) {
    recordingProcess.kill("SIGTERM");
    console.log("⏹️  Stopped. Processing...\n");

    setTimeout(() => {
      if (currentRecordingPath) {
        transcribeAndCopy(currentRecordingPath);
      }
    }, 300);
  }
}

async function transcribeAndCopy(audioPath: string): Promise<void> {
  if (!existsSync(audioPath)) {
    console.error("❌ Audio file not found:", audioPath);
    process.exit(1);
  }

  try {
    // Try HTTP server first
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
          copyToClipboard(text);
          return;
        }
      }
    } catch (e) {
      // Fallback to CLI
    }

    // CLI transcription
    await transcribeCLI(audioPath);

  } catch (error) {
    console.error("❌ Transcription error:", error);
    process.exit(1);
  }
}

function transcribeCLI(audioPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const outputDir = join(process.env.HOME || "~", "xln", "ai");

    // Note: Language auto-detection works well for Russian/English
    // Can specify --language Russian or --language English if needed
    const proc = spawn("mlx_whisper", [
      audioPath,
      "--model", "mlx-community/whisper-large-v3-mlx",
      "--output-format", "txt",
      "--output-dir", outputDir,
      "--verbose", "False",
      // Auto-detects Russian/English/etc. Remove this line to force a specific language
    ], {
      env: { ...process.env, PATH: `/Users/zigota/Library/Python/3.9/bin:${process.env.PATH}` },
      cwd: outputDir,
    });

    let output = "";
    let error = "";

    proc.stdout.on("data", (d) => { output += d.toString(); });
    proc.stderr.on("data", (d) => { error += d.toString(); });

    proc.on("error", (err) => {
      if (err.message.includes("ENOENT")) {
        console.error("❌ mlx_whisper not found");
      }
      reject(err);
    });

    proc.on("close", (code) => {
      if (code === 0) {
        // Check for txt file in output dir
        const audioFilename = audioPath.split("/").pop()!.replace(/\.[^.]+$/, "");
        const txtPath = join(outputDir, `${audioFilename}.txt`);

        let text = "";
        if (existsSync(txtPath)) {
          text = readFileSync(txtPath, "utf-8").trim();
        } else {
          // Fallback: parse stdout
          text = output
            .split("\n")
            .map(line => line.replace(/^\[[\d:.]+\s*-->\s*[\d:.]+\]\s*/, "").trim())
            .filter(line => line && !line.startsWith("Args:") && !line.startsWith("Detecting") && !line.startsWith("Detected"))
            .join(" ")
            .trim();
        }

        if (text) {
          copyToClipboard(text);
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

function copyToClipboard(text: string): void {
  console.log(`✅ Transcribed: "${text}"`);
  console.log("📋 Переключись на нужное окно... (2 сек)\n");

  // Wait 2 seconds for user to switch to target app
  setTimeout(() => {
    console.log("Pasting...");

    // Escape for AppleScript
    const escaped = text
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\n/g, "\\n");

    // Paste directly using AppleScript
    const script = `tell application "System Events" to keystroke "${escaped}"`;
    const proc = spawn("osascript", ["-e", script]);

    proc.on("close", (code) => {
      if (code === 0) {
        console.log("✅ Pasted!\n");
        process.exit(0);
      } else {
        console.log("⚠️  Paste failed, copying to clipboard...");
        // Fallback to clipboard
        const clipProc = spawn("pbcopy");
        clipProc.stdin.write(text);
        clipProc.stdin.end();
        clipProc.on("close", () => {
          console.log("📋 In clipboard - paste with Cmd+V\n");
          process.exit(0);
        });
      }
    });
  }, 2000); // 2 second delay
}

// ============================================================================
// MAIN
// ============================================================================

(async () => {
  startRecording();

  // Listen for Enter key
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  rl.on("line", () => {
    rl.close();
    stopRecording();
  });

  process.on("SIGINT", () => {
    console.log("\n👋 Cancelled");
    if (recordingProcess) {
      recordingProcess.kill("SIGTERM");
    }
    process.exit(0);
  });
})();
