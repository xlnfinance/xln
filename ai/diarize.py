#!/Users/zigota/xln/ai/.venv/bin/python
"""Speaker Diarization for Whisper Transcripts
Uses pyannote.audio with MPS (Metal GPU) acceleration
Requires: HF_TOKEN env var with Hugging Face token
"""
import os
import sys
import json
import warnings
from pathlib import Path
import torch
import torchaudio
from pyannote.audio import Pipeline

# Suppress noisy warnings
warnings.filterwarnings("ignore", category=UserWarning, module="pyannote.audio.core.io")
warnings.filterwarnings("ignore", category=UserWarning, module="torchaudio._backend")

def merge_speakers_with_transcript(diarization, transcript_json):
    """Merge speaker labels with transcribed words - compact format"""

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

    # Assign speakers to segments and group consecutive same-speaker segments
    current_speaker = None
    current_text = []
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

        # If speaker changed, output previous speaker's text
        if current_speaker and speaker_label != current_speaker:
            output_lines.append(f"{current_speaker}: {' '.join(current_text)}")
            current_text = []

        current_speaker = speaker_label
        current_text.append(seg_text)

    # Output final speaker's text
    if current_speaker and current_text:
        output_lines.append(f"{current_speaker}: {' '.join(current_text)}")

    return "\n\n".join(output_lines)

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
    duration = waveform.shape[1] / sample_rate
    print(f"Loaded {duration/60:.1f} minutes of audio")

    # Progress hook with ETA
    last_update = [0]  # mutable for closure
    def show_progress(name=None, step_name=None, completed=None, total=None, **kwargs):
        if isinstance(step_name, str):
            if completed is not None and total is not None:
                pct = int(100 * completed / total)
                print(f"  [{pct:3d}%] {step_name} ({completed}/{total})", flush=True)
            else:
                print(f"  → {step_name}", flush=True)
        elif completed is not None and total is not None:
            pct = int(100 * completed / total)
            # Only print every 5% to reduce spam
            if pct >= last_update[0] + 5 or completed == 0 or completed == total:
                elapsed_so_far = time.time() - start
                if completed > 0:
                    eta_sec = (elapsed_so_far / completed) * (total - completed)
                    eta_min = int(eta_sec / 60)
                    print(f"  [{pct:3d}%] Processing ({completed}/{total}) - ETA {eta_min}min", flush=True)
                else:
                    print(f"  [{pct:3d}%] Processing ({completed}/{total})", flush=True)
                last_update[0] = pct

    # Run diarization (GPU accelerated on MPS)
    print(f"Diarizing (this may take 5-15min)...")
    audio_dict = {"waveform": waveform, "sample_rate": sample_rate}

    # Add num_speakers hint if you know exact count, otherwise use min/max:
    # result = pipeline(audio_dict, hook=show_progress, num_speakers=2)  # exact
    result = pipeline(audio_dict, hook=show_progress, min_speakers=1, max_speakers=2)
    elapsed = time.time() - start

    # Extract Annotation from DiarizeOutput
    diarization = result.speaker_diarization if hasattr(result, 'speaker_diarization') else result

    # Get unique speakers
    speakers = set()
    for turn, _, speaker in diarization.itertracks(yield_label=True):
        speakers.add(speaker)
    num_speakers = len(speakers)
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
