#!/bin/bash
set -e

cd "$(dirname "$0")"
REPO_DIR="$(pwd)"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# JARVIS — Setup Wizard
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

# --- Terminal helpers ---

BOLD="\033[1m"
DIM="\033[2m"
BLUE="\033[1;34m"
GREEN="\033[1;32m"
YELLOW="\033[1;33m"
RED="\033[1;31m"
CYAN="\033[1;36m"
RESET="\033[0m"

info()    { printf "${BLUE}ℹ ${RESET}%s\n" "$1"; }
success() { printf "${GREEN}✓ ${RESET}%s\n" "$1"; }
warn()    { printf "${YELLOW}⚠ ${RESET}%s\n" "$1"; }
fail()    { printf "${RED}✗ ${RESET}%s\n" "$1"; exit 1; }
header()  { printf "\n${BOLD}${CYAN}▸ %s${RESET}\n\n" "$1"; }
dim()     { printf "${DIM}  %s${RESET}\n" "$1"; }

ask() {
  local prompt="$1" default="$2" result
  if [ -n "$default" ]; then
    printf "  %s ${DIM}[%s]${RESET}: " "$prompt" "$default"
    read -r result
    echo "${result:-$default}"
  else
    printf "  %s: " "$prompt"
    read -r result
    echo "$result"
  fi
}

ask_secret() {
  local prompt="$1" result
  printf "  %s: " "$prompt"
  read -rs result
  echo ""
  echo "$result"
}

confirm() {
  local prompt="$1" default="${2:-n}" reply
  if [ "$default" = "y" ]; then
    printf "  %s ${DIM}[Y/n]${RESET}: " "$prompt"
    read -r reply
    case "$reply" in
      [nN]|[nN][oO]) return 1 ;;
      *) return 0 ;;
    esac
  else
    printf "  %s ${DIM}[y/N]${RESET}: " "$prompt"
    read -r reply
    case "$reply" in
      [yY]|[yY][eE][sS]) return 0 ;;
      *) return 1 ;;
    esac
  fi
}

spinner() {
  local pid=$1 label="$2"
  local chars="⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"
  local i=0
  while kill -0 "$pid" 2>/dev/null; do
    printf "\r  ${BLUE}%s${RESET} %s" "${chars:$i:1}" "$label"
    i=$(( (i + 1) % ${#chars} ))
    sleep 0.1
  done
  wait "$pid" 2>/dev/null
  local exit_code=$?
  printf "\r\033[K"
  return $exit_code
}

mask_key() {
  local key="$1"
  if [ ${#key} -le 12 ]; then
    echo "${key:0:4}****"
  else
    echo "${key:0:8}...${key: -4}"
  fi
}

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Banner
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

clear 2>/dev/null || true
echo ""
printf "${BOLD}${CYAN}"
cat << 'BANNER'
       ██╗ █████╗ ██████╗ ██╗   ██╗██╗███████╗
       ██║██╔══██╗██╔══██╗██║   ██║██║██╔════╝
       ██║███████║██████╔╝██║   ██║██║███████╗
  ██   ██║██╔══██║██╔══██╗╚██╗ ██╔╝██║╚════██║
  ╚█████╔╝██║  ██║██║  ██║ ╚████╔╝ ██║███████║
   ╚════╝ ╚═╝  ╚═╝╚═╝  ╚═╝  ╚═══╝  ╚═╝╚══════╝
BANNER
printf "${RESET}"
echo ""
printf "${DIM}  Just A Rather Very Intelligent System — Setup Wizard${RESET}\n"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Step 1: Prerequisites
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

header "Step 1/6 — Prerequisites"

IS_MAC=false
[[ "$OSTYPE" == "darwin"* ]] && IS_MAC=true

HAS_BREW=false
command -v brew &>/dev/null && HAS_BREW=true

# Node.js
if ! command -v node &>/dev/null; then
  warn "Node.js not found."
  if $IS_MAC && $HAS_BREW; then
    if confirm "Install Node.js via Homebrew?" "y"; then
      brew install node
    else
      fail "Node.js 20+ is required. Install from https://nodejs.org"
    fi
  else
    fail "Node.js 20+ is required. Install from https://nodejs.org"
  fi
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 20 ]; then
  fail "Node.js 20+ required. Found: $(node -v). Update with: brew upgrade node"
fi
success "Node.js $(node -v)"

# npm
if ! command -v npm &>/dev/null; then
  fail "npm not found. Install Node.js from https://nodejs.org"
fi
success "npm $(npm -v)"

# Optional: ripgrep
if command -v rg &>/dev/null; then
  success "ripgrep $(rg --version | head -1 | awk '{print $2}') — fast search enabled"
else
  dim "ripgrep not found — grep will be used instead"
  if $IS_MAC && $HAS_BREW; then
    if confirm "Install ripgrep for faster file search?" "y"; then
      brew install ripgrep &>/dev/null &
      spinner $! "Installing ripgrep..."
      success "ripgrep installed"
    fi
  fi
fi

# Optional: poppler (PDF support)
if command -v pdftotext &>/dev/null; then
  success "poppler — PDF reading enabled"
else
  dim "poppler not found — PDF reading will be unavailable"
  if $IS_MAC && $HAS_BREW; then
    if confirm "Install poppler for PDF support?"; then
      brew install poppler &>/dev/null &
      spinner $! "Installing poppler..."
      success "poppler installed"
    fi
  fi
fi

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Step 2: Detect & Configure API Keys
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

header "Step 2/6 — AI Provider Setup"

ANTHROPIC_KEY=""
OPENAI_KEY=""
DEFAULT_MODEL=""

# --- Key detection ---
# Search in multiple locations, in priority order:
#   1. Environment variables (already exported)
#   2. Existing app/.env file
#   3. Shell config files (~/.zshrc, ~/.bashrc, ~/.bash_profile, ~/.zprofile)

detect_key() {
  local var_name="$1"
  local found=""

  # 1. Current environment
  eval "found=\"\${$var_name}\""
  if [ -n "$found" ]; then
    echo "$found"
    return 0
  fi

  # 2. Existing .env in app/
  if [ -f "app/.env" ]; then
    found=$(grep "^${var_name}=" "app/.env" 2>/dev/null | head -1 | cut -d= -f2-)
    if [ -n "$found" ]; then
      echo "$found"
      return 0
    fi
  fi

  # 3. Shell config files
  for rc in "$HOME/.zshrc" "$HOME/.zprofile" "$HOME/.bashrc" "$HOME/.bash_profile"; do
    if [ -f "$rc" ]; then
      found=$(grep "export ${var_name}=" "$rc" 2>/dev/null | tail -1 | sed 's/^export [^=]*=//' | tr -d '"' | tr -d "'")
      if [ -n "$found" ]; then
        echo "$found"
        return 0
      fi
    fi
  done

  return 1
}

describe_source() {
  local var_name="$1"

  # Check environment
  eval "local env_val=\"\${$var_name}\""
  if [ -n "$env_val" ]; then
    echo "environment variable"
    return
  fi

  # Check .env
  if [ -f "app/.env" ]; then
    local env_file_val=$(grep "^${var_name}=" "app/.env" 2>/dev/null | head -1 | cut -d= -f2-)
    if [ -n "$env_file_val" ]; then
      echo "app/.env"
      return
    fi
  fi

  # Check shell configs
  for rc in "$HOME/.zshrc" "$HOME/.zprofile" "$HOME/.bashrc" "$HOME/.bash_profile"; do
    if [ -f "$rc" ]; then
      local rc_val=$(grep "export ${var_name}=" "$rc" 2>/dev/null | tail -1)
      if [ -n "$rc_val" ]; then
        echo "$(basename "$rc")"
        return
      fi
    fi
  done

  echo "unknown"
}

# Detect Anthropic key
DETECTED_ANTHROPIC=$(detect_key "ANTHROPIC_API_KEY" || true)
DETECTED_OPENAI=$(detect_key "OPENAI_API_KEY" || true)

# Show what we found
FOUND_ANY=false
if [ -n "$DETECTED_ANTHROPIC" ]; then
  FOUND_ANY=true
  ANTHRO_SOURCE=$(describe_source "ANTHROPIC_API_KEY")
  success "Found Anthropic API key — $(mask_key "$DETECTED_ANTHROPIC") (from $ANTHRO_SOURCE)"
fi

if [ -n "$DETECTED_OPENAI" ]; then
  FOUND_ANY=true
  OPENAI_SOURCE=$(describe_source "OPENAI_API_KEY")
  success "Found OpenAI API key — $(mask_key "$DETECTED_OPENAI") (from $OPENAI_SOURCE)"
fi

if ! $FOUND_ANY; then
  dim "No existing API keys found in environment, .env, or shell config."
fi

echo ""

# Decision flow
if [ -n "$DETECTED_ANTHROPIC" ] && [ -n "$DETECTED_OPENAI" ]; then
  # Both found
  info "Both providers detected."
  echo ""
  echo "  [1] Use both (recommended)"
  echo "  [2] Anthropic only"
  echo "  [3] OpenAI only"
  echo "  [4] Enter different keys"
  echo ""
  read -p "  Choice [1]: " KEY_CHOICE
  KEY_CHOICE=${KEY_CHOICE:-1}

  case $KEY_CHOICE in
    1) ANTHROPIC_KEY="$DETECTED_ANTHROPIC"; OPENAI_KEY="$DETECTED_OPENAI"; DEFAULT_MODEL="claude-sonnet-4-6" ;;
    2) ANTHROPIC_KEY="$DETECTED_ANTHROPIC"; DEFAULT_MODEL="claude-sonnet-4-6" ;;
    3) OPENAI_KEY="$DETECTED_OPENAI"; DEFAULT_MODEL="gpt-4o" ;;
    4) ;; # Fall through to manual entry below
    *) fail "Invalid choice." ;;
  esac

elif [ -n "$DETECTED_ANTHROPIC" ]; then
  # Only Anthropic found
  if confirm "Use detected Anthropic key?" "y"; then
    ANTHROPIC_KEY="$DETECTED_ANTHROPIC"
    DEFAULT_MODEL="claude-sonnet-4-6"
  fi

  if confirm "Also configure OpenAI?"; then
    OPENAI_KEY=$(ask_secret "Enter your OpenAI API key (sk-...)")
    [ -z "$OPENAI_KEY" ] && warn "Skipped — you can add it later in app/.env"
  fi

elif [ -n "$DETECTED_OPENAI" ]; then
  # Only OpenAI found
  if confirm "Use detected OpenAI key?" "y"; then
    OPENAI_KEY="$DETECTED_OPENAI"
    DEFAULT_MODEL="gpt-4o"
  fi

  if confirm "Also configure Anthropic? (recommended)"; then
    ANTHROPIC_KEY=$(ask_secret "Enter your Anthropic API key (sk-ant-...)")
    [ -n "$ANTHROPIC_KEY" ] && DEFAULT_MODEL="claude-sonnet-4-6"
  fi
fi

# Manual entry if nothing set yet
if [ -z "$ANTHROPIC_KEY" ] && [ -z "$OPENAI_KEY" ]; then
  echo ""
  info "Choose your AI provider:"
  echo ""
  echo "  [1] Anthropic (Claude) — recommended"
  echo "  [2] OpenAI (GPT-4o, o3, etc.)"
  echo "  [3] Both"
  echo ""
  read -p "  Choice [1]: " PROVIDER_CHOICE
  PROVIDER_CHOICE=${PROVIDER_CHOICE:-1}

  case $PROVIDER_CHOICE in
    1)
      ANTHROPIC_KEY=$(ask_secret "Enter your Anthropic API key (sk-ant-...)")
      [ -z "$ANTHROPIC_KEY" ] && fail "API key is required."
      DEFAULT_MODEL="claude-sonnet-4-6"
      ;;
    2)
      OPENAI_KEY=$(ask_secret "Enter your OpenAI API key (sk-...)")
      [ -z "$OPENAI_KEY" ] && fail "API key is required."
      DEFAULT_MODEL="gpt-4o"
      ;;
    3)
      ANTHROPIC_KEY=$(ask_secret "Enter your Anthropic API key (sk-ant-...)")
      OPENAI_KEY=$(ask_secret "Enter your OpenAI API key (sk-...)")
      [ -z "$ANTHROPIC_KEY" ] && [ -z "$OPENAI_KEY" ] && fail "At least one API key is required."
      DEFAULT_MODEL="claude-sonnet-4-6"
      ;;
    *)
      fail "Invalid choice."
      ;;
  esac
fi

# Validate key format (non-blocking warning)
if [ -n "$ANTHROPIC_KEY" ] && [[ ! "$ANTHROPIC_KEY" =~ ^sk-ant- ]]; then
  warn "Anthropic key doesn't start with sk-ant- — this may not work"
fi

# Default model fallback
[ -z "$DEFAULT_MODEL" ] && DEFAULT_MODEL="claude-sonnet-4-6"

# Summary
echo ""
PROVIDER_LABEL=""
[ -n "$ANTHROPIC_KEY" ] && PROVIDER_LABEL="Anthropic"
[ -n "$OPENAI_KEY" ] && PROVIDER_LABEL="${PROVIDER_LABEL:+$PROVIDER_LABEL + }OpenAI"
success "Provider: $PROVIDER_LABEL | Default model: $DEFAULT_MODEL"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Step 3: Install Dependencies
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

header "Step 3/6 — Dependencies"

NPM_OPTS="--registry https://registry.npmjs.org/"

# Root
(npm install $NPM_OPTS --silent 2>&1 > /tmp/jarvis-setup-npm.log) &
spinner $! "Installing root dependencies..."
success "Root dependencies"

# App
(cd app && npm install $NPM_OPTS --silent 2>&1 > /tmp/jarvis-setup-npm.log) &
spinner $! "Installing app dependencies..."
success "App dependencies"

# UI
(cd app/ui && npm install $NPM_OPTS --silent 2>&1 > /tmp/jarvis-setup-npm.log) &
spinner $! "Installing UI dependencies..."
success "UI dependencies"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Step 4: Build UI
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

header "Step 4/6 — Building HUD"

(cd app/ui && npm run build --silent 2>&1 > /tmp/jarvis-setup-build.log) &
spinner $! "Building Electron HUD..."
if [ -d "app/ui/dist" ]; then
  success "HUD built"
else
  warn "HUD build may have failed — check /tmp/jarvis-setup-build.log"
fi

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Step 5: Write Configuration
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

header "Step 5/6 — Configuration"

mkdir -p app/.jarvis

# --- settings.user.json ---
SETTINGS_USER="app/.jarvis/settings.user.json"

if [ -f "$SETTINGS_USER" ]; then
  info "Existing settings.user.json found"
  # Update model if different
  CURRENT_MODEL=$(grep '"model"' "$SETTINGS_USER" 2>/dev/null | head -1 | sed 's/.*: *"\([^"]*\)".*/\1/')
  if [ -n "$CURRENT_MODEL" ] && [ "$CURRENT_MODEL" != "$DEFAULT_MODEL" ]; then
    if confirm "Update model from $CURRENT_MODEL to $DEFAULT_MODEL?"; then
      # Use a temp file for safe JSON editing
      if command -v node &>/dev/null; then
        node -e "
          const fs = require('fs');
          const s = JSON.parse(fs.readFileSync('$SETTINGS_USER', 'utf8'));
          s.model = '$DEFAULT_MODEL';
          fs.writeFileSync('$SETTINGS_USER', JSON.stringify(s, null, 2) + '\n');
        "
        success "Model updated to $DEFAULT_MODEL"
      fi
    else
      dim "Keeping model: $CURRENT_MODEL"
    fi
  else
    success "Settings OK (model: ${CURRENT_MODEL:-$DEFAULT_MODEL})"
  fi
else
  cat > "$SETTINGS_USER" << EOJSON
{
  "model": "$DEFAULT_MODEL",
  "pieces": {}
}
EOJSON
  success "Created settings.user.json (model: $DEFAULT_MODEL)"
fi

# --- .env ---
ENV_FILE="app/.env"
WROTE_ENV=false

if [ -f "$ENV_FILE" ]; then
  # Merge: keep existing keys, add/update new ones
  EXISTING_ANTHROPIC=$(grep "^ANTHROPIC_API_KEY=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2-)
  EXISTING_OPENAI=$(grep "^OPENAI_API_KEY=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2-)

  if [ -n "$ANTHROPIC_KEY" ] && [ "$ANTHROPIC_KEY" != "$EXISTING_ANTHROPIC" ]; then
    WROTE_ENV=true
  fi
  if [ -n "$OPENAI_KEY" ] && [ "$OPENAI_KEY" != "$EXISTING_OPENAI" ]; then
    WROTE_ENV=true
  fi
fi

if $WROTE_ENV || [ ! -f "$ENV_FILE" ]; then
  > "$ENV_FILE"
  [ -n "$ANTHROPIC_KEY" ] && echo "ANTHROPIC_API_KEY=$ANTHROPIC_KEY" >> "$ENV_FILE"
  [ -n "$OPENAI_KEY" ] && echo "OPENAI_API_KEY=$OPENAI_KEY" >> "$ENV_FILE"
  success "API keys saved to app/.env"
else
  success "app/.env is up to date"
fi

# --- mcp.json (create default if missing) ---
MCP_FILE="app/mcp.json"
if [ ! -f "$MCP_FILE" ]; then
  echo '{ "mcpServers": {} }' > "$MCP_FILE"
  dim "Created empty mcp.json — add MCP servers later"
fi

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Step 6: macOS App
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

if $IS_MAC; then
  header "Step 6/6 — macOS App"

  APP_DIR="$HOME/Applications/JARVIS.app"

  if [ -d "$APP_DIR" ]; then
    success "JARVIS.app already installed at $APP_DIR"
    if confirm "Reinstall/update JARVIS.app?"; then
      INSTALL_APP=true
    else
      INSTALL_APP=false
    fi
  else
    info "JARVIS can be installed as a native macOS app."
    dim "Opens from Spotlight (⌘+Space → JARVIS) or Launchpad."
    echo ""
    if confirm "Install JARVIS.app?" "y"; then
      INSTALL_APP=true
    else
      INSTALL_APP=false
    fi
  fi

  if $INSTALL_APP; then
    if [ -f "scripts/install-macos-app.sh" ]; then
      bash scripts/install-macos-app.sh 2>&1 | while IFS= read -r line; do
        dim "$line"
      done
      if [ -d "$APP_DIR" ]; then
        success "JARVIS.app installed — launch via Spotlight (⌘+Space → JARVIS)"
      else
        warn "macOS app installation may have failed (non-critical)"
      fi
    else
      warn "install-macos-app.sh not found. Skipping app creation."
    fi
  fi
else
  header "Step 6/6 — Platform"
  success "Linux/other detected — skipping macOS app creation"
  dim "Start JARVIS with: cd app && npx tsx src/main.ts"
fi

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Startup Test
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

echo ""
if confirm "Run a quick startup test?" "y"; then
  cd app

  # Source env
  set -a
  source .env 2>/dev/null || true
  set +a

  # Start JARVIS in background
  npx tsx src/main.ts > /tmp/jarvis-setup-test.log 2>&1 &
  JARVIS_PID=$!

  # Wait for server to be ready (retry up to 20 seconds)
  READY=false
  for i in $(seq 1 20); do
    printf "\r  ${BLUE}⠋${RESET} Waiting for JARVIS... (%ds)" "$i"
    if curl -s http://localhost:50052/hud 2>/dev/null | grep -q "reactor\|pieces" 2>/dev/null; then
      READY=true
      break
    fi
    sleep 1
  done
  printf "\r\033[K"

  # Clean up — graceful
  kill "$JARVIS_PID" 2>/dev/null || true
  sleep 1
  # Only kill remaining Electron windows that WE started
  if kill -0 "$JARVIS_PID" 2>/dev/null; then
    kill -9 "$JARVIS_PID" 2>/dev/null || true
  fi
  wait "$JARVIS_PID" 2>/dev/null || true

  cd ..

  if $READY; then
    success "JARVIS startup verified — server responded on http://localhost:50052"
  else
    warn "JARVIS didn't respond within 20s — check /tmp/jarvis-setup-test.log"
    dim "This might be normal on first run. Try starting manually: cd app && npx tsx src/main.ts"
  fi
fi

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Summary
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
printf "${GREEN}${BOLD}  ✓ JARVIS setup complete!${RESET}\n"
echo ""

# Config summary
printf "  ${BOLD}Provider${RESET}   $PROVIDER_LABEL\n"
printf "  ${BOLD}Model${RESET}      $DEFAULT_MODEL\n"
printf "  ${BOLD}HUD${RESET}        http://localhost:50052\n"
printf "  ${BOLD}gRPC${RESET}       localhost:50051\n"

echo ""
printf "  ${BOLD}How to start:${RESET}\n"
echo ""

if $IS_MAC && [ -d "$HOME/Applications/JARVIS.app" ]; then
  echo "    • Spotlight: ⌘+Space → JARVIS"
  echo "    • Terminal:  cd app && npx tsx src/main.ts"
else
  echo "    cd app && npx tsx src/main.ts"
fi

echo ""
printf "  ${BOLD}Configuration files:${RESET}\n"
echo ""
echo "    app/.env                       API keys"
echo "    app/.jarvis/settings.user.json  Model, pieces, plugins"
echo "    app/mcp.json                   MCP server connections"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
