#!/usr/bin/env python3
"""
Transcribe audio with MLX Whisper - with progress tracking
"""
import mlx_whisper
import json
import time
from pathlib import Path

audio = "/Users/egor/Downloads/Telegram Desktop/bb_xln.mp3"
output_dir = Path("/Users/egor/Downloads/Telegram Desktop")

print("🎧 MLX Whisper Transcription")
print(f"📁 File: bb_xln.mp3 (104MB)")
print(f"🇷🇺 Language: Russian")
print(f"🧠 Model: large-v3 (SOTA)")
print()

# Track time
start_time = time.time()

print("[1/2] Loading model and audio...")
load_start = time.time()

result = mlx_whisper.transcribe(
    audio,
    path_or_hf_repo="mlx-community/whisper-large-v3-mlx",
    verbose=False,
    language="ru"
)

elapsed = time.time() - start_time
print(f"⏱️  Transcription took {elapsed:.1f}s")

# Save outputs
print("\n[2/2] Saving outputs...")

# JSON
json_path = output_dir / "bb_xln.json"
with open(json_path, "w", encoding="utf-8") as f:
    json.dump(result, f, ensure_ascii=False, indent=2)
print(f"  ✓ {json_path.name}")

# Plain text
txt_path = output_dir / "bb_xln_transcript.txt"
with open(txt_path, "w", encoding="utf-8") as f:
    for seg in result.get("segments", []):
        f.write(seg["text"].strip() + "\n")
print(f"  ✓ {txt_path.name}")

# Summary
seg_count = len(result.get("segments", []))
duration = result.get("segments", [{}])[-1].get("end", 0) if seg_count else 0

print()
print(f"✅ Complete!")
print(f"📊 {seg_count} segments | {duration:.0f}s audio")
print(f"📁 {output_dir}")
