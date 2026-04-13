#!/bin/bash
# read-file.sh — Read file with line numbers, offset, limit
# Supports: text files, images (base64), PDFs (via pdftotext)
# Usage: read-file.sh <path> [offset] [limit]
#
# TODO: Add PDF page range support (pages param, e.g. "1-5"). Use pdftotext -f/-l flags. Update input_schema in read-file.json. Delete this TODO when done.
# TODO: Add Jupyter notebook (.ipynb) support. Parse JSON cells, render code+markdown+outputs. Delete this TODO when done.

PATH_ARG="$1"
OFFSET="${2:-0}"
LIMIT="${3:-2000}"

# Expand ~
PATH_ARG="${PATH_ARG/#\~/$HOME}"

if [ ! -e "$PATH_ARG" ]; then
  echo "__TYPE__:error"
  echo "File not found: $PATH_ARG"
  exit 0
fi

if [ -d "$PATH_ARG" ]; then
  echo "__TYPE__:error"
  echo "Path is a directory: $PATH_ARG"
  exit 0
fi

# Detect file type by extension
EXT="${PATH_ARG##*.}"
EXT_LOWER=$(echo "$EXT" | tr '[:upper:]' '[:lower:]')

case "$EXT_LOWER" in
  png|jpg|jpeg|gif|webp)
    # Image — output as base64
    SIZE=$(stat -f%z "$PATH_ARG" 2>/dev/null || stat -c%s "$PATH_ARG" 2>/dev/null)
    if [ "$SIZE" -gt 5242880 ]; then
      echo "__TYPE__:error"
      echo "Image too large (${SIZE} bytes, max 5MB)"
      exit 0
    fi
    case "$EXT_LOWER" in
      png) MIME="image/png" ;;
      jpg|jpeg) MIME="image/jpeg" ;;
      gif) MIME="image/gif" ;;
      webp) MIME="image/webp" ;;
    esac
    echo "__TYPE__:image"
    echo "__MIME__:$MIME"
    base64 -i "$PATH_ARG" | tr -d '\n'
    ;;

  pdf)
    # PDF — extract text
    if ! command -v pdftotext &>/dev/null; then
      echo "__TYPE__:error"
      echo "pdftotext not installed. Install poppler: brew install poppler"
      exit 0
    fi
    echo "__TYPE__:text"
    echo "path: $PATH_ARG"
    TOTAL_PAGES=$(pdftotext -layout "$PATH_ARG" - 2>/dev/null | wc -l | tr -d ' ')
    echo "totalLines: $TOTAL_PAGES"
    echo "offset: $OFFSET"
    echo "limit: $LIMIT"
    echo "---"
    pdftotext -layout "$PATH_ARG" - 2>/dev/null | tail -n +"$((OFFSET + 1))" | head -n "$LIMIT"
    ;;

  *)
    # Text file
    SIZE=$(stat -f%z "$PATH_ARG" 2>/dev/null || stat -c%s "$PATH_ARG" 2>/dev/null)
    if [ "$SIZE" -gt 524288 ]; then
      echo "__TYPE__:error"
      echo "File too large (${SIZE} bytes, max 512KB). Use offset/limit."
      exit 0
    fi
    TOTAL_LINES=$(wc -l < "$PATH_ARG" | tr -d ' ')
    echo "__TYPE__:text"
    echo "path: $PATH_ARG"
    echo "totalLines: $TOTAL_LINES"
    echo "offset: $OFFSET"
    echo "limit: $LIMIT"
    echo "---"
    cat -n "$PATH_ARG" | tail -n +"$((OFFSET + 1))" | head -n "$LIMIT"
    ;;
esac
