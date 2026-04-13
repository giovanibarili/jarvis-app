#!/bin/bash
set -e

cd "$(dirname "$0")"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# JARVIS — Setup Wizard
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

# --- Helper functions ---

info() {
  printf "\033[1;34mℹ %s\033[0m\n" "$1"
}

success() {
  printf "\033[1;32m✓ %s\033[0m\n" "$1"
}

warn() {
  printf "\033[1;33m⚠ %s\033[0m\n" "$1"
}

error() {
  printf "\033[1;31m✗ %s\033[0m\n" "$1"
  exit 1
}

ask() {
  local prompt="$1"
  local default="$2"
  local result
  if [ -n "$default" ]; then
    read -p "$prompt [$default]: " result
    echo "${result:-$default}"
  else
    read -p "$prompt: " result
    echo "$result"
  fi
}

confirm() {
  local prompt="$1"
  local reply
  read -p "$prompt [y/N]: " reply
  case "$reply" in
    [yY]|[yY][eE][sS]) return 0 ;;
    *) return 1 ;;
  esac
}

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  J.A.R.V.I.S. — Setup Wizard"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Step 1: Prerequisites
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

info "Step 1: Checking prerequisites..."
echo ""

# Check Node.js
if ! command -v node &>/dev/null; then
  warn "Node.js not found."
  if confirm "Install Node.js via Homebrew?"; then
    if ! command -v brew &>/dev/null; then
      error "Homebrew not found. Install from https://brew.sh first."
    fi
    brew install node
  else
    error "Node.js 20+ is required. Install from https://nodejs.org"
  fi
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 20 ]; then
  error "Node.js 20+ required. Found: $(node -v)"
fi
success "Node.js $(node -v)"

# Check npm
if ! command -v npm &>/dev/null; then
  error "npm not found. Install Node.js from https://nodejs.org"
fi
success "npm $(npm -v)"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Step 2: Choose Provider
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

echo ""
info "Step 2: Choose your AI provider"
echo ""
echo "  [1] Anthropic (Claude) — recommended"
echo "  [2] OpenAI (GPT-4o, o3, etc.)"
echo "  [3] Both"
echo ""
read -p "Choice [1]: " PROVIDER_CHOICE
PROVIDER_CHOICE=${PROVIDER_CHOICE:-1}

ANTHROPIC_KEY=""
OPENAI_KEY=""
DEFAULT_MODEL=""

case $PROVIDER_CHOICE in
  1)
    read -sp "Enter your Anthropic API key (sk-ant-...): " ANTHROPIC_KEY
    echo ""
    if [[ ! "$ANTHROPIC_KEY" =~ ^sk-ant- ]]; then
      warn "Key doesn't start with sk-ant-. Continuing anyway."
    fi
    DEFAULT_MODEL="claude-sonnet-4-6"
    ;;
  2)
    read -sp "Enter your OpenAI API key (sk-...): " OPENAI_KEY
    echo ""
    DEFAULT_MODEL="gpt-4o"
    ;;
  3)
    read -sp "Enter your Anthropic API key (sk-ant-...): " ANTHROPIC_KEY
    echo ""
    read -sp "Enter your OpenAI API key (sk-...): " OPENAI_KEY
    echo ""
    DEFAULT_MODEL="claude-sonnet-4-6"
    ;;
  *)
    error "Invalid choice."
    ;;
esac
success "Provider configured"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Step 3: Install Dependencies
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

echo ""
info "Step 3: Installing dependencies..."
echo ""

NPM_OPTS="--registry https://registry.npmjs.org/"

# Root
npm install $NPM_OPTS || error "npm install failed in root"
success "Root dependencies installed"

# App
cd app
npm install $NPM_OPTS || error "npm install failed in app/"
success "App dependencies installed"

# UI
cd ui
npm install $NPM_OPTS || error "npm install failed in app/ui/"
success "UI dependencies installed"
cd ../..


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Step 4: Build UI
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

echo ""
info "Step 4: Building UI..."
echo ""

cd app/ui
npm run build || error "UI build failed"
cd ../..
success "UI built"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Step 5: Create settings.user.json
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

echo ""
info "Step 5: Configuring settings..."
echo ""

SETTINGS_USER="app/.jarvis/settings.user.json"
mkdir -p app/.jarvis

write_settings=false

if [ -f "$SETTINGS_USER" ]; then
  if confirm "settings.user.json exists. Overwrite?"; then
    write_settings=true
  else
    warn "Keeping existing settings"
  fi
else
  write_settings=true
fi

if [ "$write_settings" = true ]; then
  cat > "$SETTINGS_USER" << EOJSON
{
  "model": "$DEFAULT_MODEL",
  "pieces": {}
}
EOJSON
  success "Settings created ($DEFAULT_MODEL)"
fi

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Step 6: Write environment
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

echo ""
info "Step 6: Saving API keys..."
echo ""

ENV_FILE="app/.env"
> "$ENV_FILE"
[ -n "$ANTHROPIC_KEY" ] && echo "ANTHROPIC_API_KEY=$ANTHROPIC_KEY" >> "$ENV_FILE"
[ -n "$OPENAI_KEY" ] && echo "OPENAI_API_KEY=$OPENAI_KEY" >> "$ENV_FILE"
success "API keys saved to .env"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Step 7: macOS App (if Mac)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

if [[ "$OSTYPE" == "darwin"* ]]; then
  echo ""
  info "Step 7: macOS App"
  echo ""

  if confirm "Create JARVIS.app in /Applications?"; then
    if [ -f "scripts/build-macos-app.sh" ]; then
      bash scripts/build-macos-app.sh || warn "macOS app creation failed (non-critical)"
      if [ -d "/Applications/JARVIS.app" ]; then
        success "JARVIS.app created"
      fi
    else
      warn "macOS app build script not found. Skipping."
    fi
  fi
fi

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Step 8: First Run Test
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

echo ""
info "Step 8: Testing JARVIS startup..."
echo ""

cd app

# Source env
set -a
source .env 2>/dev/null || true
set +a

npx tsx src/main.ts > /dev/null 2>&1 &
JARVIS_PID=$!

# Wait for server to be ready (retry up to 15 seconds)
READY=false
for i in $(seq 1 15); do
  if curl -s http://localhost:50052/hud 2>/dev/null | grep -q "reactor"; then
    READY=true
    break
  fi
  sleep 1
done

# Clean up
kill $JARVIS_PID 2>/dev/null || true
pkill -f "[Ee]lectron" 2>/dev/null || true
wait $JARVIS_PID 2>/dev/null || true

if [ "$READY" = true ]; then
  success "JARVIS startup verified (http://localhost:50052)"
else
  error "JARVIS failed to start. Check logs at app/.jarvis/logs/jarvis.log"
fi

cd ..

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Step 9: Done
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
success "JARVIS setup complete!"
echo ""
PROVIDER_LABEL=""
[ -n "$ANTHROPIC_KEY" ] && PROVIDER_LABEL="Anthropic"
[ -n "$OPENAI_KEY" ] && PROVIDER_LABEL="${PROVIDER_LABEL:+$PROVIDER_LABEL + }OpenAI"
info "Provider: $PROVIDER_LABEL"
info "Model: $DEFAULT_MODEL"
info "HUD: http://localhost:50052"
echo ""
info "To start JARVIS:"
echo "  cd app && npx tsx src/main.ts"
echo ""
if [[ "$OSTYPE" == "darwin"* ]] && [ -d "/Applications/JARVIS.app" ]; then
  info "Or open JARVIS from Spotlight/Applications"
fi
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
