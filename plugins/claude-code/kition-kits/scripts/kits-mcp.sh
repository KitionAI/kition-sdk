#!/bin/sh
# Starts kition-kits-mcp for the kition-kits Claude Code plugin: the MCP server (arguments
# `--workspace <folder>`) or the person's draft review (`drafts <command> ...`). The plugin's
# options arrive as environment variables (see ../.claude-plugin/plugin.json):
#
#   KITION_KITS_MCP      the kition-kits-mcp executable; default: the one on the PATH, else
#                        `npx -y @kition/kits-mcp`, the npm launcher, which brings the server and
#                        the published kits for this platform (and passes their --kits-dir itself
#                        when no kits are given here)
#   KITION_KITS_DIR      a folder with one folder per installed kit (kit.json beside its executable)
#   KITION_KIT_REPOS     a folder of kit repository checkouts, kition-<kit>/, whose debug builds
#                        (target/debug/kition-<kit>) are served with the kit.json above them
#   KITION_KITS_UNIFIED  "true": one tool set for every kit (kit_<action>); otherwise <prefix>_<action>
#
# An option left unset can reach here as an empty string or as its unexpanded `${user_config.*}`
# reference; both mean unset.
set -eu

unset_option() {
  case "$1" in
    "" | *'${'*) return 0 ;;
    *) return 1 ;;
  esac
}

serving=true
[ "${1:-}" = "drafts" ] && serving=false

mcp="${KITION_KITS_MCP:-}"
if unset_option "$mcp"; then
  # The npm launcher (on the PATH from `npm install -g @kition/kits-mcp`, or through npx) reads
  # KITION_KITS_MCP too: an unset option must not reach it as a path.
  unset KITION_KITS_MCP
  mcp=$(command -v kition-kits-mcp 2>/dev/null || true)
  if [ -z "$mcp" ] && command -v npx >/dev/null 2>&1; then
    mcp=npx
    set -- -y @kition/kits-mcp "$@"
  fi
fi
if [ -z "$mcp" ]; then
  echo "kition-kits: no kition-kits-mcp executable and no npx. Set the plugin's \"kition-kits-mcp\" option (/plugin, or /config), put kition-kits-mcp on the PATH, or install Node.js for npx -y @kition/kits-mcp." >&2
  exit 1
fi
if [ "$mcp" != npx ] && [ ! -x "$mcp" ]; then
  echo "kition-kits: $mcp is not an executable. Set the plugin's \"kition-kits-mcp\" option (/plugin, or /config) to kition-kits-mcp." >&2
  exit 1
fi

dir="${KITION_KITS_DIR:-}"
if ! unset_option "$dir"; then
  set -- "$@" --kits-dir "$dir"
fi

repos="${KITION_KIT_REPOS:-}"
if ! unset_option "$repos"; then
  for repo in "$repos"/kition-*; do
    kit=${repo##*/kition-}
    executable="$repo/target/debug/kition-$kit"
    if [ -x "$executable" ]; then
      set -- "$@" --kit "$executable"
    fi
  done
fi

if $serving && [ "${KITION_KITS_UNIFIED:-true}" = "true" ]; then
  set -- "$@" --unified
fi

exec "$mcp" "$@"
