#!/usr/bin/env python3
"""
XLN Whisper Server - Persistent MLX Whisper HTTP API
Keeps model loaded in RAM for fast transcription (~300ms)
"""
import os
import sys
from pathlib import Path
from flask import Flask, request, jsonify
import mlx_whisper

app = Flask(__name__)

# Load model once on startup
print("Loading Whisper model into memory...")
MODEL_PATH = "mlx-community/whisper-large-v3-mlx"
model = None

try:
    # Pre-load model
    model = mlx_whisper.load_models.load_model(MODEL_PATH)
    print(f"✅ Model loaded: {MODEL_PATH}")
except Exception as e:
    print(f"❌ Failed to load model: {e}")
    sys.exit(1)

@app.route('/transcribe', methods=['POST'])
def transcribe():
    """Transcribe audio file"""
    if 'file' not in request.files:
        return jsonify({'error': 'No file provided'}), 400

    audio_file = request.files['file']
    task = request.form.get('task', 'transcribe')  # transcribe or translate
    language = request.form.get('language', None)  # None = auto-detect

    # Save temporarily
    temp_path = f"/tmp/whisper_upload_{os.getpid()}.wav"
    audio_file.save(temp_path)

    try:
        # Transcribe
        result = mlx_whisper.transcribe(
            temp_path,
            path_or_hf_repo=MODEL_PATH,
            task=task,
            language=language,
            verbose=False
        )

        text = result.get("text", "").strip()

        # Cleanup
        os.remove(temp_path)

        return jsonify({
            'text': text,
            'language': result.get('language', 'unknown'),
            'task': task
        })

    except Exception as e:
        if os.path.exists(temp_path):
            os.remove(temp_path)
        return jsonify({'error': str(e)}), 500

@app.route('/', methods=['GET'])
def health():
    """Health check"""
    return jsonify({'status': 'ok', 'model': MODEL_PATH})

if __name__ == '__main__':
    print("Starting Whisper server on http://0.0.0.0:5001")
    app.run(host='0.0.0.0', port=5001, debug=False, threaded=True)
