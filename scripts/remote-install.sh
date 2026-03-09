#!/usr/bin/env bash
# Remote installer / upgrader for the OpenClaw Task Orchestration System.
#
# Fresh install:
#   bash <(curl -fsSL https://raw.githubusercontent.com/DJTSmith18/openclaw-task-system/main/scripts/remote-install.sh)
#
# Upgrade existing install:
#   bash <(curl -fsSL https://raw.githubusercontent.com/DJTSmith18/openclaw-task-system/main/scripts/remote-install.sh) --upgrade
#
# Force full reconfiguration on an existing install:
#   bash <(curl -fsSL https://raw.githubusercontent.com/DJTSmith18/openclaw-task-system/main/scripts/remote-install.sh) --reconfigure
#
# NOTE: Use "bash <(curl ...)" not "curl ... | bash".
# Process substitution keeps stdin connected to the terminal so interactive
# prompts work. Piping through bash consumes stdin and breaks all read commands.
set -euo pipefail

REPO_OWNER="DJTSmith18"
REPO_NAME="openclaw-task-system"
BRANCH="main"
CUSTOM_DIR=""            # set by --dir; empty means "derive from openclaw base"
FORCE_UPGRADE=false      # skip prompts, just pull + npm install + build + migrate
FORCE_RECONFIGURE=false  # run full install.sh even on existing install

# ── Parse args ────────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --branch|-b)      BRANCH="$2"; shift 2 ;;
    --dir|-d)         CUSTOM_DIR="$2"; shift 2 ;;
    --upgrade|-u)     FORCE_UPGRADE=true; shift ;;
    --reconfigure|-r) FORCE_RECONFIGURE=true; shift ;;
    --help|-h)
      echo "Usage: remote-install.sh [options]"
      echo "  --branch,      -b   Git branch/tag to download (default: main)"
      echo "  --dir,         -d   Plugin install directory (default: <openclaw-base>/extensions/task-system)"
      echo "  --upgrade,     -u   Pull latest code, update deps, rebuild UI, run migrations; skip config prompts"
      echo "  --reconfigure, -r   Force full interactive reconfiguration on an existing install"
      exit 0
      ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

# ── Colours ───────────────────────────────────────────────────────────────────
red()    { printf '\033[31m%s\033[0m\n' "$*" >&2; }
green()  { printf '\033[32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*" >&2; }
cyan()   { printf '\033[36m%s\033[0m\n' "$*"; }
bold()   { printf '\033[1m%s\033[0m\n' "$*"; }

echo
echo "  ╔═══════════════════════════════════════════════════════╗"
echo "  ║   OpenClaw Task System — Install / Upgrade            ║"
echo "  ╚═══════════════════════════════════════════════════════╝"
echo

# ── Detect OpenClaw installation ─────────────────────────────────────────────
OPENCLAW_BASE="$HOME/.openclaw"

detect_openclaw() {
  local base="$1"

  # 1. Binary in PATH
  if command -v openclaw &>/dev/null; then
    green "OpenClaw found: $(command -v openclaw)"
    return 0
  fi

  # 2. Config file at the given base dir
  if [[ -f "$base/openclaw.json" ]]; then
    green "OpenClaw config found: $base/openclaw.json"
    return 0
  fi

  # 3. npm global install (binary may not be symlinked yet)
  if command -v npm &>/dev/null && npm list -g openclaw --depth=0 2>/dev/null | grep -q openclaw; then
    green "OpenClaw found via npm global packages"
    return 0
  fi

  return 1
}

if ! detect_openclaw "$OPENCLAW_BASE"; then
  yellow "OpenClaw was not detected at the standard location ($OPENCLAW_BASE)."
  printf 'Enter your OpenClaw base directory [%s]: ' "$OPENCLAW_BASE"
  read -r _input
  OPENCLAW_BASE="${_input:-$OPENCLAW_BASE}"
  OPENCLAW_BASE="${OPENCLAW_BASE/#\~/$HOME}"

  if [[ ! -f "$OPENCLAW_BASE/openclaw.json" ]]; then
    red "No openclaw.json found at $OPENCLAW_BASE"
    red "Please verify your OpenClaw installation and try again."
    exit 1
  fi
  green "OpenClaw config found: $OPENCLAW_BASE/openclaw.json"
fi
echo

# Derive CONFIG_FILE and PLUGIN_DIR from the confirmed base path.
# --dir overrides the plugin destination; otherwise use <base>/extensions/task-system.
# Directory name MUST match the plugin id in openclaw.plugin.json ("task-system").
export CONFIG_FILE="$OPENCLAW_BASE/openclaw.json"
PLUGIN_DIR="${CUSTOM_DIR:-$OPENCLAW_BASE/extensions/task-system}"

# ── Detect whether this is an existing install ────────────────────────────────
already_configured() {
  command -v jq &>/dev/null \
    && [[ -f "$CONFIG_FILE" ]] \
    && [[ "$(jq -r '.plugins.entries["task-system"].config // empty' "$CONFIG_FILE" 2>/dev/null)" != "" ]]
}

IS_UPGRADE=false
if [[ -f "$PLUGIN_DIR/package.json" ]] && already_configured; then
  IS_UPGRADE=true
fi

# Detect install at old directory name (openclaw-task-system → task-system)
OLD_PLUGIN_DIR="$OPENCLAW_BASE/extensions/openclaw-task-system"
if [[ "$IS_UPGRADE" == false && -f "$OLD_PLUGIN_DIR/package.json" ]] && already_configured; then
  IS_UPGRADE=true
  yellow "Found existing install at old path: $OLD_PLUGIN_DIR"
  cyan "New files will be installed to $PLUGIN_DIR; old directory will be removed after download."
fi

# --reconfigure overrides --upgrade and auto-detect
if [[ "$FORCE_RECONFIGURE" == true ]]; then
  IS_UPGRADE=false
fi
# --upgrade flag forces upgrade mode even if auto-detect missed it
if [[ "$FORCE_UPGRADE" == true ]]; then
  IS_UPGRADE=true
fi

# ── Download plugin (curl tarball — no git required) ─────────────────────────
TARBALL_URL="https://github.com/${REPO_OWNER}/${REPO_NAME}/archive/refs/heads/${BRANCH}.tar.gz"
cyan "Downloading plugin from: $TARBALL_URL"
mkdir -p "$PLUGIN_DIR"

_tmp_tar=$(mktemp /tmp/openclaw-task-system-XXXXXX.tar.gz)
cyan "Saving tarball to: $_tmp_tar"
curl -fsSL --progress-bar -H "Cache-Control: no-cache" "$TARBALL_URL?_=$(date +%s)" -o "$_tmp_tar"
_tar_size=$(du -sh "$_tmp_tar" 2>/dev/null | cut -f1)
green "Download complete ($_tar_size)"

cyan "Extracting to: $PLUGIN_DIR"
tar -xzv --strip-components=1 -C "$PLUGIN_DIR" -f "$_tmp_tar" 2>&1 | tail -20
rm -f "$_tmp_tar"

_file_count=$(find "$PLUGIN_DIR" -type f | wc -l | tr -d ' ')
_plugin_version=$(jq -r '.version // "unknown"' "$PLUGIN_DIR/package.json" 2>/dev/null || echo "unknown")
green "Extraction complete — $_file_count files in $PLUGIN_DIR (v${_plugin_version})"

echo

# Export so install.sh uses the correct paths if invoked below.
export PLUGIN_DIR

# ── Clean up old directory name if it exists ─────────────────────────────────
OLD_PLUGIN_DIR="${OLD_PLUGIN_DIR:-$OPENCLAW_BASE/extensions/openclaw-task-system}"
if [[ -d "$OLD_PLUGIN_DIR" && "$OLD_PLUGIN_DIR" != "$PLUGIN_DIR" ]]; then
  cyan "Removing old plugin directory: $OLD_PLUGIN_DIR"
  rm -rf "$OLD_PLUGIN_DIR"
  green "Old directory removed"

  # Update load path in openclaw.json
  if command -v jq &>/dev/null && [[ -f "$CONFIG_FILE" ]]; then
    _tmp=$(mktemp)
    jq --arg old "$OLD_PLUGIN_DIR" --arg new "$PLUGIN_DIR" '
      .plugins.load.paths |= map(if . == $old then $new else . end)
    ' "$CONFIG_FILE" > "$_tmp" && mv "$_tmp" "$CONFIG_FILE"
    green "Updated load path in openclaw.json: $OLD_PLUGIN_DIR → $PLUGIN_DIR"
  fi
fi

# ── Upgrade path: update deps, rebuild UI, run migrations ────────────────────
if [[ "$IS_UPGRADE" == true ]]; then
  bold "Existing install detected — upgrading..."
  echo

  # ── Plugin dependencies ──────────────────────────────────────────────────
  if [[ -f "$PLUGIN_DIR/package.json" ]]; then
    cyan "Updating plugin dependencies..."
    npm install --omit=dev --prefix "$PLUGIN_DIR" 2>&1 | tail -5 || true
    green "Plugin dependencies updated"
  fi

  # ── Web UI build ─────────────────────────────────────────────────────────
  UI_DIR="$PLUGIN_DIR/web/ui"
  if [[ -d "$UI_DIR" ]]; then
    cyan "Rebuilding Web UI..."
    rm -rf "$UI_DIR/dist"
    (cd "$UI_DIR" && npm install --silent 2>&1 | tail -1 || true)
    (cd "$UI_DIR" && npm run build 2>&1 | tail -3) || { red "Web UI build failed"; exit 1; }
    green "Web UI rebuilt ($(du -sh "$UI_DIR/dist/" 2>/dev/null | cut -f1) compressed)"
  fi

  # ── Database migrations ──────────────────────────────────────────────────
  if [[ -f "$PLUGIN_DIR/scripts/migrate.sh" ]]; then
    cyan "Running database migrations..."
    bash "$PLUGIN_DIR/scripts/migrate.sh"
  fi

  # ── Deploy agent files to scheduler workspace ────────────────────────────
  SCHEDULER_AGENT=$(jq -r '.plugins.entries["task-system"].config.scheduler.agentId // empty' "$CONFIG_FILE" 2>/dev/null || true)
  if [[ -n "$SCHEDULER_AGENT" ]]; then
    AGENT_WORKSPACE="$OPENCLAW_BASE/workspace-${SCHEDULER_AGENT}"
    if [[ -d "$AGENT_WORKSPACE" ]]; then
      cyan "Updating scheduler agent files in workspace-${SCHEDULER_AGENT}..."
      for FILE in AGENTS.md SOUL.md IDENTITY.md ROLES.md TOOLS.md WORKER_RULES.md; do
        SRC="$PLUGIN_DIR/agent-files/$FILE"
        DST="$AGENT_WORKSPACE/$FILE"
        if [[ -f "$SRC" ]]; then
          if [[ -f "$DST" ]]; then
            BACKUP="${DST}.bak.$(date +%s)"
            cp "$DST" "$BACKUP"
          fi
          cp "$SRC" "$DST"
        fi
      done
      mkdir -p "$AGENT_WORKSPACE/memory"
      green "Agent files updated"
    else
      yellow "Scheduler workspace not found at $AGENT_WORKSPACE — skipping agent file deploy"
    fi
  fi

  echo
  echo "  ╔═══════════════════════════════════════════════════════╗"
  echo "  ║           Upgrade complete!                           ║"
  echo "  ╚═══════════════════════════════════════════════════════╝"
  green "  Plugin version: v${_plugin_version}"
  echo

  cyan "Current config summary:"
  if command -v jq &>/dev/null; then
    jq -r '
      .plugins.entries["task-system"].config |
      "  DB:             " + (.database.database // "?") + " @ " + (.database.host // "?") + ":" + (.database.port // "?" | tostring),
      "  Web UI:         http://0.0.0.0:" + (.webUI.port // "?" | tostring),
      "  Scheduler:      " + (.scheduler.agentId // "?") + " (every " + (.scheduler.checkIntervalMinutes // "?" | tostring) + "m)"
    ' "$CONFIG_FILE" 2>/dev/null || true
  fi
  echo
  echo "  To apply changes: openclaw restart"
  echo "  To reconfigure:   re-run with --reconfigure"
  echo
  exit 0
fi

# ── Fresh install path ────────────────────────────────────────────────────────
bold "Launching interactive installer..."
echo
exec bash "$PLUGIN_DIR/scripts/install.sh"
