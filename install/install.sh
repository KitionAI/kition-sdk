#!/bin/sh
# Installs `kition`, the Kition command line, on macOS or Linux, from npm without Node.js: the
# package @kition/cli-<platform> (the executable that `npm install -g @kition/cli` brings), from the
# first npm registry that serves it, checked against the integrity (SHA-512) the registry's
# metadata gives, as ~/.kition/bin/kition. Kits are not installed here: `kition` downloads each one
# when it is first needed, or with `kition kit install <kit>`.
#
#   curl -fsSL https://unpkg.com/@kition/cli/dist/install.sh | sh
#   curl -fsSL https://unpkg.com/@kition/cli/dist/install.sh | sh -s -- 0.6.0     # a given version
# It rides in the npm package @kition/cli (dist/install.sh), so any registry or mirror serves it:
#   curl -fsSL https://registry.npmmirror.com/@kition/cli/-/cli-0.6.0.tgz | tar -xzO package/dist/install.sh | sh
#
# The registries, in order (as kition itself reads them, docs/sdk/cli.md):
#   KITION_NPM_REGISTRY  one address, or several separated by commas
#   npm's own setting    `@kition:registry` (the scope's), else `npm_config_registry`, else `registry`, in the
#                        .npmrc that npm_config_userconfig names or ~/.npmrc (read; npm is not needed)
#   https://registry.npmjs.org/, then https://registry.npmmirror.com/
# A registry that does not answer within 5 seconds, lacks the version, or serves other bytes than
# its metadata says passes to the next. Proxies: curl's (https_proxy, ...).
#
# Environment:
#   KITION_HOME          the Kition home (default ~/.kition); kition goes to $KITION_HOME/bin
#   KITION_VERSION       the version to install, as the argument does (default: the latest)
#
# It never uses sudo and never edits a shell profile: it says how to put kition on the PATH.
# See docs/sdk/cli.md in https://github.com/KitionAI/kition-sdk.
set -eu

# The npm scope of the packages it installs: <scope>/cli-<platform>. The one place it is named; a
# rehearsal's launcher (<scope>/cli, made by kition-sdk's tools/stage-package.mjs) carries a copy
# naming its own scope here.
scope='@kition'

version="${1:-${KITION_VERSION:-}}"
version="${version#v}"
home="${KITION_HOME:-${HOME:?HOME is not set; set KITION_HOME}/.kition}"

say() { printf 'kition install: %s\n' "$*" >&2; }
fail() {
  say "$*"
  exit 1
}

# The platform of this machine, as @kition/cli names its packages.
platform() {
  os=$(uname -s)
  arch=$(uname -m)
  case "$os" in
    Darwin)
      os=darwin
      # A shell running under Rosetta says x86_64 on Apple silicon: take the native build.
      if [ "$arch" = x86_64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || true)" = 1 ]; then
        arch=arm64
      fi
      ;;
    Linux)
      os=linux
      if [ -n "$(ls /lib/ld-musl-* /usr/lib/ld-musl-* 2>/dev/null || true)" ] || ldd --version 2>&1 | grep -qi musl; then
        fail "this Linux uses the musl C library (Alpine, for example); kition is built for glibc 2.17 or later only. Use a glibc distribution (Debian, Ubuntu, Fedora, ...) or a glibc container image, or build kition from source: cargo build --release -p kition-cli in https://github.com/KitionAI/kition-sdk."
      fi
      ;;
    MINGW* | MSYS* | CYGWIN* | Windows_NT)
      fail "on Windows, run install.ps1 in PowerShell instead (docs/sdk/cli.md)"
      ;;
    *) fail "kition is built for macOS, Linux (glibc) and Windows; not for $os." ;;
  esac
  case "$arch" in
    arm64 | aarch64) arch=arm64 ;;
    x86_64 | amd64) arch=x64 ;;
    *) fail "kition is built for arm64 and x64; not for $arch ($os)." ;;
  esac
  echo "$os-$arch"
}

# fetch <url> <file>: downloads, quietly; fails (status 1) without a word.
fetch() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --connect-timeout 5 --retry 1 -o "$2" "$1" 2>/dev/null
  elif command -v wget >/dev/null 2>&1; then
    wget -q -T 30 -O "$2" "$1"
  else
    fail "neither curl nor wget is installed; install one of them"
  fi
}

# integrity <file>: npm's integrity of it, sha512-<base64>.
integrity() {
  if command -v openssl >/dev/null 2>&1; then
    printf 'sha512-%s' "$(openssl dgst -sha512 -binary "$1" | openssl base64 -A)"
  elif command -v xxd >/dev/null 2>&1 && command -v base64 >/dev/null 2>&1; then
    if command -v sha512sum >/dev/null 2>&1; then hex=$(sha512sum "$1" | cut -d ' ' -f 1); else hex=$(shasum -a 512 "$1" | cut -d ' ' -f 1); fi
    printf 'sha512-%s' "$(printf '%s' "$hex" | xxd -r -p | base64 | tr -d '\n')"
  else
    fail "neither openssl nor xxd and base64 are installed; cannot check the download"
  fi
}

# setting <key> <file>: the value of `key=value` in an .npmrc, quotes taken off; empty without one.
setting() {
  [ -f "$2" ] || return 0
  sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" "$2" | head -n 1 | sed "s/^[\"']//; s/[\"'][[:space:]]*\$//; s/[[:space:]]*\$//"
}

# The registries, in order, each once and ending with /.
registries() {
  npmrc="${npm_config_userconfig:-${NPM_CONFIG_USERCONFIG:-$HOME/.npmrc}}"
  general="${npm_config_registry:-${NPM_CONFIG_REGISTRY:-$(setting registry "$npmrc")}}"
  printf '%s\n' "$(printf '%s' "${KITION_NPM_REGISTRY:-}" | tr ',' '\n')" "$(setting "$scope:registry" "$npmrc")" "$general" https://registry.npmjs.org/ https://registry.npmmirror.com/ |
    sed 's/^[[:space:]]*//; s/[[:space:]]*$//' | grep -E '^https?://' | sed 's#/*$#/#' | awk '!seen[$0]++'
}

target=$(platform) || exit 1
package="$scope/cli-$target"
mkdir -p "$home/tmp" || fail "cannot create $home/tmp"
work=$(mktemp -d "$home/tmp/install.XXXXXX") || fail "cannot create a folder in $home/tmp"
trap 'rm -rf "$work"' EXIT
trap 'exit 130' INT TERM

tried=""
installed_from=""
for registry in $(registries); do
  # The version's metadata: its version and npm's integrity of its tarball.
  if ! fetch "$registry$scope%2fcli-$target/${version:-latest}" "$work/metadata.json"; then
    tried="$tried; $registry: no $package@${version:-latest} there, or no answer"
    continue
  fi
  found=$(tr -d '\n' < "$work/metadata.json" | sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
  expected=$(tr -d '\n' < "$work/metadata.json" | sed -n 's/.*"integrity"[[:space:]]*:[[:space:]]*"\(sha512-[A-Za-z0-9+/=]*\)".*/\1/p' | head -n 1)
  if [ -z "$found" ] || [ -z "$expected" ]; then
    tried="$tried; $registry: its metadata of $package names no version and sha512 integrity"
    continue
  fi
  if [ -n "$version" ] && [ "$found" != "$version" ]; then
    tried="$tried; $registry: it offers $package $found, not $version"
    continue
  fi
  tarball="$registry$scope/cli-$target/-/cli-$target-$found.tgz"
  if ! fetch "$tarball" "$work/package.tgz"; then
    tried="$tried; $registry: $tarball cannot be downloaded"
    continue
  fi
  actual=$(integrity "$work/package.tgz")
  if [ "$actual" != "$expected" ]; then
    tried="$tried; $registry: $package $found has the integrity $actual, and its metadata gives $expected: refused"
    continue
  fi
  installed_from="$registry"
  break
done
[ -n "$installed_from" ] || fail "kition was not installed: no registry served $package${version:+ $version} with the integrity it gives (tried${tried#;}). Name a registry that answers with KITION_NPM_REGISTRY (such as https://registry.npmmirror.com/)."

mkdir -p "$work/unpacked"
tar -xzf "$work/package.tgz" -C "$work/unpacked" || fail "cannot unpack $package $found"
[ -f "$work/unpacked/package/bin/kition" ] || fail "$package $found holds no bin/kition"
chmod 755 "$work/unpacked/package/bin/kition"
ran=$("$work/unpacked/package/bin/kition" --version 2>&1) || fail "the kition of $package $found does not run on this machine ($target): $ran"

mkdir -p "$home/bin" || fail "cannot create $home/bin"
# Moved into place with one rename, so a kition running now keeps its file.
mv -f "$work/unpacked/package/bin/kition" "$home/bin/kition" || fail "cannot write $home/bin/kition"
say "installed $("$home/bin/kition" --version) as $home/bin/kition (from $installed_from)"

case ":${PATH:-}:" in
  *":$home/bin:"*) ;;
  *)
    say "$home/bin is not on your PATH. To use kition from any shell, add this line to your shell's profile (~/.zshrc, ~/.bashrc, ~/.profile, ...):"
    printf '\n  export PATH="%s/bin:$PATH"\n\n' "$home" >&2
    say "for fish: fish_add_path $home/bin"
    say "or run it as $home/bin/kition"
    ;;
esac
say "next: kition kit list; connect an agent with: kition mcp --workspace <folder> (docs/sdk/cli.md)"
