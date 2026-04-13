#!/bin/bash
# Fetch a web page and convert to readable text

URL="$1"
MAX_LENGTH="${2:-10000}"

if [ -z "$URL" ]; then
  echo "__TYPE__:error"
  echo "URL is required"
  exit 0
fi

if [ "$MAX_LENGTH" -gt 50000 ] 2>/dev/null; then MAX_LENGTH=50000; fi

python3 - "$URL" "$MAX_LENGTH" << 'PYEOF'
import sys
import re
import html
import urllib.request

url = sys.argv[1]
max_len = int(sys.argv[2]) if len(sys.argv) > 2 else 10000

try:
    req = urllib.request.Request(url, headers={
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"
    })
    with urllib.request.urlopen(req, timeout=15) as resp:
        content = resp.read().decode("utf-8", errors="replace")
except Exception as e:
    print(f"Failed to fetch URL: {e}")
    sys.exit(0)

# Remove script, style, nav, footer
content = re.sub(r'<script[^>]*>.*?</script>', '', content, flags=re.DOTALL | re.IGNORECASE)
content = re.sub(r'<style[^>]*>.*?</style>', '', content, flags=re.DOTALL | re.IGNORECASE)
content = re.sub(r'<nav[^>]*>.*?</nav>', '', content, flags=re.DOTALL | re.IGNORECASE)
content = re.sub(r'<footer[^>]*>.*?</footer>', '', content, flags=re.DOTALL | re.IGNORECASE)

# Convert to markdown-like text
content = re.sub(r'<h1[^>]*>(.*?)</h1>', r'\n# \1\n', content, flags=re.DOTALL | re.IGNORECASE)
content = re.sub(r'<h2[^>]*>(.*?)</h2>', r'\n## \1\n', content, flags=re.DOTALL | re.IGNORECASE)
content = re.sub(r'<h3[^>]*>(.*?)</h3>', r'\n### \1\n', content, flags=re.DOTALL | re.IGNORECASE)
content = re.sub(r'<h[4-6][^>]*>(.*?)</h[4-6]>', r'\n#### \1\n', content, flags=re.DOTALL | re.IGNORECASE)
content = re.sub(r'<li[^>]*>(.*?)</li>', r'- \1', content, flags=re.DOTALL | re.IGNORECASE)
content = re.sub(r'<br\s*/?>', '\n', content, flags=re.IGNORECASE)
content = re.sub(r'<p[^>]*>', '\n', content, flags=re.IGNORECASE)
content = re.sub(r'</p>', '\n', content, flags=re.IGNORECASE)
content = re.sub(r'<a[^>]*href="([^"]*)"[^>]*>(.*?)</a>', r'[\2](\1)', content, flags=re.DOTALL | re.IGNORECASE)
content = re.sub(r'<strong[^>]*>(.*?)</strong>', r'**\1**', content, flags=re.DOTALL | re.IGNORECASE)
content = re.sub(r'<b[^>]*>(.*?)</b>', r'**\1**', content, flags=re.DOTALL | re.IGNORECASE)
content = re.sub(r'<em[^>]*>(.*?)</em>', r'*\1*', content, flags=re.DOTALL | re.IGNORECASE)
content = re.sub(r'<code[^>]*>(.*?)</code>', r'`\1`', content, flags=re.DOTALL | re.IGNORECASE)

# Strip remaining HTML
content = re.sub(r'<[^>]+>', '', content)
content = html.unescape(content)

# Clean whitespace
content = re.sub(r'\n{3,}', '\n\n', content)
content = re.sub(r' {2,}', ' ', content)
content = '\n'.join(line.strip() for line in content.splitlines())
content = content.strip()

if len(content) > max_len:
    content = content[:max_len] + '\n\n[... truncated]'

print(content)
PYEOF
