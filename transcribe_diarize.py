#!/usr/bin/env python3
"""
Transcribe audio with speaker diarization using whisperX
"""
import sys
import torch

# Monkeypatch torch.load to use weights_only=False (PyTorch 2.6 compatibility)
_original_load = torch.load
def patched_load(*args, **kwargs):
    kwargs.setdefault('weights_only', False)
    return _original_load(*args, **kwargs)
torch.load = patched_load

import whisperx
import json
from pathlib import Path

def main():
    audio_file = "/Users/egor/Downloads/Telegram Desktop/bb_xln.mp3"
    output_dir = Path("/Users/egor/Downloads/Telegram Desktop")
    hf_token = os.getenv("HUGGING_FACE_TOKEN", "")  # Set via environment variable

    print(f"🎧 Loading audio: {audio_file}")
    print(f"📊 Model: large-v3 | Language: Russian | Compute: float32")
    print(f"🔄 Steps: Transcribe → Align → Diarize")
    print()

    device = "cpu"
    compute_type = "float32"

    # Load model
    print("[1/4] Loading Whisper model...")
    model = whisperx.load_model(
        "large-v3",
        device,
        compute_type=compute_type,
        language="ru"
    )

    # Transcribe
    print("[2/4] Transcribing audio (this may take several minutes)...")
    audio = whisperx.load_audio(audio_file)
    result = model.transcribe(audio, batch_size=16, language="ru")
    print(f"✅ Found {len(result['segments'])} segments")

    # Align
    print("[3/4] Aligning whisper output...")
    model_a, metadata = whisperx.load_align_model(
        language_code="ru",
        device=device
    )
    result = whisperx.align(
        result["segments"],
        model_a,
        metadata,
        audio,
        device,
        return_char_alignments=False
    )
    print(f"✅ Alignment complete")

    # Diarize
    print("[4/4] Detecting speakers...")
    diarize_model = whisperx.DiarizationPipeline(
        use_auth_token=hf_token,
        device=device
    )
    diarize_segments = diarize_model(audio)
    result = whisperx.assign_word_speakers(diarize_segments, result)
    print(f"✅ Speaker detection complete")

    # Save results
    print()
    print("💾 Saving output files...")

    # JSON format (best for AI)
    json_path = output_dir / "bb_xln.json"
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    print(f"   ✓ {json_path}")

    # Human-readable transcript
    txt_path = output_dir / "bb_xln_transcript.txt"
    with open(txt_path, "w", encoding="utf-8") as f:
        current_speaker = None
        for seg in result["segments"]:
            speaker = seg.get("speaker", "UNKNOWN")
            # Rename SPEAKER_00 → 1, SPEAKER_01 → 2, etc
            if speaker.startswith("SPEAKER_"):
                speaker = str(int(speaker.split("_")[1]) + 1)

            text = seg["text"].strip()

            if speaker != current_speaker:
                f.write(f"\n[Speaker {speaker}]\n")
                current_speaker = speaker

            f.write(f"{text}\n")
    print(f"   ✓ {txt_path}")

    # VTT subtitles
    vtt_path = output_dir / "bb_xln.vtt"
    with open(vtt_path, "w", encoding="utf-8") as f:
        f.write("WEBVTT\n\n")
        for i, seg in enumerate(result["segments"], 1):
            start = seg["start"]
            end = seg["end"]
            speaker = seg.get("speaker", "UNKNOWN")
            if speaker.startswith("SPEAKER_"):
                speaker = str(int(speaker.split("_")[1]) + 1)
            text = seg["text"].strip()

            # Format: HH:MM:SS.mmm
            start_time = f"{int(start//3600):02d}:{int((start%3600)//60):02d}:{start%60:06.3f}"
            end_time = f"{int(end//3600):02d}:{int((end%3600)//60):02d}:{end%60:06.3f}"

            f.write(f"{i}\n")
            f.write(f"{start_time} --> {end_time}\n")
            f.write(f"[Speaker {speaker}] {text}\n\n")
    print(f"   ✓ {vtt_path}")

    print()
    print("🎉 Done!")
    print(f"\n📁 Output files in: {output_dir}")

if __name__ == "__main__":
    main()
