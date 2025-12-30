#!/Users/zigota/xln/ai/.venv/bin/python
"""Speaker Diarization for Whisper Transcripts
Uses pyannote.audio with MPS (Metal GPU) acceleration
Requires: HF_TOKEN env var with Hugging Face token
"""
import os
import sys
import json
from pathlib import Path
import torch
import torchaudio
from pyannote.audio import Pipeline

def merge_speakers_with_transcript(diarization, transcript_json):
    """Merge speaker labels with transcribed words based on timestamps"""

    with open(transcript_json) as f:
        data = json.load(f)

    # Build speaker timeline
    speaker_timeline = []
    for turn, _, speaker in diarization.itertracks(yield_label=True):
        speaker_timeline.append({
            'start': turn.start,
            'end': turn.end,
            'speaker': speaker
        })

    # Assign speakers to segments
    output_lines = []
    for segment in data['segments']:
        seg_start = segment['start']
        seg_end = segment['end']
        seg_text = segment['text'].strip()

        # Find dominant speaker for this segment
        seg_mid = (seg_start + seg_end) / 2
        speaker = None

        for sp in speaker_timeline:
            if sp['start'] <= seg_mid <= sp['end']:
                speaker = sp['speaker']
                break

        if not speaker:
            # Fallback: find closest speaker
            for sp in speaker_timeline:
                if sp['start'] > seg_mid:
                    speaker = sp['speaker']
                    break

        speaker_label = speaker if speaker else "UNKNOWN"
        timestamp = f"[{format_time(seg_start)} --> {format_time(seg_end)}]"

        output_lines.append(f"[{speaker_label}] {timestamp} {seg_text}")

    return "\n".join(output_lines)

def format_time(seconds):
    """Format seconds to HH:MM:SS.mmm"""
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = seconds % 60
    return f"{h:02d}:{m:02d}:{s:06.3f}"

def main():
    if len(sys.argv) < 3:
        print("Usage: ./diarize.py <audio.m4a> <transcript.json> [output.txt]")
        print("\nRequires HF_TOKEN environment variable:")
        print("  export HF_TOKEN=hf_...")
        print("  Get token at: https://huggingface.co/settings/tokens")
        sys.exit(1)

    audio_path = sys.argv[1]
    transcript_path = sys.argv[2]
    output_path = sys.argv[3] if len(sys.argv) > 3 else "diarized_output.txt"

    # Try multiple token sources
    hf_token = os.getenv("HF_TOKEN")
    if not hf_token:
        # Try HF cache file
        token_file = os.path.expanduser("~/.cache/huggingface/token")
        if os.path.exists(token_file):
            with open(token_file) as f:
                hf_token = f.read().strip()

    if not hf_token:
        print("ERROR: No HuggingFace token found")
        print("Option 1: export HF_TOKEN=hf_...")
        print("Option 2: huggingface-cli login")
        sys.exit(1)

    # Use MPS (Metal Performance Shaders) for Apple Silicon GPU
    device = "mps" if torch.backends.mps.is_available() else "cpu"
    print(f"Using device: {device}")

    # Load diarization pipeline (cached after first run)
    print("Loading pyannote pipeline...")
    pipeline = Pipeline.from_pretrained(
        "pyannote/speaker-diarization-3.1",
        token=hf_token
    )

    if device == "mps":
        pipeline.to(torch.device("mps"))

    # Load audio (workaround for torchcodec/FFmpeg issue)
    print(f"Loading audio...")
    import time
    start = time.time()
    waveform, sample_rate = torchaudio.load(audio_path)

    # Run diarization (GPU accelerated on MPS)
    print(f"Diarizing...")
    audio_dict = {"waveform": waveform, "sample_rate": sample_rate}
    diarization = pipeline(audio_dict)
    elapsed = time.time() - start

    num_speakers = len(set(diarization.labels()))
    print(f"Found {num_speakers} speakers ({elapsed:.1f}s)")

    # Merge with transcript
    print(f"Merging with transcript {transcript_path}...")
    output = merge_speakers_with_transcript(diarization, transcript_path)

    # Save output
    with open(output_path, 'w', encoding='utf-8') as f:
        f.write(output)

    print(f"✓ Saved to {output_path}")

    # Print sample
    print("\nSample output:")
    print("─" * 60)
    for line in output.split('\n')[:10]:
        print(line)
    print("─" * 60)

if __name__ == "__main__":
    main()
