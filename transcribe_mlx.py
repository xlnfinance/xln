#!/usr/bin/env python3
"""
Transcribe with mlx-whisper (max quality), then add diarization
"""
import mlx_whisper
import json
from pathlib import Path

audio_file = "/Users/egor/Downloads/Telegram Desktop/bb_xln.mp3"
output_dir = Path("/Users/egor/Downloads/Telegram Desktop")

print("🎧 Transcribing with MLX Whisper (large-v3)...")
print(f"📁 Input: {audio_file} (104MB)")
print("🇷🇺 Language: Russian")
print("⏳ This will take several minutes...\n")

# Transcribe with mlx-whisper
print("[1/1] Running transcription...")
result = mlx_whisper.transcribe(
    audio_file,
    path_or_hf_repo="mlx-community/whisper-large-v3-mlx",
    verbose=True,
    word_timestamps=True,
    language="ru"
)

# Save JSON output
json_path = output_dir / "bb_xln.json"
with open(json_path, "w", encoding="utf-8") as f:
    json.dump(result, f, ensure_ascii=False, indent=2)

print(f"\n✅ Transcription complete!")
print(f"📁 Saved: {json_path}")
print(f"📊 Segments: {len(result.get('segments', []))}")

# Save human-readable transcript
txt_path = output_dir / "bb_xln_transcript.txt"
with open(txt_path, "w", encoding="utf-8") as f:
    for seg in result.get("segments", []):
        text = seg.get("text", "").strip()
        if text:
            f.write(f"{text}\n")

print(f"📝 Transcript: {txt_path}")
print("\n⚠️  Note: Speaker diarization not available with mlx-whisper")
print("    All text is combined without speaker labels")
