#!/bin/bash
# Start XLN Voice-Paste - Push-to-talk global dictation
# Usage: ./start-voice-paste.sh

echo "Starting XLN Voice-Paste..."
echo ""
echo "Prerequisites:"
echo "  - sox: brew install sox"
echo "  - mlx-whisper: pip install mlx-whisper"
echo "  - Optionally start mlx_whisper_server on port 5001 for faster transcription"
echo ""

cd "$(dirname "$0")"
bun run voice-paste.ts
