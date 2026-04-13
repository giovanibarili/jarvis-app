#!/bin/bash
# Start Kokoro TTS server locally on port 8880
# Requires: python3 venv at ~/dev/personal/kokoro-local/venv

KOKORO_DIR="$HOME/dev/personal/kokoro-local"
PORT="${1:-8880}"

if [ ! -d "$KOKORO_DIR/venv" ]; then
  echo "Kokoro not installed. Run:"
  echo "  cd $KOKORO_DIR && python3 -m venv venv && source venv/bin/activate"
  echo "  pip install --index-url https://pypi.org/simple/ -e '.[cpu]'"
  echo "  python3 docker/scripts/download_model.py --output api/src/models/v1_0"
  exit 1
fi

cd "$KOKORO_DIR"
source venv/bin/activate

ESPEAK_LIB=$(brew --prefix 2>/dev/null)/lib/libespeak-ng.dylib
if [ ! -f "$ESPEAK_LIB" ]; then
  ESPEAK_LIB=$(find /opt/homebrew /usr/local -name "libespeak-ng.dylib" 2>/dev/null | head -1)
fi

echo "Starting Kokoro TTS on port $PORT..."
PHONEMIZER_ESPEAK_LIBRARY="$ESPEAK_LIB" \
USE_GPU=false \
MODEL_DIR="$KOKORO_DIR/api/src/models" \
VOICES_DIR="$KOKORO_DIR/api/src/voices/v1_0" \
PROJECT_ROOT="$KOKORO_DIR" \
python3 -m uvicorn api.src.main:app --host 127.0.0.1 --port "$PORT"
