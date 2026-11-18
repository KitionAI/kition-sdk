# Installs `kition`, the Kition command line, on Windows: the win32-x64 archive from a Kition SDK
# release on GitHub, checked against the release's SHA256SUMS, as %USERPROFILE%\.kition\bin\kition.exe.
# Kits are not installed here: `kition` downloads each one when it is first needed, or with
# `kition kit install <kit>`.
#
#   irm https://github.com/KitionAI/kition-sdk/releases/latest/download/install.ps1 | iex
#   & ([scriptblock]::Create((irm .../install.ps1))) 0.3.0     # a given SDK version
#
# Environment:
#   KITION_HOME          the Kition home (default %USERPROFILE%\.kition); kition.exe goes to its bin\
#   KITION_VERSION       the SDK version to install, as the argument does (default: the latest)
#   KITION_RELEASES_URL  where the releases are (default
#                        https://github.com/KitionAI/kition-sdk/releases): <url>/latest/download/
#                        and <url>/download/sdk-v<version>/ hold the assets (a mirror, or a test)
#
# It needs no administrator rights and never changes the PATH: it says how to put kition on it.
# Windows 10 1803 or later (for tar.exe). See docs/sdk/cli.md in https://github.com/KitionAI/kition-sdk.
param([string]$Version = $env:KITION_VERSION)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# throw, not exit: run through `irm | iex`, exit would close the person's PowerShell window.
function Fail([string]$Message) {
  throw "kition install: $Message"
}
function Say([string]$Message) {
  [Console]::Error.WriteLine("kition install: $Message")
}

$releases = if ($env:KITION_RELEASES_URL) { $env:KITION_RELEASES_URL.TrimEnd('/') } else { 'https://github.com/KitionAI/kition-sdk/releases' }
$Version = if ($Version) { $Version.TrimStart('v') } else { '' }
$kitionHome = if ($env:KITION_HOME) { $env:KITION_HOME } else { Join-Path $env:USERPROFILE '.kition' }

# The platform, as the SDK release names it. Windows on Arm runs the x64 build (Windows 11 emulates x64).
$arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture
switch ($arch) {
  'X64' { $target = 'win32-x64' }
  'Arm64' { $target = 'win32-x64'; Say 'Windows on Arm: installing the x64 build, which Windows 11 runs by emulation.' }
  default { Fail "kition is built for x64 Windows; not for $arch." }
}
if (-not (Get-Command tar.exe -ErrorAction SilentlyContinue)) { Fail 'tar.exe is missing (Windows 10 1803 or later has it).' }

[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
function Download([string]$Url, [string]$File) {
  try { Invoke-WebRequest -Uri $Url -OutFile $File -UseBasicParsing } catch { Fail "could not download ${Url}: $($_.Exception.Message)" }
}

$tmp = Join-Path $kitionHome 'tmp'
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$work = Join-Path $tmp ("install." + [Guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $work | Out-Null
try {
  $base = if ($Version) { "$releases/download/sdk-v$Version" } else { "$releases/latest/download" }
  Download "$base/SHA256SUMS" (Join-Path $work 'SHA256SUMS')
  $pattern = "^([0-9a-f]{64})  (kition-([0-9][0-9A-Za-z.+-]*)-$([regex]::Escape($target))\.tar\.gz)$"
  $line = Get-Content (Join-Path $work 'SHA256SUMS') | Where-Object { $_ -match $pattern } | Select-Object -First 1
  if (-not $line) { Fail "the release at $base has no kition for $target (its SHA256SUMS lists none)" }
  $null = $line -match $pattern
  $expected = $Matches[1]; $archive = $Matches[2]; $found = $Matches[3]
  if ($Version -and $found -ne $Version) { Fail "the release at $base offers kition $found, not $Version" }
  $Version = $found
  # From the release of that version, so a release published meanwhile cannot mix in.
  $file = Join-Path $work $archive
  Download "$releases/download/sdk-v$Version/$archive" $file
  $actual = (Get-FileHash -Algorithm SHA256 -Path $file).Hash.ToLowerInvariant()
  if ($actual -ne $expected) { Fail "$archive has SHA-256 $actual; the release's SHA256SUMS says $expected. Nothing was installed." }

  $unpacked = Join-Path $work 'unpacked'
  New-Item -ItemType Directory -Path $unpacked | Out-Null
  & tar.exe -xzf $file -C $unpacked
  if ($LASTEXITCODE -ne 0) { Fail "cannot unpack $archive" }
  $exe = Join-Path $unpacked 'kition.exe'
  if (-not (Test-Path $exe -PathType Leaf)) { Fail "$archive holds no kition.exe" }
  $ran = & $exe --version 2>&1
  if ($LASTEXITCODE -ne 0) { Fail "the kition.exe in $archive does not run on this machine: $ran" }

  $bin = Join-Path $kitionHome 'bin'
  New-Item -ItemType Directory -Force -Path $bin | Out-Null
  $installed = Join-Path $bin 'kition.exe'
  try { Move-Item -Force -Path $exe -Destination $installed } catch { Fail "cannot write ${installed} (is kition running? close it and try again): $($_.Exception.Message)" }
  Say "installed $(& $installed --version) as $installed"

  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  $onPath = (($env:Path -split ';') + ($userPath -split ';')) | Where-Object { $_ -and ($_.TrimEnd('\') -ieq $bin.TrimEnd('\')) }
  if (-not $onPath) {
    Say "$bin is not on your PATH. To use kition from any new terminal, run:"
    [Console]::Error.WriteLine("")
    [Console]::Error.WriteLine("  [Environment]::SetEnvironmentVariable('Path', `"$bin;`" + [Environment]::GetEnvironmentVariable('Path', 'User'), 'User')")
    [Console]::Error.WriteLine("")
    Say "or run it as $installed"
  }
  Say 'next: kition kit list; connect an agent with: kition mcp --workspace <folder> (docs/sdk/cli.md)'
} finally {
  Remove-Item -Recurse -Force -Path $work -ErrorAction SilentlyContinue
}
