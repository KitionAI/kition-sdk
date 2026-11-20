# Installs `kition`, the Kition command line, on Windows, from npm without Node.js: the package
# @kition/cli-win32-x64 (the executable that `npm install -g @kition/cli` brings), from the first npm
# registry that serves it, checked against the integrity (SHA-512) the registry's metadata gives, as
# %USERPROFILE%\.kition\bin\kition.exe. Kits are not installed here: `kition` downloads each one when
# it is first needed, or with `kition kit install <kit>`.
#
#   irm https://unpkg.com/@kition/cli/dist/install.ps1 | iex
#   & ([scriptblock]::Create((irm https://unpkg.com/@kition/cli/dist/install.ps1))) 0.6.0     # a given version
#
# The registries, in order (as kition itself reads them, docs/sdk/cli.md):
#   KITION_NPM_REGISTRY  one address, or several separated by commas
#   npm's own setting    `@kition:registry`, else `npm_config_registry`, else `registry`, in the
#                        .npmrc that npm_config_userconfig names or %USERPROFILE%\.npmrc (read; npm is not needed)
#   https://registry.npmjs.org/, then https://registry.npmmirror.com/
# A registry that does not answer, lacks the version, or serves other bytes than its metadata says
# passes to the next. Proxies: the system's (Internet Options), as PowerShell's.
#
# Environment:
#   KITION_HOME          the Kition home (default %USERPROFILE%\.kition); kition.exe goes to its bin\
#   KITION_VERSION       the version to install, as the argument does (default: the latest)
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

$Version = if ($Version) { $Version.TrimStart('v') } else { '' }
$kitionHome = if ($env:KITION_HOME) { $env:KITION_HOME } else { Join-Path $env:USERPROFILE '.kition' }

# The platform, as @kition/cli names its packages. Windows on Arm runs the x64 build (Windows 11 emulates x64).
$arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture
switch ($arch) {
  'X64' { $target = 'win32-x64' }
  'Arm64' { $target = 'win32-x64'; Say 'Windows on Arm: installing the x64 build, which Windows 11 runs by emulation.' }
  default { Fail "kition is built for x64 Windows; not for $arch." }
}
if (-not (Get-Command tar.exe -ErrorAction SilentlyContinue)) { Fail 'tar.exe is missing (Windows 10 1803 or later has it).' }
$package = "@kition/cli-$target"

# setting <key> <file>: the value of `key=value` in an .npmrc, quotes taken off, ${VAR} expanded; '' without one.
function Setting([string]$Key, [string]$File) {
  if (-not (Test-Path $File -PathType Leaf)) { return '' }
  foreach ($line in Get-Content $File) {
    $text = $line.Trim()
    if (-not $text -or $text.StartsWith('#') -or $text.StartsWith(';')) { continue }
    $at = $text.IndexOf('=')
    if ($at -lt 1 -or $text.Substring(0, $at).Trim() -ne $Key) { continue }
    $value = $text.Substring($at + 1).Trim().Trim('"').Trim("'")
    return [regex]::Replace($value, '\$\{([^}]+)\}', { param($m) [Environment]::GetEnvironmentVariable($m.Groups[1].Value) })
  }
  return ''
}

# The registries, in order, each once and ending with /.
$npmrc = if ($env:npm_config_userconfig) { $env:npm_config_userconfig } else { Join-Path $env:USERPROFILE '.npmrc' }
$general = if ($env:npm_config_registry) { $env:npm_config_registry } else { Setting 'registry' $npmrc }
$registries = New-Object System.Collections.Generic.List[string]
foreach ($candidate in @((("$env:KITION_NPM_REGISTRY") -split ',') + @((Setting '@kition:registry' $npmrc), $general, 'https://registry.npmjs.org/', 'https://registry.npmmirror.com/'))) {
  $address = "$candidate".Trim()
  if ($address -notmatch '^https?://') { continue }
  $address = $address.TrimEnd('/') + '/'
  if (-not $registries.Contains($address)) { $registries.Add($address) }
}

[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$tmp = Join-Path $kitionHome 'tmp'
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$work = Join-Path $tmp ("install." + [Guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $work | Out-Null
try {
  $tried = @()
  $from = $null
  $file = Join-Path $work 'package.tgz'
  $wanted = if ($Version) { $Version } else { 'latest' }
  foreach ($registry in $registries) {
    # The version's metadata: its version and npm's integrity of its tarball.
    try {
      $metadata = Invoke-RestMethod -Uri "$registry@kition%2fcli-$target/$wanted" -UseBasicParsing -TimeoutSec 30
    } catch {
      $tried += "${registry}: no $package@$wanted there, or no answer ($($_.Exception.Message))"
      continue
    }
    $found = "$($metadata.version)"
    $expected = "$($metadata.dist.integrity)"
    if (-not $found -or $expected -notmatch '^sha512-[A-Za-z0-9+/]+={0,2}$') {
      $tried += "${registry}: its metadata of $package names no version and sha512 integrity"
      continue
    }
    if ($Version -and $found -ne $Version) {
      $tried += "${registry}: it offers $package $found, not $Version"
      continue
    }
    $tarball = "$registry@kition/cli-$target/-/cli-$target-$found.tgz"
    try {
      Invoke-WebRequest -Uri $tarball -OutFile $file -UseBasicParsing -TimeoutSec 600
    } catch {
      $tried += "${registry}: $tarball cannot be downloaded ($($_.Exception.Message))"
      continue
    }
    $sha512 = [System.Security.Cryptography.SHA512]::Create()
    $stream = [System.IO.File]::OpenRead($file)
    try { $actual = 'sha512-' + [Convert]::ToBase64String($sha512.ComputeHash($stream)) } finally { $stream.Dispose(); $sha512.Dispose() }
    if ($actual -cne $expected) {
      $tried += "${registry}: $package $found has the integrity $actual, and its metadata gives ${expected}: refused"
      continue
    }
    $from = $registry
    break
  }
  if (-not $from) {
    $what = if ($Version) { "$package $Version" } else { $package }
    Fail "kition was not installed: no registry served $what with the integrity it gives (tried $($tried -join '; ')). Name a registry that answers with KITION_NPM_REGISTRY (such as https://registry.npmmirror.com/)."
  }
  $archive = "$package $found"

  $unpacked = Join-Path $work 'unpacked'
  New-Item -ItemType Directory -Path $unpacked | Out-Null
  & tar.exe -xzf $file -C $unpacked
  if ($LASTEXITCODE -ne 0) { Fail "cannot unpack $archive" }
  $exe = Join-Path $unpacked 'package\bin\kition.exe'
  if (-not (Test-Path $exe -PathType Leaf)) { Fail "$archive holds no bin\kition.exe" }
  $ran = & $exe --version 2>&1
  if ($LASTEXITCODE -ne 0) { Fail "the kition.exe in $archive does not run on this machine: $ran" }

  $bin = Join-Path $kitionHome 'bin'
  New-Item -ItemType Directory -Force -Path $bin | Out-Null
  $installed = Join-Path $bin 'kition.exe'
  try { Move-Item -Force -Path $exe -Destination $installed } catch { Fail "cannot write ${installed} (is kition running? close it and try again): $($_.Exception.Message)" }
  Say "installed $(& $installed --version) as $installed (from $from)"

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
