#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════════
# OpenClaw Task System — Uninstaller
# ═══════════════════════════════════════════════════════════════════════════════
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
OPENCLAW_DIR="$(cd "$PLUGIN_DIR/../.." && pwd)"
OPENCLAW_JSON="$OPENCLAW_DIR/openclaw.json"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'; BOLD='\033[1m'
log()  { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
info() { echo -e "${CYAN}[i]${NC} $1"; }

echo -e "${BOLD}${RED}"
echo "  ╔═══════════════════════════════════════════════════════╗"
echo "  ║         OpenClaw Task System — Uninstaller            ║"
echo "  ╚═══════════════════════════════════════════════════════╝"
echo -e "${NC}"

echo -e "${YELLOW}This will:${NC}"
echo "  1. Remove the plugin from openclaw.json"
echo "  2. Stop and remove the systemd service (if installed)"
echo "  3. Optionally drop the database"
echo ""

read -rp "Are you sure? [y/N]: " CONFIRM
if [[ "${CONFIRM,,}" != "y" ]]; then
  echo "Cancelled."
  exit 0
fi

# ── Remove systemd service ───────────────────────────────────────────────────
if [[ -f /etc/systemd/system/openclaw-task-ui.service ]]; then
  info "Stopping and removing systemd service..."
  sudo systemctl stop openclaw-task-ui 2>/dev/null || true
  sudo systemctl disable openclaw-task-ui 2>/dev/null || true
  sudo rm -f /etc/systemd/system/openclaw-task-ui.service
  sudo systemctl daemon-reload
  log "systemd service removed"
fi

# ── Remove from openclaw.json ────────────────────────────────────────────────
if [[ -f "$OPENCLAW_JSON" ]]; then
  cp "$OPENCLAW_JSON" "${OPENCLAW_JSON}.bak.$(date +%s)"

  jq 'del(.plugins.entries["task-system"])
    | .plugins.allow = [.plugins.allow[] | select(. != "task-system")]
    | .plugins.load.paths = [.plugins.load.paths[] | select(. != "extensions/task-system")]' \
    "$OPENCLAW_JSON" > "${OPENCLAW_JSON}.tmp" && mv "${OPENCLAW_JSON}.tmp" "$OPENCLAW_JSON"

  log "Removed plugin from openclaw.json"
fi

# ── Drop database ────────────────────────────────────────────────────────────
read -rp "Drop the database 'openclaw_tasks'? This deletes ALL task data! [y/N]: " DROP_DB
if [[ "${DROP_DB,,}" == "y" ]]; then
  DB_NAME=$(jq -r '.plugins.entries["task-system"].config.database.database // "openclaw_tasks"' "${OPENCLAW_JSON}.bak."* 2>/dev/null | head -1)
  DB_NAME=${DB_NAME:-openclaw_tasks}
  sudo -u postgres psql -c "DROP DATABASE IF EXISTS ${DB_NAME};" 2>/dev/null || warn "Could not drop database"
  log "Database '${DB_NAME}' dropped"
else
  info "Database preserved"
fi

echo ""
log "Uninstall complete. Restart OpenClaw to apply changes."
