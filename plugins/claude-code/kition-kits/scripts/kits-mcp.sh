#!/bin/sh
# Starts the kits' MCP server for the kition-kits Claude Code plugin: the server (arguments
# `--workspace <folder>`) or the person's draft review (`drafts <command> ...`). The plugin's
# options arrive as environment variables (see ../.claude-plugin/plugin.json):
#
#   KITION_KITS_MCP      the server executable: `kition` (started as `kition mcp`) or a
#                        kition-kits-mcp; default: `kition` on the PATH (as install.sh puts it in
#                        ~/.kition/bin, or `npm install -g kition`), else kition-kits-mcp on the
#                        PATH, else `npx -y kition mcp`, the npm package, which brings kition for
#                        this platform. kition installs each kit in ~/.kition/kits on first use when no
#                        kits are given here
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
  # An unset option must not reach the server's environment as a path.
  unset KITION_KITS_MCP
  mcp=$(command -v kition 2>/dev/null || command -v kition-kits-mcp 2>/dev/null || true)
  if [ -z "$mcp" ] && command -v npx >/dev/null 2>&1; then
    mcp=npx
    set -- -y kition mcp "$@"
  fi
fi
if [ -z "$mcp" ]; then
  echo "kition-kits: no kition, no kition-kits-mcp and no npx. Install kition (curl -fsSL https://github.com/KitionAI/kition-sdk/releases/latest/download/install.sh | sh) and put ~/.kition/bin on the PATH, set the plugin's \"kition-kits-mcp\" option (/plugin, or /config), or install Node.js for npx -y kition." >&2
  exit 1
fi
if [ "$mcp" != npx ] && [ ! -x "$mcp" ]; then
  echo "kition-kits: $mcp is not an executable. Set the plugin's \"kition-kits-mcp\" option (/plugin, or /config) to kition or kition-kits-mcp." >&2
  exit 1
fi
# kition serves the kits as `kition mcp`, with kition-kits-mcp's arguments.
case "$mcp" in
  kition | */kition) set -- mcp "$@" ;;
esac

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
