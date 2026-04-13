# Setup Wizard — Design Spec

## Goal

Single shell script (`setup.sh`) that takes a new user from git clone to JARVIS running. Interactive, idempotent, handles prerequisites.

## Flow

1. **Check prerequisites** — Node.js 20+, npm. If missing, ask permission to install (brew on Mac, nvm fallback). Fail with clear message if user declines.

2. **Choose provider** — Prompt: "Which AI provider? [1] Anthropic (Claude) [2] OpenAI [3] Both". Ask API key for chosen provider(s). Validate key format (sk-ant-* for Anthropic, sk-* for OpenAI).

3. **Install dependencies** — `npm install --registry https://registry.npmjs.org/` in root, app/, and packages/core/. Always force public npm registry.

4. **Build UI** — `cd app/ui && npm run build`. Verify dist/ created.

5. **Create settings.user.json** — Write model and provider config based on step 2 choices. If file exists, ask before overwriting.

6. **macOS app** (if detected Mac) — Ask if user wants to create JARVIS.app in /Applications. Uses existing scripts/build-macos-app.sh if present.

7. **First run test** — Start JARVIS, wait for port 50052 to respond, verify /hud endpoint returns data, show URL. Stop after verification.

8. **Done** — Print summary: provider, model, URL, how to start (`cd app && npx tsx src/main.ts`).

## Principles

- Colored output: green=success, yellow=in progress, red=error
- Each step numbered and labeled
- Any error stops execution with clear fix instructions
- Idempotent — safe to re-run
- Never overwrites settings.user.json without asking
- npm always uses `--registry https://registry.npmjs.org/`

## File

`setup.sh` at repo root. `chmod +x`. README updated to point to it.

## Out of Scope

- Windows/Linux support (Mac first, extend later)
- Plugin installation (manual for now)
- MCP server configuration
