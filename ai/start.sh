#!/bin/bash
# Start XLN AI Council Server
# Usage: ./start.sh

echo "Starting XLN AI Council Server..."
echo ""
echo "Prerequisites:"
echo "  - Ollama running (ollama serve)"
echo "  - MLX Server optional (python -m mlx_lm.server)"
echo ""

cd "$(dirname "$0")"
bun run server.ts
