#!/usr/bin/env python3
import mlx_whisper
import json
from pathlib import Path

audio = "/Users/egor/Downloads/Telegram Desktop/bb_xln.mp3"
output_dir = Path("/Users/egor/Downloads/Telegram Desktop")

print("🎧 Transcribing with MLX Whisper medium (Russian)...")
print("⏳ Processing 104MB file (using medium model to avoid OOM)...\n")

result = mlx_whisper.transcribe(
    audio,
    path_or_hf_repo="mlx-community/whisper-medium-mlx",
    verbose=False,  # Less memory overhead
    language="ru"
)

print(f"\n✅ Transcription completed ({len(result.get('segments', []))} segments)")

# Save JSON
json_path = output_dir / "bb_xln.json"
with open(json_path, "w", encoding="utf-8") as f:
    json.dump(result, f, ensure_ascii=False, indent=2)

# Save readable text
txt_path = output_dir / "bb_xln_transcript.txt"
with open(txt_path, "w", encoding="utf-8") as f:
    for seg in result.get("segments", []):
        f.write(seg["text"].strip() + "\n")

print(f"\n✅ Done!")
print(f"📁 {json_path}")
print(f"📁 {txt_path}")
