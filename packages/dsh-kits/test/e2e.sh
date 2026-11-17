#!/usr/bin/env bash
# DeepSeek Harness uses Kition's kit tools (D1), end to end, with a scripted model.
#
#   test/e2e.sh <kition-kits-mcp> <kition-note> <Plan.md> <dsh python sdk src>
#
# Needs Node and npm, and a Python with pydantic (set PYTHON to use another one).
# Installs the published dsh runtime into a cache folder on first run (about 500 MB), then runs
# the runtime with the stdio patch against a copy of the note.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
mcp="${1:?kition-kits-mcp}"; note="${2:?kition-note}"; fixture="${3:?a .md file}"; sdk="${4:?dsh python sdk src}"
cache="${DSH_KITS_CACHE:-${TMPDIR:-/tmp}/dsh-kits-e2e}"
mkdir -p "$cache"
if [[ ! -x "$cache/node_modules/.bin/dsh" ]]; then
  (cd "$cache" && npm init -y >/dev/null && npm install --silent @deepseek-ai/dsh@0.2.0-rc.2)
fi
work="$(mktemp -d)"; trap 'kill "${model:-0}" 2>/dev/null || true; rm -rf "$work"' EXIT
mkdir -p "$work/notes" "$work/home"
cp "$fixture" "$work/notes/Plan.md"
python3 "$here/scripted_model.py" 18777 "$work/requests.jsonl" & model=$!
sleep 1
DSH_BIN="$cache/node_modules/.bin/dsh" DSH_HOME="$work/home" DSH_PYTHON_SDK="$sdk" \
  KITION_KITS_MCP="$mcp" KITION_WORKSPACE="$work" KITION_KIT_NOTE_BINARY="$note" \
  "${PYTHON:-python3}" "$here/run_dsh.py"
