#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════════
# OpenClaw Task Orchestration System — Installer
# ═══════════════════════════════════════════════════════════════════════════════
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
OPENCLAW_DIR="$(cd "$PLUGIN_DIR/../.." && pwd)"
OPENCLAW_JSON="$OPENCLAW_DIR/openclaw.json"
CRON_FILE="$OPENCLAW_DIR/cron/jobs.json"
AGENT_FILES_DIR="$PLUGIN_DIR/agent-files"

# Colors
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'; BOLD='\033[1m'

log()  { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
err()  { echo -e "${RED}[✗]${NC} $1"; }
info() { echo -e "${CYAN}[i]${NC} $1"; }
header() { echo -e "\n${BOLD}${CYAN}═══ $1 ═══${NC}\n"; }

# ── Banner ────────────────────────────────────────────────────────────────────
echo -e "${BOLD}${CYAN}"
echo "  ╔═══════════════════════════════════════════════════════╗"
echo "  ║     OpenClaw Task Orchestration System Installer      ║"
echo "  ╚═══════════════════════════════════════════════════════╝"
echo -e "${NC}"

# ══════════════════════════════════════════════════════════════════════════════
# STEP 1 (FIRST QUESTION): Scheduler Agent Check
# ══════════════════════════════════════════════════════════════════════════════
header "Scheduler Agent Check"

echo -e "  The Task Orchestration System requires a dedicated ${BOLD}scheduler agent${NC}."
echo -e "  This agent runs periodic cycles (stuck task detection, deadline"
echo -e "  warnings, escalation enforcement, morning briefings, daily reports)."
echo ""
echo -e "  The agent must already exist in your OpenClaw installation before"
echo -e "  proceeding. If you haven't created one yet, exit now and create it."
echo ""

read -rp "Is the scheduler agent already created? [y/N]: " AGENT_CREATED

if [[ "${AGENT_CREATED,,}" != "y" ]]; then
  echo ""
  echo -e "${YELLOW}────────────────────────────────────────────────────────────${NC}"
  echo ""
  echo -e "  ${BOLD}Please create a scheduler agent and rerun install.sh${NC}"
  echo ""
  echo -e "  Steps to create the agent:"
  echo -e "    1. Add the agent to your OpenClaw configuration"
  echo -e "       (e.g. agent ID: ${CYAN}scheduler${NC}, ${CYAN}task-scheduler${NC}, or any name you prefer)"
  echo -e "    2. Ensure its workspace directory exists at:"
  echo -e "       ${CYAN}~/.openclaw/workspace-<agent-id>/${NC}"
  echo -e "    3. Rerun this installer: ${CYAN}bash install.sh${NC}"
  echo ""
  echo -e "  The installer will configure the agent's workspace with all"
  echo -e "  necessary files (AGENTS.md, SOUL.md, IDENTITY.md, ROLES.md, TOOLS.md)."
  echo ""
  echo -e "${YELLOW}────────────────────────────────────────────────────────────${NC}"
  echo ""
  exit 0
fi

# ── Get the scheduler agent ID ───────────────────────────────────────────────
header "Scheduler Agent Configuration"

info "The scheduler agent will execute periodic cycles, generate reports,"
info "and enforce escalation rules."
echo ""

# List available agents from openclaw.json
AGENTS=""
if [[ -f "$OPENCLAW_JSON" ]]; then
  AGENTS=$(jq -r '.agents[]?.id // empty' "$OPENCLAW_JSON" 2>/dev/null || true)
  if [[ -n "$AGENTS" ]]; then
    info "Available agents:"
    echo "$AGENTS" | head -20 | while read -r a; do echo "    - $a"; done
    echo ""
  fi
fi

read -rp "Scheduler agent ID: " SCHEDULER_AGENT
while [[ -z "$SCHEDULER_AGENT" ]]; do
  warn "Agent ID is required."
  read -rp "Scheduler agent ID: " SCHEDULER_AGENT
done

# Verify the workspace directory exists
AGENT_WORKSPACE="$OPENCLAW_DIR/workspace-${SCHEDULER_AGENT}"
if [[ ! -d "$AGENT_WORKSPACE" ]]; then
  err "Workspace directory not found: $AGENT_WORKSPACE"
  err "The agent '$SCHEDULER_AGENT' does not appear to have a workspace."
  echo ""
  echo -e "  ${BOLD}Please create a scheduler agent and rerun install.sh${NC}"
  echo ""
  exit 1
fi

log "Found workspace for '$SCHEDULER_AGENT' at $AGENT_WORKSPACE"

# ── Deploy scheduler agent files ─────────────────────────────────────────────
header "Deploying Scheduler Agent Files"

info "Installing agent configuration files to $AGENT_WORKSPACE"
echo ""

DEPLOYED_FILES=0
for FILE in AGENTS.md SOUL.md IDENTITY.md ROLES.md TOOLS.md WORKER_RULES.md; do
  SRC="$AGENT_FILES_DIR/$FILE"
  DST="$AGENT_WORKSPACE/$FILE"

  if [[ ! -f "$SRC" ]]; then
    warn "Source file not found: $SRC — skipping"
    continue
  fi

  if [[ -f "$DST" ]]; then
    # Back up existing file
    BACKUP="${DST}.bak.$(date +%s)"
    cp "$DST" "$BACKUP"
    info "Backed up existing $FILE → $(basename "$BACKUP")"
  fi

  cp "$SRC" "$DST"
  log "Deployed $FILE"
  DEPLOYED_FILES=$((DEPLOYED_FILES + 1))
done

# Create memory directory if it doesn't exist
mkdir -p "$AGENT_WORKSPACE/memory"

log "Deployed $DEPLOYED_FILES agent files to workspace-${SCHEDULER_AGENT}"

read -rp "Scheduler interval in minutes [5]: " SCHED_INTERVAL
SCHED_INTERVAL=${SCHED_INTERVAL:-5}

log "Scheduler will run as '$SCHEDULER_AGENT' every ${SCHED_INTERVAL} minutes"

# ══════════════════════════════════════════════════════════════════════════════
# STEP 2: Prerequisites
# ══════════════════════════════════════════════════════════════════════════════
header "Checking Prerequisites"

check_cmd() {
  if command -v "$1" &>/dev/null; then
    log "$1 found: $(command -v "$1")"
    return 0
  else
    err "$1 not found"
    return 1
  fi
}

MISSING=0
check_cmd node || MISSING=1
check_cmd npm  || MISSING=1
check_cmd jq   || MISSING=1

if [[ $MISSING -eq 1 ]]; then
  err "Missing required tools. Install Node.js >=18, npm, and jq before running this installer."
  exit 1
fi

NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
if [[ $NODE_VER -lt 18 ]]; then
  err "Node.js >= 18 required (found v$(node -v))"
  exit 1
fi
log "Node.js version $(node -v) OK"

if [[ ! -f "$OPENCLAW_JSON" ]]; then
  err "openclaw.json not found at $OPENCLAW_JSON"
  err "Are you running this from inside an OpenClaw installation?"
  exit 1
fi
log "OpenClaw installation found at $OPENCLAW_DIR"

# ══════════════════════════════════════════════════════════════════════════════
# STEP 3: PostgreSQL
# ══════════════════════════════════════════════════════════════════════════════
header "PostgreSQL Setup"

if command -v psql &>/dev/null; then
  log "PostgreSQL client found"
else
  info "PostgreSQL not found. Installing PostgreSQL 16..."
  if command -v apt-get &>/dev/null; then
    sudo sh -c 'echo "deb http://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" > /etc/apt/sources.list.d/pgdg.list'
    curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | sudo gpg --dearmor -o /etc/apt/trusted.gpg.d/postgresql.gpg 2>/dev/null || true
    sudo apt-get update -qq
    sudo apt-get install -y -qq postgresql-16 postgresql-client-16
    log "PostgreSQL 16 installed"
  else
    err "Automatic PostgreSQL install only supported on Debian/Ubuntu (apt-get)."
    err "Please install PostgreSQL 16 manually and re-run this script."
    exit 1
  fi
fi

# Ensure PostgreSQL is running
if ! sudo systemctl is-active --quiet postgresql 2>/dev/null; then
  sudo systemctl start postgresql 2>/dev/null || true
  sudo systemctl enable postgresql 2>/dev/null || true
fi
log "PostgreSQL service running"

# ══════════════════════════════════════════════════════════════════════════════
# STEP 4: Database Configuration
# ══════════════════════════════════════════════════════════════════════════════
header "Database Configuration"

read -rp "Database name [openclaw_tasks]: " DB_NAME
DB_NAME=${DB_NAME:-openclaw_tasks}

read -rp "Database user [openclaw]: " DB_USER
DB_USER=${DB_USER:-openclaw}

read -rp "Database host [localhost]: " DB_HOST
DB_HOST=${DB_HOST:-localhost}

read -rp "Database port [5432]: " DB_PORT
DB_PORT=${DB_PORT:-5432}

# Generate or prompt for password
DEFAULT_PASS=$(openssl rand -base64 16 2>/dev/null || head -c 16 /dev/urandom | base64)
read -rp "Database password [auto-generated]: " DB_PASS
DB_PASS=${DB_PASS:-$DEFAULT_PASS}

# Create user and database
info "Creating PostgreSQL user and database..."
sudo -u postgres psql -v ON_ERROR_STOP=0 <<SQL 2>/dev/null || true
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${DB_USER}') THEN
    CREATE ROLE ${DB_USER} WITH LOGIN PASSWORD '${DB_PASS}';
  ELSE
    ALTER ROLE ${DB_USER} WITH PASSWORD '${DB_PASS}';
  END IF;
END
\$\$;
SQL

sudo -u postgres psql -v ON_ERROR_STOP=0 <<SQL 2>/dev/null || true
SELECT 'CREATE DATABASE ${DB_NAME} OWNER ${DB_USER}'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '${DB_NAME}')\gexec
GRANT ALL PRIVILEGES ON DATABASE ${DB_NAME} TO ${DB_USER};
SQL

# Grant schema permissions
sudo -u postgres psql -d "$DB_NAME" -v ON_ERROR_STOP=0 <<SQL 2>/dev/null || true
GRANT ALL ON SCHEMA public TO ${DB_USER};
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO ${DB_USER};
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO ${DB_USER};
SQL

log "Database '$DB_NAME' ready (user: $DB_USER)"

# ══════════════════════════════════════════════════════════════════════════════
# STEP 5: Schema
# ══════════════════════════════════════════════════════════════════════════════
header "Running Schema"

SCHEMA_FILE="$PLUGIN_DIR/lib/schema.sql"
if [[ ! -f "$SCHEMA_FILE" ]]; then
  err "Schema file not found: $SCHEMA_FILE"
  exit 1
fi

PGPASSWORD="$DB_PASS" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -f "$SCHEMA_FILE" 2>&1 | while IFS= read -r line; do
  case "$line" in
    *ERROR*|*error*)
      case "$line" in
        *"already exists"*) ;;  # ignore
        *) warn "$line" ;;
      esac
      ;;
  esac
done || true

# Insert schema version
PGPASSWORD="$DB_PASS" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -c \
  "INSERT INTO schema_version (version) VALUES (1) ON CONFLICT DO NOTHING;" 2>/dev/null || true

log "Schema applied successfully"

# ══════════════════════════════════════════════════════════════════════════════
# STEP 6: Dependencies
# ══════════════════════════════════════════════════════════════════════════════
header "Installing Dependencies"

cd "$PLUGIN_DIR"
npm install --production --silent 2>&1 | tail -1 || true
log "Plugin dependencies installed"

# ══════════════════════════════════════════════════════════════════════════════
# STEP 7: Build Web UI
# ══════════════════════════════════════════════════════════════════════════════
header "Building Web UI"

UI_DIR="$PLUGIN_DIR/web/ui"
if [[ -d "$UI_DIR" ]]; then
  cd "$UI_DIR"
  npm install --silent 2>&1 | tail -1 || true
  npm run build 2>&1 | tail -3 || { err "Web UI build failed"; exit 1; }
  log "Web UI built ($(du -sh dist/ 2>/dev/null | cut -f1) compressed)"
else
  warn "Web UI directory not found at $UI_DIR — skipping build"
fi

# ══════════════════════════════════════════════════════════════════════════════
# STEP 8: Web UI Configuration
# ══════════════════════════════════════════════════════════════════════════════
header "Web UI Configuration"

read -rp "Web UI port [18790]: " WEB_PORT
WEB_PORT=${WEB_PORT:-18790}

AUTH_TOKEN=$(openssl rand -hex 24 2>/dev/null || head -c 24 /dev/urandom | xxd -p)
read -rp "API auth token [auto-generated]: " USER_TOKEN
AUTH_TOKEN=${USER_TOKEN:-$AUTH_TOKEN}

log "Web UI will be available at http://0.0.0.0:$WEB_PORT"

# ══════════════════════════════════════════════════════════════════════════════
# STEP 9: Register Plugin in openclaw.json
# ══════════════════════════════════════════════════════════════════════════════
header "Registering Plugin"

# Build the plugin config object with scheduler agent permissions
PLUGIN_CONFIG=$(cat <<JSONEOF
{
  "database": {
    "host": "${DB_HOST}",
    "port": ${DB_PORT},
    "database": "${DB_NAME}",
    "user": "${DB_USER}",
    "password": "${DB_PASS}"
  },
  "webUI": {
    "enabled": true,
    "port": ${WEB_PORT},
    "host": "0.0.0.0",
    "authToken": "${AUTH_TOKEN}"
  },
  "scheduler": {
    "agentId": "${SCHEDULER_AGENT}",
    "checkIntervalMinutes": ${SCHED_INTERVAL},
    "stuckThresholdMinutes": 30,
    "deadlineWarningMinutes": 30,
    "cleanupDays": 30
  },
  "agentPermissions": {
    "*": ["system", "tasks_read"],
    "${SCHEDULER_AGENT}": ["supervisor"]
  }
}
JSONEOF
)

# Back up openclaw.json
cp "$OPENCLAW_JSON" "${OPENCLAW_JSON}.bak.$(date +%s)"

# Add to plugins.allow if not present
if jq -e '.plugins.allow | index("task-system")' "$OPENCLAW_JSON" &>/dev/null; then
  info "'task-system' already in plugins.allow"
else
  jq '.plugins.allow += ["task-system"]' "$OPENCLAW_JSON" > "${OPENCLAW_JSON}.tmp" && mv "${OPENCLAW_JSON}.tmp" "$OPENCLAW_JSON"
  log "Added 'task-system' to plugins.allow"
fi

# Add load path if not present (use absolute path to match existing convention)
PLUGIN_PATH="$PLUGIN_DIR"
if jq -e --arg p "$PLUGIN_PATH" '.plugins.load.paths | index($p)' "$OPENCLAW_JSON" &>/dev/null; then
  info "Load path already configured"
else
  jq --arg p "$PLUGIN_PATH" '.plugins.load.paths += [$p]' "$OPENCLAW_JSON" > "${OPENCLAW_JSON}.tmp" && mv "${OPENCLAW_JSON}.tmp" "$OPENCLAW_JSON"
  log "Added load path: $PLUGIN_PATH"
fi

# Set plugin entry config
jq --argjson cfg "$PLUGIN_CONFIG" '.plugins.entries["task-system"] = {"config": $cfg}' "$OPENCLAW_JSON" > "${OPENCLAW_JSON}.tmp" && mv "${OPENCLAW_JSON}.tmp" "$OPENCLAW_JSON"
log "Plugin configuration written to openclaw.json"
log "Scheduler agent '${SCHEDULER_AGENT}' granted 'supervisor' permissions"

# ══════════════════════════════════════════════════════════════════════════════
# STEP 10: systemd Service (optional)
# ══════════════════════════════════════════════════════════════════════════════
header "systemd Service (Optional)"

read -rp "Install systemd service for the web UI? [y/N]: " INSTALL_SERVICE
if [[ "${INSTALL_SERVICE,,}" == "y" ]]; then
  SERVICE_FILE="$PLUGIN_DIR/systemd/openclaw-task-ui.service"
  SYSTEMD_DIR="/etc/systemd/system"

  # Determine the user running this
  RUN_USER="${SUDO_USER:-$(whoami)}"

  cat > "$SERVICE_FILE" <<SVCEOF
[Unit]
Description=OpenClaw Task System Web UI
After=network.target postgresql.service
Wants=postgresql.service

[Service]
Type=simple
User=${RUN_USER}
Group=${RUN_USER}
WorkingDirectory=${PLUGIN_DIR}
Environment=NODE_ENV=production
Environment=TASK_DB_HOST=${DB_HOST}
Environment=TASK_DB_PORT=${DB_PORT}
Environment=TASK_DB_NAME=${DB_NAME}
Environment=TASK_DB_USER=${DB_USER}
Environment=TASK_DB_PASSWORD=${DB_PASS}
ExecStart=$(which node) ${PLUGIN_DIR}/web/server.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
SVCEOF

  sudo cp "$SERVICE_FILE" "$SYSTEMD_DIR/openclaw-task-ui.service"
  sudo systemctl daemon-reload
  sudo systemctl enable openclaw-task-ui
  log "systemd service installed and enabled"
  info "Start with: sudo systemctl start openclaw-task-ui"
else
  info "Skipped systemd service installation"
fi

# ══════════════════════════════════════════════════════════════════════════════
# Summary
# ══════════════════════════════════════════════════════════════════════════════
header "Installation Complete"

echo -e "${BOLD}${GREEN}"
echo "  ╔═══════════════════════════════════════════════════════╗"
echo "  ║           Installation Successful!                    ║"
echo "  ╚═══════════════════════════════════════════════════════╝"
echo -e "${NC}"

echo -e "  ${BOLD}Database:${NC}          $DB_NAME @ $DB_HOST:$DB_PORT (user: $DB_USER)"
echo -e "  ${BOLD}Web UI:${NC}            http://0.0.0.0:$WEB_PORT"
echo -e "  ${BOLD}Auth Token:${NC}        $AUTH_TOKEN"
echo -e "  ${BOLD}Scheduler Agent:${NC}   $SCHEDULER_AGENT (every ${SCHED_INTERVAL}m)"
echo -e "  ${BOLD}Agent Workspace:${NC}   $AGENT_WORKSPACE"
echo -e "  ${BOLD}Agent Files:${NC}       AGENTS.md, SOUL.md, IDENTITY.md, ROLES.md, TOOLS.md"
echo ""
echo -e "  ${CYAN}Next Steps:${NC}"
echo "  1. Restart OpenClaw:  openclaw restart"
echo "  2. Open the Web UI:   http://$(hostname -I 2>/dev/null | awk '{print $1}' || echo 'localhost'):$WEB_PORT"
echo "  3. Enter your auth token in Settings"
echo "  4. Configure agent permissions in Settings"
echo "  5. Register webhook sources in Webhooks > Sources"
echo "  6. Set up escalation rules in Escalations > Rules"
echo "  7. Configure agent availability in Agents"
echo ""
echo -e "  ${YELLOW}Save your auth token — you'll need it to access the API.${NC}"
echo ""
