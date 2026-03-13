#!/usr/bin/env bash
# cleanup-memory-sessions.sh
# Removes all memory cycle sessions (dream/rumination/sensor_sweep) created
# by the runaway timer bug. Run on the server where openclaw is installed.
#
# Usage:
#   bash cleanup-memory-sessions.sh              # dry run (preview)
#   bash cleanup-memory-sessions.sh --apply      # actually delete

set -euo pipefail

STATE_DIR="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
AGENTS_DIR="$STATE_DIR/agents"
DRY_RUN=true

if [[ "${1:-}" == "--apply" ]]; then
  DRY_RUN=false
fi

if [[ ! -d "$AGENTS_DIR" ]]; then
  echo "ERROR: agents directory not found at $AGENTS_DIR"
  exit 1
fi

total_removed=0
total_transcripts=0

for agent_dir in "$AGENTS_DIR"/*/sessions; do
  [[ -d "$agent_dir" ]] || continue
  store="$agent_dir/sessions.json"
  [[ -f "$store" ]] || continue

  agent_id=$(basename "$(dirname "$agent_dir")")
  echo "=== Agent: $agent_id ==="
  echo "    Store: $store"

  # Count total sessions and memory sessions
  total=$(python3 -c "
import json, sys
with open('$store') as f:
    data = json.load(f)
keys = list(data.keys())
memory_keys = [k for k in keys if ':memory:' in k and ':run:' in k]
print(f'total={len(keys)} memory={len(memory_keys)}')

# Collect sessionIds for transcript deletion
for k in memory_keys:
    entry = data[k]
    sid = entry.get('sessionId', '')
    if sid:
        print(f'transcript={sid}')
" 2>/dev/null)

  total_count=$(echo "$total" | head -1 | grep -oP 'total=\K\d+')
  memory_count=$(echo "$total" | head -1 | grep -oP 'memory=\K\d+')
  transcript_ids=$(echo "$total" | grep '^transcript=' | sed 's/^transcript=//')

  echo "    Total sessions: $total_count"
  echo "    Memory cycle sessions to remove: $memory_count"

  if [[ "$memory_count" -eq 0 ]]; then
    echo "    Nothing to clean."
    echo ""
    continue
  fi

  # Count transcript files
  transcript_count=0
  for sid in $transcript_ids; do
    for ext in jsonl jsonl.gz; do
      if [[ -f "$agent_dir/$sid.$ext" ]]; then
        transcript_count=$((transcript_count + 1))
      fi
    done
  done
  echo "    Transcript files to delete: $transcript_count"

  if $DRY_RUN; then
    echo "    [DRY RUN] Would remove $memory_count sessions and $transcript_count transcript files"
  else
    # Remove memory session entries from store
    python3 -c "
import json
with open('$store') as f:
    data = json.load(f)
original = len(data)
data = {k: v for k, v in data.items() if ':memory:' not in k or ':run:' not in k}
with open('$store', 'w') as f:
    json.dump(data, f)
print(f'    Removed {original - len(data)} session entries, {len(data)} remaining')
"
    # Delete transcript files
    deleted=0
    for sid in $transcript_ids; do
      for ext in jsonl jsonl.gz; do
        if [[ -f "$agent_dir/$sid.$ext" ]]; then
          rm "$agent_dir/$sid.$ext"
          deleted=$((deleted + 1))
        fi
      done
    done
    echo "    Deleted $deleted transcript files"
  fi

  total_removed=$((total_removed + memory_count))
  total_transcripts=$((total_transcripts + transcript_count))
  echo ""
done

echo "==============================="
if $DRY_RUN; then
  echo "DRY RUN TOTAL: $total_removed sessions and $total_transcripts transcripts would be removed"
  echo ""
  echo "Run with --apply to actually delete:"
  echo "  bash $0 --apply"
else
  echo "DONE: Removed $total_removed sessions and $total_transcripts transcript files"
fi
