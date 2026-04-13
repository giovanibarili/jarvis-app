#!/bin/bash
# Clear all saved conversation sessions

SESSIONS_DIR="$(cd "$(dirname "$0")/../.." && pwd)/.jarvis/sessions"

echo "__TYPE__:text"

if [ -d "$SESSIONS_DIR" ]; then
  count=$(ls -1 "$SESSIONS_DIR"/*.json 2>/dev/null | wc -l | tr -d ' ')
  rm -f "$SESSIONS_DIR"/*.json
  echo "Cleared $count saved conversation(s). Next restart will start fresh."
else
  echo "No saved conversations found."
fi
