#!/bin/bash
# Generate self-signed HTTPS certificates for local development

if ! command -v mkcert &> /dev/null; then
  echo "❌ mkcert not installed"
  echo ""
  echo "Install with:"
  echo "  macOS:   brew install mkcert"
  echo "  Linux:   curl -JLO https://dl.filippo.io/mkcert/latest?for=linux/amd64"
  echo "  Windows: choco install mkcert"
  echo ""
  echo "Then run: mkcert -install"
  exit 1
fi

echo "🔐 Generating HTTPS certificates..."
cd "$(dirname "$0")"

# Generate certs for localhost and LAN IP
mkcert localhost 127.0.0.1 ::1

echo ""
echo "✅ Certificates generated:"
echo "   - localhost+2.pem"
echo "   - localhost+2-key.pem"
echo ""
echo "Run: bun run dev"
echo "Access at: https://localhost:8080"
