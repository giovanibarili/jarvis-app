#!/bin/bash
# Web search via DuckDuckGo HTML (no API key needed)

QUERY="$1"
MAX_RESULTS="${2:-5}"

if [ -z "$QUERY" ]; then
  echo "__TYPE__:error"
  echo "Query is required"
  exit 0
fi

# Cap max results
if [ "$MAX_RESULTS" -gt 10 ] 2>/dev/null; then MAX_RESULTS=10; fi

# URL encode the query
ENCODED=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$QUERY'))")

# Use DuckDuckGo HTML lite
RESULTS=$(curl -s -L -A "Mozilla/5.0" "https://html.duckduckgo.com/html/?q=${ENCODED}" 2>/dev/null)

if [ -z "$RESULTS" ]; then
  echo "__TYPE__:error"
  echo "Search failed — no response from DuckDuckGo"
  exit 0
fi

# Parse results with Python
python3 -c "
import html
import re
import sys

content = '''${RESULTS//\'/\\\'}'''

# Find result blocks
results = re.findall(r'<a rel=\"nofollow\" class=\"result__a\" href=\"(.*?)\">(.*?)</a>.*?<a class=\"result__snippet\".*?>(.*?)</a>', content, re.DOTALL)

if not results:
    # Try alternate pattern
    results = re.findall(r'class=\"result__a\" href=\"([^\"]+)\"[^>]*>(.*?)</a>.*?class=\"result__snippet\"[^>]*>(.*?)</a>', content, re.DOTALL)

max_r = int('${MAX_RESULTS}')
output = []
for i, (url, title, snippet) in enumerate(results[:max_r]):
    title = re.sub(r'<[^>]+>', '', html.unescape(title)).strip()
    snippet = re.sub(r'<[^>]+>', '', html.unescape(snippet)).strip()
    # DuckDuckGo wraps URLs in a redirect — extract real URL
    if 'uddg=' in url:
        import urllib.parse
        parsed = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)
        url = parsed.get('uddg', [url])[0]
    output.append(f'{i+1}. {title}\n   {url}\n   {snippet}\n')

if output:
    print('\n'.join(output))
else:
    print('No results found for: ${QUERY}')
" 2>/dev/null

if [ $? -ne 0 ]; then
  echo "__TYPE__:error"
  echo "Failed to parse search results"
fi
