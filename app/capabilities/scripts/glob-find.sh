#!/bin/bash
# glob-find.sh — Find files matching a glob pattern
# Supports ** deep patterns, sort by modified/name, exclude patterns
# Usage: glob-find.sh <pattern> [path] [limit] [sort] [exclude]

PATTERN="$1"
SEARCH_PATH="${2:-.}"
LIMIT="${3:-200}"
SORT="${4:-modified}"
EXCLUDE="$5"

# Expand ~
SEARCH_PATH="${SEARCH_PATH/#\~/$HOME}"

if [ -z "$PATTERN" ]; then
  echo "__TYPE__:error"
  echo "pattern is required"
  exit 0
fi

if [ ! -d "$SEARCH_PATH" ]; then
  echo "__TYPE__:error"
  echo "Directory not found: $SEARCH_PATH"
  exit 0
fi

# Sanitize limit
if ! [[ "$LIMIT" =~ ^[0-9]+$ ]] || [ "$LIMIT" -eq 0 ]; then
  LIMIT=200
fi

# Build find command
# Handle ** patterns: split into path prefix and filename pattern
FIND_PATH="$SEARCH_PATH"
FIND_NAME="$PATTERN"

if [[ "$PATTERN" == **/** ]]; then
  # Pattern has directory component — use find with -path for ** support
  # Convert glob ** to find-compatible pattern
  FIND_PATTERN="$SEARCH_PATH/$PATTERN"

  # Default excludes
  FIND_EXCLUDE=(-not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "*/dist/*")

  # Additional excludes
  if [ -n "$EXCLUDE" ]; then
    IFS=',' read -ra EXCL_PARTS <<< "$EXCLUDE"
    for excl in "${EXCL_PARTS[@]}"; do
      excl=$(echo "$excl" | xargs) # trim whitespace
      FIND_EXCLUDE+=(-not -name "$excl")
    done
  fi

  if [ "$SORT" = "modified" ]; then
    OUTPUT=$(find "$FIND_PATH" -type f -path "$FIND_PATTERN" "${FIND_EXCLUDE[@]}" -printf '%T@\t%p\n' 2>/dev/null | sort -rn | cut -f2 | head -"$LIMIT")
    # macOS fallback (no -printf)
    if [ -z "$OUTPUT" ]; then
      OUTPUT=$(find "$FIND_PATH" -type f -path "$FIND_PATTERN" "${FIND_EXCLUDE[@]}" -exec stat -f '%m %N' {} \; 2>/dev/null | sort -rn | awk '{print $2}' | head -"$LIMIT")
    fi
  else
    OUTPUT=$(find "$FIND_PATH" -type f -path "$FIND_PATTERN" "${FIND_EXCLUDE[@]}" 2>/dev/null | sort | head -"$LIMIT")
  fi
else
  # Simple filename pattern — use find -name
  FIND_EXCLUDE=(-not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "*/dist/*")

  if [ -n "$EXCLUDE" ]; then
    IFS=',' read -ra EXCL_PARTS <<< "$EXCLUDE"
    for excl in "${EXCL_PARTS[@]}"; do
      excl=$(echo "$excl" | xargs)
      FIND_EXCLUDE+=(-not -name "$excl")
    done
  fi

  if [ "$SORT" = "modified" ]; then
    OUTPUT=$(find "$FIND_PATH" -type f -name "$FIND_NAME" "${FIND_EXCLUDE[@]}" -exec stat -f '%m %N' {} \; 2>/dev/null | sort -rn | awk '{print $2}' | head -"$LIMIT")
    # Linux fallback
    if [ -z "$OUTPUT" ]; then
      OUTPUT=$(find "$FIND_PATH" -type f -name "$FIND_NAME" "${FIND_EXCLUDE[@]}" -printf '%T@\t%p\n' 2>/dev/null | sort -rn | cut -f2 | head -"$LIMIT")
    fi
  else
    OUTPUT=$(find "$FIND_PATH" -type f -name "$FIND_NAME" "${FIND_EXCLUDE[@]}" 2>/dev/null | sort | head -"$LIMIT")
  fi
fi

if [ -z "$OUTPUT" ]; then
  echo "__TYPE__:text"
  echo "No files found matching: $PATTERN"
  exit 0
fi

FILE_COUNT=$(echo "$OUTPUT" | wc -l | tr -d ' ')

echo "__TYPE__:text"
echo "found: $FILE_COUNT files (limit: $LIMIT, sort: $SORT)"
echo "---"
echo "$OUTPUT"
