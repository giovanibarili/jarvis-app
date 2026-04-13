#!/bin/bash
# edit-file.sh — Replace exact string in a file (via stdin, no ARG_MAX limit)
# Stdin format: old_string\n__EDIT_SEPARATOR__\nnew_string
# Usage: edit-file.sh <path> [replace_all]

PATH_ARG="$1"
REPLACE_ALL="${2:-false}"

# Expand ~
PATH_ARG="${PATH_ARG/#\~/$HOME}"

if [ -z "$PATH_ARG" ]; then
  echo "__TYPE__:error"
  echo "path is required"
  exit 0
fi

if [ ! -f "$PATH_ARG" ]; then
  echo "__TYPE__:error"
  echo "File not found: $PATH_ARG"
  exit 0
fi

# Read old_string and new_string from stdin, split by separator
STDIN_DATA=$(cat)

python3 -c "
import sys

path = sys.argv[1]
replace_all = sys.argv[2].lower() == 'true'
stdin_data = sys.stdin.read() if not sys.argv[3] else sys.argv[3]

sep = '__EDIT_SEPARATOR__'
if sep not in stdin_data:
    print('__TYPE__:error')
    print('Invalid input: missing separator between old_string and new_string')
    sys.exit(0)

parts = stdin_data.split(sep, 1)
old_string = parts[0]
new_string = parts[1]

# Strip exactly one leading newline from each (artifact of the template)
if old_string.endswith('\n'):
    old_string = old_string[:-1]
if new_string.startswith('\n'):
    new_string = new_string[1:]

with open(path, 'r') as f:
    content = f.read()

if old_string not in content:
    print('__TYPE__:error')
    print(f'String to replace not found in file: {path}')
    sys.exit(0)

count = content.count(old_string)

if not replace_all and count > 1:
    print('__TYPE__:error')
    print(f'old_string matches {count} locations in file. Provide more context to make it unique, or use replace_all=true.')
    sys.exit(0)

if replace_all:
    result = content.replace(old_string, new_string)
    replaced = count
else:
    result = content.replace(old_string, new_string, 1)
    replaced = 1

# Preserve permissions
import os, stat
st = os.stat(path)
mode = stat.S_IMODE(st.st_mode)

with open(path, 'w') as f:
    f.write(result)

os.chmod(path, mode)

lines = result.count('\n')
size = len(result.encode('utf-8'))

print('__TYPE__:text')
print(f'edited: {path}')
print(f'occurrences_found: {count}')
print(f'replaced: {replaced}')
print(f'lines: {lines}')
print(f'bytes: {size}')
" "$PATH_ARG" "$REPLACE_ALL" "$STDIN_DATA"
