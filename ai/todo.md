# xln/ai todo

## in progress

- [ ] **GPT-OSS 120B MLX download** (~60GB, 13/22 files)
  - Location: `~/models/gpt-oss-120b-heretic-mlx`

## pending

- [ ] Install piper TTS for voice synthesis
  - `brew install piper` or build from source
  - Currently `/api/synthesize` returns 400 (piper not found)

- [ ] Fix green visual speech indicator in /ai UI
  - Audio visualizer exists but may need WebAudio API fixes

## completed (2024-12-04)

- [x] **DeepSeek-V3.1 MLX 4bit download** (352GB complete)
  - Location: `~/models/DeepSeek-V3.1-4bit-mlx`
  - LM Studio symlink: `~/.lmstudio/models/mlx-community/DeepSeek-V3.1-4bit`
  - Start: `mlx_lm.server --model ~/models/DeepSeek-V3.1-4bit-mlx --port 8081`

- [x] **Qwen3-235B MLX bf16 download** (405GB complete)
  - Location: `~/models/Qwen3-235B-MLX-bf16`
  - Start: `mlx_lm.server --model ~/models/Qwen3-235B-MLX-bf16 --port 8083`

- [x] Add Ollama tool calling support to xln/ai
  - Updated `queryOllama()` to accept `tools` parameter
  - Returns `tool_calls` in OpenAI-compatible format
  - Qwen3-coder supports native function calling

## completed (2024-12-01)

- [x] Add MLX models to xln/ai registry
  - Added: gemma3-27b-mlx, qwen3-235b-mlx, gpt-oss-120b-mlx, deepseek-v3-mlx, deepseek-v3.1-mlx, glm-4.5-mlx, minimax-m2-mlx, kimi-vl-mlx

- [x] Update xln/ai to route MLX models correctly
  - MLX_GEMMA_URL (port 8082) for Gemma3
  - MLX_DEEPSEEK_URL (port 8081) for DeepSeek
  - queryMLX() function with proper OpenAI-compatible format

- [x] Start Gemma3 27B MLX server
  - Running on port 8082
  - Model: `/Users/zigota/.lmstudio/models/McG-221/gemma3-27b-abliterated-dpo-mlx-8Bit`

- [x] Fix empty message bug in xln frontend

## services status

| Service | Port | Status |
|---------|------|--------|
| xln/ai backend | 3031 | running |
| Gemma3 27B MLX | 8082 | available |
| DeepSeek-V3.1 MLX | 8081 | ready (352GB) |
| Qwen3-235B MLX | 8083 | ready (405GB) |
| Ollama | 11434 | running |
| xln frontend | 8080 | running |

## quick start

```bash
# Start xln/ai backend
cd ~/xln/ai && bun run server.ts

# Start Gemma3 MLX
mlx_lm.server --model ~/.lmstudio/models/McG-221/gemma3-27b-abliterated-dpo-mlx-8Bit --port 8082 --host 0.0.0.0

# Start DeepSeek V3.1 (352GB - takes ~2min to load)
mlx_lm.server --model ~/models/DeepSeek-V3.1-4bit-mlx --port 8081 --host 0.0.0.0

# Start Qwen3-235B (405GB - takes ~3min to load)
mlx_lm.server --model ~/models/Qwen3-235B-MLX-bf16 --port 8083 --host 0.0.0.0

# Access UI
open https://localhost:8080/ai
```

## models inventory

| Model | Size | Location | Quant |
|-------|------|----------|-------|
| DeepSeek-V3.1 | 352GB | ~/models/DeepSeek-V3.1-4bit-mlx | 4-bit |
| Qwen3-235B | 405GB | ~/models/Qwen3-235B-MLX-bf16 | bf16 |
| Gemma3-27B | ~15GB | ~/.lmstudio/models/McG-221/... | 8-bit |
| GPT-OSS-120B | ~60GB | ~/models/gpt-oss-120b-heretic-mlx | mxfp4-q8 |
