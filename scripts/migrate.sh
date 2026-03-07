#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════════
# OpenClaw Task System — Schema Migration Runner
# ═══════════════════════════════════════════════════════════════════════════════
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
OPENCLAW_DIR="$(cd "$PLUGIN_DIR/../.." && pwd)"
OPENCLAW_JSON="$OPENCLAW_DIR/openclaw.json"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
log()  { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
err()  { echo -e "${RED}[✗]${NC} $1"; }
info() { echo -e "${CYAN}[i]${NC} $1"; }

# Read DB config from openclaw.json
if [[ ! -f "$OPENCLAW_JSON" ]]; then
  err "openclaw.json not found at $OPENCLAW_JSON"
  exit 1
fi

DB_HOST=$(jq -r '.plugins.entries["task-system"].config.database.host // "localhost"' "$OPENCLAW_JSON")
DB_PORT=$(jq -r '.plugins.entries["task-system"].config.database.port // 5432' "$OPENCLAW_JSON")
DB_NAME=$(jq -r '.plugins.entries["task-system"].config.database.database // "openclaw_tasks"' "$OPENCLAW_JSON")
DB_USER=$(jq -r '.plugins.entries["task-system"].config.database.user // "openclaw"' "$OPENCLAW_JSON")
DB_PASS=$(jq -r '.plugins.entries["task-system"].config.database.password // ""' "$OPENCLAW_JSON")

info "Database: $DB_NAME @ $DB_HOST:$DB_PORT (user: $DB_USER)"

# Get current schema version
CURRENT_VER=$(PGPASSWORD="$DB_PASS" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -t -c \
  "SELECT COALESCE(MAX(version), 0) FROM schema_version;" 2>/dev/null | tr -d ' ')

if [[ -z "$CURRENT_VER" || "$CURRENT_VER" == "" ]]; then
  CURRENT_VER=0
fi

info "Current schema version: $CURRENT_VER"

# Run migrations
MIGRATION_DIR="$PLUGIN_DIR/lib/migrations"
if [[ ! -d "$MIGRATION_DIR" ]]; then
  info "No migrations directory found. Nothing to do."
  exit 0
fi

APPLIED=0
for migration in $(ls "$MIGRATION_DIR"/*.sql 2>/dev/null | sort); do
  FILENAME=$(basename "$migration")
  # Extract version number from filename (e.g., 002_add_column.sql -> 2)
  VER=$(echo "$FILENAME" | grep -oP '^\d+' | sed 's/^0*//')
  if [[ -z "$VER" ]]; then continue; fi

  if [[ $VER -gt $CURRENT_VER ]]; then
    info "Applying migration $FILENAME (v$VER)..."
    PGPASSWORD="$DB_PASS" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -f "$migration" 2>&1 | while read -r line; do
      if echo "$line" | grep -qi 'error'; then
        warn "$line"
      fi
    done
    PGPASSWORD="$DB_PASS" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -c \
      "INSERT INTO schema_version (version) VALUES ($VER);" 2>/dev/null
    log "Migration $FILENAME applied"
    APPLIED=$((APPLIED + 1))
  fi
done

if [[ $APPLIED -eq 0 ]]; then
  log "Schema is up to date (v$CURRENT_VER)"
else
  log "Applied $APPLIED migration(s)"
fi
