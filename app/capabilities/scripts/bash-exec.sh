#!/bin/bash
# bash-exec.sh — Execute shell command with configurable timeout and cwd
# Usage: bash-exec.sh <command> [timeout_seconds] [cwd]

COMMAND="$1"
TIMEOUT="${2:-30}"
CWD="$3"

if [ -z "$COMMAND" ]; then
  echo "__TYPE__:error"
  echo "command is required"
  exit 0
fi

# Sanitize timeout (1-600)
if ! [[ "$TIMEOUT" =~ ^[0-9]+$ ]] || [ "$TIMEOUT" -lt 1 ]; then
  TIMEOUT=30
fi
if [ "$TIMEOUT" -gt 600 ]; then
  TIMEOUT=600
fi

# Safety controls — block destructive patterns
BLOCKED_PATTERNS=(
  "rm -rf /"
  "rm -rf /*"
  "mkfs\."
  "dd if=.* of=/dev/"
  "> /dev/sd"
  "chmod -R 777 /"
  ":(){ :|:& };:"
)

for pat in "${BLOCKED_PATTERNS[@]}"; do
  if echo "$COMMAND" | grep -qE "$pat"; then
    echo "__TYPE__:error"
    echo "Command blocked by safety controls: matches destructive pattern"
    exit 0
  fi
done

# Set working directory
if [ -n "$CWD" ]; then
  CWD="${CWD/#\~/$HOME}"
  if [ ! -d "$CWD" ]; then
    echo "__TYPE__:error"
    echo "Working directory not found: $CWD"
    exit 0
  fi
  cd "$CWD"
else
  # Default to project root
  cd "$(dirname "$0")/../.." 2>/dev/null
fi

# Execute with timeout, capture stdout and stderr separately
TMPOUT=$(mktemp)
TMPERR=$(mktemp)
timeout "$TIMEOUT" bash -c "$COMMAND" > "$TMPOUT" 2> "$TMPERR"
EXIT_CODE=$?

STDOUT=$(cat "$TMPOUT")
STDERR=$(cat "$TMPERR")
rm -f "$TMPOUT" "$TMPERR"

# Truncate output if too large (1MB)
MAX_LEN=1048576
if [ ${#STDOUT} -gt $MAX_LEN ]; then
  STDOUT="${STDOUT:0:$MAX_LEN}
... (output truncated at 1MB)"
fi

if [ $EXIT_CODE -eq 124 ]; then
  echo "__TYPE__:text"
  echo "exit_code: 124 (timeout after ${TIMEOUT}s)"
  echo "---"
  echo "$STDOUT"
  if [ -n "$STDERR" ]; then
    echo "---stderr---"
    echo "$STDERR"
  fi
  exit 0
fi

echo "__TYPE__:text"
echo "exit_code: $EXIT_CODE"
echo "---"
echo "$STDOUT"
if [ -n "$STDERR" ]; then
  echo "---stderr---"
  echo "$STDERR"
fi
