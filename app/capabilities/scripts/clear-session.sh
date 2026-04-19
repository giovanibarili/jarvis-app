#!/bin/bash
# Clear all saved conversation sessions with rolling archive

SESSIONS_DIR="$(cd "$(dirname "$0")/../.." && pwd)/.jarvis/sessions"
ARCHIVE_DIR="$SESSIONS_DIR/archive"

echo "__TYPE__:text"

if [ -d "$SESSIONS_DIR" ]; then
  files=$(ls -1 "$SESSIONS_DIR"/*.json 2>/dev/null)
  count=$(echo "$files" | grep -c '\.json$' 2>/dev/null || echo 0)

  if [ "$count" -eq 0 ]; then
    echo "No saved conversations found."
    exit 0
  fi

  # Create archive dir
  mkdir -p "$ARCHIVE_DIR"

  # Rolling: move each session file with timestamp
  timestamp=$(date +"%Y%m%d_%H%M%S")
  for f in $files; do
    basename=$(basename "$f" .json)
    mv "$f" "$ARCHIVE_DIR/${basename}_${timestamp}.json"
  done

  # Prune old archives: keep only last 10 per session label
  for label in $(ls "$ARCHIVE_DIR"/*.json 2>/dev/null | xargs -I{} basename {} | sed 's/_[0-9]\{8\}_[0-9]\{6\}\.json$//' | sort -u); do
    ls -1t "$ARCHIVE_DIR"/${label}_*.json 2>/dev/null | tail -n +11 | xargs -I{} rm -f "{}"
  done

  archive_total=$(ls -1 "$ARCHIVE_DIR"/*.json 2>/dev/null | wc -l | tr -d ' ')
  echo "Archived $count conversation(s) to sessions/archive/ (timestamp: $timestamp). Total archives: $archive_total."
  echo "Next restart will start fresh."
else
  echo "No saved conversations found."
fi
