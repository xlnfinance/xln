#!/usr/bin/env python3
"""XLN Whisper Server - SOTA Quality MLX STT"""
import os
import sys
import signal
import atexit
from flask import Flask, request, jsonify
import mlx_whisper
from threading import Lock

app = Flask(__name__)

MODEL_PATH = "mlx-community/whisper-large-v3-mlx"
PIDFILE = "/tmp/stt-server.pid"

# Lock to prevent concurrent MLX GPU access (prevents Metal encoder crashes)
inference_lock = Lock()
model_cache = None  # Single model instance to prevent multiple loads

def cleanup():
    """Clean shutdown - remove PID file"""
    if os.path.exists(PIDFILE):
        os.remove(PIDFILE)
    print("Server shutdown complete")

def signal_handler(sig, frame):
    """Handle SIGTERM/SIGINT gracefully"""
    print(f"Received signal {sig}, shutting down...")
    cleanup()
    sys.exit(0)

# Register cleanup handlers
atexit.register(cleanup)
signal.signal(signal.SIGTERM, signal_handler)
signal.signal(signal.SIGINT, signal_handler)

# Write PID file
with open(PIDFILE, 'w') as f:
    f.write(str(os.getpid()))

print(f"Server starting with model: {MODEL_PATH}")
print(f"PID: {os.getpid()} (written to {PIDFILE})")
print(f"Model will load on first request (~2s first time, then cached)")
print(f"Thread-safe mode: Sequential processing (prevents GPU conflicts)")

@app.route('/transcribe', methods=['POST'])
def transcribe():
    global model_cache

    if 'file' not in request.files:
        return jsonify({'error': 'No file provided'}), 400

    audio_file = request.files['file']
    task = request.form.get('task', 'transcribe')
    language = request.form.get('language', None)

    temp_path = f"/tmp/whisper_upload_{os.getpid()}.wav"
    audio_file.save(temp_path)

    try:
        # Serialize GPU access to prevent Metal encoder conflicts
        with inference_lock:
            # Load model once and cache (prevents multiple model instances in MLX)
            if model_cache is None:
                print(f"Loading model {MODEL_PATH} (first request)...")
                model_cache = True  # Mark as loaded

            # Don't force language - let Whisper auto-detect for mixed language support
            result = mlx_whisper.transcribe(
                temp_path,
                path_or_hf_repo=MODEL_PATH,
                task=task,
                language=None,  # Auto-detect allows code-switching (RU+EN mixed)
                verbose=False,
                fp16=False  # Disable FP16 to reduce GPU memory conflicts
            )

        text = result.get("text", "").strip()
        os.remove(temp_path)

        return jsonify({
            'text': text,
            'language': result.get('language', 'unknown'),
            'task': task
        })
    except Exception as e:
        print(f"Transcription error: {e}")
        if os.path.exists(temp_path):
            os.remove(temp_path)
        return jsonify({'error': str(e)}), 500

@app.route('/', methods=['GET'])
def health():
    return jsonify({'status': 'ok', 'model': MODEL_PATH})

if __name__ == '__main__':
    print("Starting Whisper server on http://0.0.0.0:5001")
    app.run(host='0.0.0.0', port=5001, debug=False, threaded=True)
