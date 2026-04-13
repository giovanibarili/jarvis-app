#!/bin/bash
# write-file.sh — Write content to a file
# Content is read from stdin (no ARG_MAX limit).
# Preserves original permissions on overwrite.
# Creates parent directories if needed.
# Usage: write-file.sh <path>
#
# TODO: Add safety gate — require LLM to have read the file before overwriting. Implement via system prompt instruction or tool-level tracking in loader.ts. Delete this TODO when done.

PATH_ARG="$1"

# Expand ~
PATH_ARG="${PATH_ARG/#\~/$HOME}"

if [ -z "$PATH_ARG" ]; then
  echo "__TYPE__:error"
  echo "path is required"
  exit 0
fi

if [ -d "$PATH_ARG" ]; then
  echo "__TYPE__:error"
  echo "Path is a directory: $PATH_ARG"
  exit 0
fi

# Create parent directories
DIR=$(dirname "$PATH_ARG")
if [ ! -d "$DIR" ]; then
  mkdir -p "$DIR" 2>/dev/null
  if [ $? -ne 0 ]; then
    echo "__TYPE__:error"
    echo "Cannot create directory: $DIR"
    exit 0
  fi
fi

# Preserve permissions if file exists
EXISTED=false
PERMS=""
if [ -f "$PATH_ARG" ]; then
  EXISTED=true
  PERMS=$(stat -f "%Lp" "$PATH_ARG" 2>/dev/null || stat -c "%a" "$PATH_ARG" 2>/dev/null)
fi

# Read content from stdin and write
cat > "$PATH_ARG" 2>/dev/null
if [ $? -ne 0 ]; then
  echo "__TYPE__:error"
  echo "Cannot write to file: $PATH_ARG"
  exit 0
fi

# Ensure trailing newline
if [ -s "$PATH_ARG" ]; then
  LAST_BYTE=$(tail -c 1 "$PATH_ARG" | xxd -p)
  if [ "$LAST_BYTE" != "0a" ] && [ "$LAST_BYTE" != "" ]; then
    printf '\n' >> "$PATH_ARG"
  fi
fi

# Restore permissions
if [ "$EXISTED" = true ] && [ -n "$PERMS" ]; then
  chmod "$PERMS" "$PATH_ARG" 2>/dev/null
fi

LINES=$(wc -l < "$PATH_ARG" | tr -d ' ')
SIZE=$(stat -f%z "$PATH_ARG" 2>/dev/null || stat -c%s "$PATH_ARG" 2>/dev/null)
ACTION="created"
if [ "$EXISTED" = true ]; then
  ACTION="overwritten"
fi

echo "__TYPE__:text"
echo "$ACTION: $PATH_ARG"
echo "lines: $LINES"
echo "bytes: $SIZE"
