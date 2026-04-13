#!/bin/bash
# list-dir.sh — List files and directories
# Supports recursive, type filter, limit
# Usage: list-dir.sh <path> [recursive] [type] [limit]

PATH_ARG="$1"
RECURSIVE="${2:-false}"
TYPE_FILTER="${3:-all}"
LIMIT="${4:-200}"

# Expand ~
PATH_ARG="${PATH_ARG/#\~/$HOME}"

if [ -z "$PATH_ARG" ]; then
  echo "__TYPE__:error"
  echo "path is required"
  exit 0
fi

if [ ! -d "$PATH_ARG" ]; then
  echo "__TYPE__:error"
  echo "Directory not found: $PATH_ARG"
  exit 0
fi

# Sanitize limit
if ! [[ "$LIMIT" =~ ^[0-9]+$ ]] || [ "$LIMIT" -eq 0 ]; then
  LIMIT=200
fi

FIND_ARGS=("$PATH_ARG")

# Exclude common noise
FIND_ARGS+=(-not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "*/dist/*")

# Depth control
if [ "$RECURSIVE" != "true" ]; then
  FIND_ARGS+=(-maxdepth 1)
fi

# Exclude self
FIND_ARGS+=(-not -path "$PATH_ARG")

# Type filter
case "$TYPE_FILTER" in
  file) FIND_ARGS+=(-type f) ;;
  dir)  FIND_ARGS+=(-type d) ;;
esac

# Execute and format
OUTPUT=$(find "${FIND_ARGS[@]}" 2>/dev/null | sort | head -"$LIMIT" | while IFS= read -r entry; do
  if [ -d "$entry" ]; then
    echo "[dir]  $entry"
  else
    SIZE=$(stat -f%z "$entry" 2>/dev/null || stat -c%s "$entry" 2>/dev/null)
    echo "[file] $entry  ($SIZE bytes)"
  fi
done)

if [ -z "$OUTPUT" ]; then
  echo "__TYPE__:text"
  echo "Empty directory: $PATH_ARG"
  exit 0
fi

ENTRY_COUNT=$(echo "$OUTPUT" | wc -l | tr -d ' ')

echo "__TYPE__:text"
echo "path: $PATH_ARG"
echo "entries: $ENTRY_COUNT (limit: $LIMIT, recursive: $RECURSIVE, type: $TYPE_FILTER)"
echo "---"
echo "$OUTPUT"
