#!/bin/sh
set -eu
umask 077
# The caller mounts this private directory as tmpfs, outside the workspace.
if [ ! -d "$TMPDIR" ] || [ ! -w "$TMPDIR" ]; then
    echo 'kition: mount a writable private tmpfs at /run/kition (see tools/container/README.md in kition-sdk)' >&2
    exit 1
fi
# `drafts` must be the binary's first argument. All diagnostics stay on stderr;
# exec preserves MCP stdin/stdout and delivers container signals to the server.
if [ "${1-}" = drafts ]; then
    shift
    exec /usr/local/bin/kition-kits-mcp drafts --workspace /workspace --kits-dir /opt/kition/kits "$@"
fi
exec /usr/local/bin/kition-kits-mcp --workspace /workspace --kits-dir /opt/kition/kits "$@"
