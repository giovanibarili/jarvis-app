#!/bin/bash
# Take a screenshot of the JARVIS HUD via Electron's capturePage API
# Saves to temp file, returns as image for AI visual analysis

SCREENSHOT_DIR="/tmp/jarvis-screenshots"
mkdir -p "$SCREENSHOT_DIR"
SCREENSHOT_FILE="$SCREENSHOT_DIR/hud-$(date +%s).png"

# Fetch PNG from Electron's screenshot server on port 50053
HTTP_CODE=$(curl -s -o "$SCREENSHOT_FILE" -w "%{http_code}" "http://localhost:50053/screenshot" 2>/dev/null)

if [ "$HTTP_CODE" != "200" ] || [ ! -s "$SCREENSHOT_FILE" ]; then
  echo "__TYPE__:text"
  echo "ERROR: Failed to capture screenshot (HTTP $HTTP_CODE). Is the HUD window open?"
  rm -f "$SCREENSHOT_FILE" 2>/dev/null
  exit 1
fi

echo "__TYPE__:image"
echo "$SCREENSHOT_FILE"
