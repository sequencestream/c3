# c3 installer for Windows — install or update to the latest release.
#
#   irm https://raw.githubusercontent.com/sequencestream/c3/main/install.ps1 | iex
#
# Environment overrides:
#   $env:C3_VERSION       pin a specific version (e.g. v0.4.0); defaults to latest
#   $env:C3_INSTALL_DIR   install directory; defaults to %LOCALAPPDATA%\c3\bin

$ErrorActionPreference = 'Stop'

$Repo = 'sequencestream/c3'
$InstallDir = if ($env:C3_INSTALL_DIR) { $env:C3_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'c3\bin' }

function Info($m) { Write-Host "==> $m" -ForegroundColor Blue }
function Warn($m) { Write-Host "warning: $m" -ForegroundColor Yellow }

# --- detect platform ------------------------------------------------------
$arch = $env:PROCESSOR_ARCHITECTURE
if ($arch -ne 'AMD64') {
  throw "unsupported arch: $arch (only windows-x64 builds are published)"
}
$platform = 'windows-x64'

# --- resolve version ------------------------------------------------------
$version = $env:C3_VERSION
if (-not $version) {
  Info 'Resolving latest version...'
  # 跟随 releases/latest 的重定向，从最终 URL 里取出版本 tag（不调用有速率限制的 GitHub API）
  try {
    $resp = Invoke-WebRequest -Uri "https://github.com/$Repo/releases/latest" `
      -MaximumRedirection 0 -UseBasicParsing -ErrorAction SilentlyContinue
    $location = $resp.Headers.Location
  } catch {
    $location = $_.Exception.Response.Headers.Location.ToString()
  }
  if ($location -match '/tag/(.+)$') { $version = $Matches[1] }
  if (-not $version) { throw 'could not determine latest version' }
}
Info "Installing c3 $version ($platform)"

# --- download & verify ----------------------------------------------------
$asset = "c3-$version-$platform.zip"
$base  = "https://github.com/$Repo/releases/download/$version"
$tmp   = Join-Path ([System.IO.Path]::GetTempPath()) ("c3-" + [System.Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null

try {
  $zip = Join-Path $tmp $asset
  Info "Downloading $asset"
  Invoke-WebRequest -Uri "$base/$asset" -OutFile $zip -UseBasicParsing

  try {
    $sumFile = Join-Path $tmp "$asset.sha256"
    Invoke-WebRequest -Uri "$base/$asset.sha256" -OutFile $sumFile -UseBasicParsing
    $expected = ((Get-Content $sumFile -Raw).Trim() -split '\s+')[0]
    $actual = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
    if ($expected.ToLower() -ne $actual) { throw "checksum mismatch for $asset" }
    Info 'Checksum verified'
  } catch {
    if ($_.Exception.Message -like '*checksum mismatch*') { throw }
    Warn 'checksum file not found; skipping verification'
  }

  # --- install ------------------------------------------------------------
  Info 'Extracting'
  Expand-Archive -Path $zip -DestinationPath $tmp -Force
  $exe = Join-Path $tmp 'c3.exe'
  if (-not (Test-Path $exe)) { throw 'c3.exe not found in archive' }

  New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
  Copy-Item $exe (Join-Path $InstallDir 'c3.exe') -Force
  Info "Installed c3 to $InstallDir\c3.exe"

  # --- PATH ---------------------------------------------------------------
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if (($userPath -split ';') -notcontains $InstallDir) {
    [Environment]::SetEnvironmentVariable('Path', "$userPath;$InstallDir", 'User')
    $env:Path = "$env:Path;$InstallDir"
    Info "Added $InstallDir to your user PATH (restart your terminal to pick it up)"
  }
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}

Write-Host "`u{2713} c3 $version is ready. Run: c3 --port 9000" -ForegroundColor Green
