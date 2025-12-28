#!/usr/bin/env python3
"""XLN STT Server - MLX Whisper
Config: ~/.xln-voice-config
"""
import os
import sys
import signal
import atexit
from flask import Flask, request, jsonify
import mlx_whisper
from threading import Lock

app = Flask(__name__)

CONFIG_PATH = os.path.expanduser("~/.xln-voice-config")
PIDFILE = "/tmp/stt-server.pid"

# Model mappings
MODELS = {
    "tiny": "mlx-community/whisper-tiny",
    "medium": "mlx-community/whisper-medium-mlx",
    "large-v3": "mlx-community/whisper-large-v3-mlx",
}

def load_config():
    """Load config from file, return defaults if missing"""
    config = {
        "model": "large-v3",
    }
    if os.path.exists(CONFIG_PATH):
        with open(CONFIG_PATH) as f:
            for line in f:
                line = line.strip()
                if '=' in line and not line.startswith('#'):
                    key, value = line.split('=', 1)
                    config[key.lower().strip()] = value.strip()
    return config

config = load_config()
MODEL_NAME = config.get("model", "large-v3")
MODEL_PATH = MODELS.get(MODEL_NAME, MODELS["large-v3"])

inference_lock = Lock()

def cleanup():
    if os.path.exists(PIDFILE):
        os.remove(PIDFILE)
    print("Server shutdown complete")

def signal_handler(sig, frame):
    print(f"Received signal {sig}, shutting down...")
    cleanup()
    sys.exit(0)

atexit.register(cleanup)
signal.signal(signal.SIGTERM, signal_handler)
signal.signal(signal.SIGINT, signal_handler)

with open(PIDFILE, 'w') as f:
    f.write(str(os.getpid()))

print(f"Config: {CONFIG_PATH}")
print(f"Model: {MODEL_NAME} -> {MODEL_PATH}")
print(f"PID: {os.getpid()}")

@app.route('/transcribe', methods=['POST'])
def transcribe():
    if 'file' not in request.files:
        return jsonify({'error': 'No file provided'}), 400

    audio_file = request.files['file']
    task = request.form.get('task', 'transcribe')

    temp_path = f"/tmp/whisper_upload_{os.getpid()}.wav"
    audio_file.save(temp_path)

    try:
        with inference_lock:
            result = mlx_whisper.transcribe(
                temp_path,
                path_or_hf_repo=MODEL_PATH,
                task=task,
                language=None,
                verbose=False,
                fp16=True
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
    return jsonify({
        'status': 'ok',
        'engine': 'mlx-whisper',
        'model': MODEL_NAME,
        'model_path': MODEL_PATH
    })

if __name__ == '__main__':
    print(f"Starting server on http://0.0.0.0:5001")
    app.run(host='0.0.0.0', port=5001, debug=False, threaded=True)
