#!/bin/sh
# Installs `kition`, the Kition command line, on macOS or Linux: the archive of this machine's
# platform from a Kition SDK release on GitHub, checked against the release's SHA256SUMS, as
# ~/.kition/bin/kition. Kits are not installed here: `kition` downloads each one when it is first
# needed, or with `kition kit install <kit>`.
#
#   curl -fsSL https://github.com/KitionAI/kition-sdk/releases/latest/download/install.sh | sh
#   curl -fsSL .../install.sh | sh -s -- 0.3.0       # a given SDK version instead of the latest
#
# Environment:
#   KITION_HOME          the Kition home (default ~/.kition); kition goes to $KITION_HOME/bin
#   KITION_VERSION       the SDK version to install, as the argument does (default: the latest)
#   KITION_RELEASES_URL  where the releases are (default
#                        https://github.com/KitionAI/kition-sdk/releases): <url>/latest/download/
#                        and <url>/download/sdk-v<version>/ hold the assets (a mirror, or a test)
#
# It never uses sudo and never edits a shell profile: it says how to put kition on the PATH.
# See docs/sdk/cli.md in https://github.com/KitionAI/kition-sdk.
set -eu

releases="${KITION_RELEASES_URL:-https://github.com/KitionAI/kition-sdk/releases}"
releases="${releases%/}"
version="${1:-${KITION_VERSION:-}}"
version="${version#v}"
# HTTPS only, redirects included, unless the releases are named at an http:// address (a test).
case "$releases" in
  http://*) protocols='=https,http' ;;
  *) protocols='=https' ;;
esac
home="${KITION_HOME:-${HOME:?HOME is not set; set KITION_HOME}/.kition}"

say() { printf 'kition install: %s\n' "$*" >&2; }
fail() {
  say "$*"
  exit 1
}

# The platform of this machine, as the SDK release names it.
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
        fail "this Linux uses the musl C library (Alpine, for example); kition is built for glibc only. Use a glibc distribution (Debian, Ubuntu, Fedora, ...) or a glibc container image, or build kition from source: cargo build --release -p kition-cli in https://github.com/KitionAI/kition-sdk."
      fi
      ;;
    MINGW* | MSYS* | CYGWIN* | Windows_NT)
      fail "on Windows, run install.ps1 in PowerShell: irm https://github.com/KitionAI/kition-sdk/releases/latest/download/install.ps1 | iex"
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

# download <url> <file>
download() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --proto "$protocols" --retry 2 -o "$2" "$1" || fail "could not download $1"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$2" "$1" || fail "could not download $1"
  else
    fail "neither curl nor wget is installed; install one of them"
  fi
}

# sha256 <file>: its SHA-256 in hex.
sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d ' ' -f 1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d ' ' -f 1
  else
    fail "neither sha256sum nor shasum is installed; cannot check the download"
  fi
}

target=$(platform) || exit 1
mkdir -p "$home/tmp" || fail "cannot create $home/tmp"
work=$(mktemp -d "$home/tmp/install.XXXXXX") || fail "cannot create a folder in $home/tmp"
trap 'rm -rf "$work"' EXIT
trap 'exit 130' INT TERM

if [ -n "$version" ]; then
  base="$releases/download/sdk-v$version"
else
  base="$releases/latest/download"
fi
download "$base/SHA256SUMS" "$work/SHA256SUMS"
# The archive's line names the version too: kition-<version>-<platform>.tar.gz.
line=$(grep -E "^[0-9a-f]{64}  kition-[0-9][0-9A-Za-z.+-]*-$target\.tar\.gz\$" "$work/SHA256SUMS" | head -n 1 || true)
[ -n "$line" ] || fail "the release at $base has no kition for $target (its SHA256SUMS lists none)"
expected=${line%% *}
archive=${line#*  }
found=${archive#kition-}
found=${found%-"$target".tar.gz}
if [ -n "$version" ] && [ "$found" != "$version" ]; then
  fail "the release at $base offers kition $found, not $version"
fi
version=$found
# Download from the release of that version, so a release published meanwhile cannot mix in.
download "$releases/download/sdk-v$version/$archive" "$work/$archive"
actual=$(sha256 "$work/$archive")
[ "$actual" = "$expected" ] || fail "$archive has SHA-256 $actual; the release's SHA256SUMS says $expected. Nothing was installed."

mkdir -p "$work/unpacked"
tar -xzf "$work/$archive" -C "$work/unpacked" || fail "cannot unpack $archive"
[ -f "$work/unpacked/kition" ] || fail "$archive holds no kition"
chmod 755 "$work/unpacked/kition"
ran=$("$work/unpacked/kition" --version 2>&1) || fail "the kition in $archive does not run on this machine ($target): $ran"

mkdir -p "$home/bin" || fail "cannot create $home/bin"
# Moved into place with one rename, so a kition running now keeps its file.
mv -f "$work/unpacked/kition" "$home/bin/kition" || fail "cannot write $home/bin/kition"
say "installed $("$home/bin/kition" --version) as $home/bin/kition"

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
