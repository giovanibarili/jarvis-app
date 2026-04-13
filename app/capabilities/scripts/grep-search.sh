#!/bin/bash
# grep-search.sh — Search file contents with regex (ripgrep or grep fallback)
# Usage: grep-search.sh <pattern> [path] [include] [context] [output_mode] [case_insensitive] [multiline] [limit] [type]

PATTERN="$1"
SEARCH_PATH="${2:-.}"
INCLUDE="$3"
CONTEXT="${4:-0}"
OUTPUT_MODE="${5:-files_with_matches}"
CASE_INSENSITIVE="$6"
MULTILINE="$7"
LIMIT="${8:-250}"
FILE_TYPE="$9"

# Expand ~
SEARCH_PATH="${SEARCH_PATH/#\~/$HOME}"

if [ -z "$PATTERN" ]; then
  echo "__TYPE__:error"
  echo "pattern is required"
  exit 0
fi

if [ ! -e "$SEARCH_PATH" ]; then
  echo "__TYPE__:error"
  echo "Path not found: $SEARCH_PATH"
  exit 0
fi

# Sanitize limit
if ! [[ "$LIMIT" =~ ^[0-9]+$ ]] || [ "$LIMIT" -eq 0 ]; then
  LIMIT=250
fi

# Build command with ripgrep (preferred) or grep fallback
if command -v rg &>/dev/null; then
  CMD=(rg)

  # Output mode
  case "$OUTPUT_MODE" in
    files_with_matches) CMD+=(-l) ;;
    count)              CMD+=(-c --include-zero) ;;
    content|*)          CMD+=(-n --no-heading) ;;
  esac

  # Case insensitive
  if [ "$CASE_INSENSITIVE" = "true" ]; then
    CMD+=(-i)
  fi

  # Multiline
  if [ "$MULTILINE" = "true" ]; then
    CMD+=(-U --multiline-dotall)
  fi

  # Context (only for content mode)
  if [ "$OUTPUT_MODE" = "content" ] && [ "$CONTEXT" -gt 0 ] 2>/dev/null; then
    CMD+=(-C "$CONTEXT")
  fi

  # File type filter
  if [ -n "$FILE_TYPE" ]; then
    CMD+=(--type "$FILE_TYPE")
  fi

  # Include glob
  if [ -n "$INCLUDE" ]; then
    CMD+=(--glob "$INCLUDE")
  fi

  CMD+=(-- "$PATTERN" "$SEARCH_PATH")

  OUTPUT=$("${CMD[@]}" 2>/dev/null | head -"$LIMIT")
else
  # Fallback to grep
  CMD=(grep -r)

  case "$OUTPUT_MODE" in
    files_with_matches) CMD+=(-l) ;;
    count)              CMD+=(-c) ;;
    content|*)          CMD+=(-n) ;;
  esac

  if [ "$CASE_INSENSITIVE" = "true" ]; then
    CMD+=(-i)
  fi

  if [ "$OUTPUT_MODE" = "content" ] && [ "$CONTEXT" -gt 0 ] 2>/dev/null; then
    CMD+=(-C "$CONTEXT")
  fi

  if [ -n "$INCLUDE" ]; then
    CMD+=(--include="$INCLUDE")
  fi

  CMD+=(-- "$PATTERN" "$SEARCH_PATH")

  OUTPUT=$("${CMD[@]}" 2>/dev/null | head -"$LIMIT")
fi

if [ -z "$OUTPUT" ]; then
  echo "__TYPE__:text"
  echo "No matches found for: $PATTERN"
  exit 0
fi

RESULT_COUNT=$(echo "$OUTPUT" | wc -l | tr -d ' ')

echo "__TYPE__:text"
echo "mode: $OUTPUT_MODE"
echo "results: $RESULT_COUNT (limit: $LIMIT)"
echo "---"
echo "$OUTPUT"
