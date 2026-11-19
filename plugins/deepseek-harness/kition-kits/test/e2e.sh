#!/usr/bin/env bash
# The kition-kits plugin in a real DeepSeek Harness, end to end, with a scripted model.
#
#   test/e2e.sh <kition> <folder of kit repositories> <a .md file>
#
# Installs the published dsh runtime into a cache folder on first run (DSH_KITS_CACHE, about 1 GB),
# installs this plugin's folder with `dsh plugin add` into the headless profile of a DSH_HOME of
# its own, and runs one task on a copy of the note: kit_inspect through the plugin's MCP server,
# then the launcher's `drafts list` with the bash tool, as the draft skills run it. Needs Node.js
# 24.9 or later and pnpm on the PATH. The kit repositories folder must hold a debug build of the
# Note kit (kition-note/target/debug/kition-note); no kit is downloaded.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
plugin="$(dirname "$here")"
sdk="$(cd "$plugin/../../.." && pwd)"
server="${1:?kition or kition-kits-mcp}"; repos="${2:?folder of kit repositories}"; fixture="${3:?a .md file}"
server="$(cd "$(dirname "$server")" && pwd)/$(basename "$server")"; repos="$(cd "$repos" && pwd)"
node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 24 || (major === 24 && minor < 9)) { console.error(`DeepSeek Harness needs Node.js 24.9 or later, not ${process.versions.node}`); process.exit(1) }'
target="$(node -p "require('$plugin/package.json').dsh.target")"
cache="${DSH_KITS_CACHE:-${TMPDIR:-/tmp}/dsh-kits-e2e}"
mkdir -p "$cache"
if [[ ! -x "$cache/node_modules/.bin/dsh" ]] || [[ "$(node -p "require('$cache/node_modules/@deepseek-ai/dsh/package.json').version")" != "$target" ]]; then
  (cd "$cache" && { [[ -f package.json ]] || npm init -y >/dev/null; } && npm install --no-audit --no-fund --silent "@deepseek-ai/dsh@$target")
fi
dsh="$cache/node_modules/.bin/dsh"
work="$(mktemp -d)"; trap 'kill "${model:-0}" 2>/dev/null || true; rm -rf "$work"' EXIT
mkdir -p "$work/home" "$work/workspace/notes" "$work/kition"
cp "$fixture" "$work/workspace/notes/Plan.md"
export DSH_HOME="$work/home"
"$dsh" plugin --profile headless add "$plugin" >/dev/null
port="${SCRIPTED_PORT:-18787}"
DRAFTS_COMMAND="node '$plugin/bin/kits-mcp.mjs' drafts list --workspace \"\$PWD\"" \
  node "$here/scripted-model.mjs" "$port" "$work/requests.jsonl" & model=$!
disown "$model"
sleep 1
# The server: this kition with the built kits, in a Kition home of its own that installs nothing.
status=0
(cd "$work/workspace" && SCRIPTED_PORT="$port" SCRIPTED_API_KEY=scripted KITION_KITS_MCP="$server" \
  KITION_KIT_REPOS="$repos" KITION_HOME="$work/kition" KITION_INDEX="$work/kition/no-index.json" \
  "$dsh" --profile headless --patch "$here/scripted-route.cordis.patch.yml" "Inspect notes/Plan.md with the Kition tools.") \
  > "$work/stdout" || status=$?
echo "dsh exit $status"
cat "$work/stdout"
node "$here/check.mjs" "$DSH_HOME" "$work/requests.jsonl" "$work/stdout" "$sdk/published-kits.json"
