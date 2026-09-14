$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$url = 'http://127.0.0.1:5173/'

function Test-AppUrl {
  try {
    $response = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 2
    return $response.StatusCode -ge 200 -and $response.StatusCode -lt 500
  } catch {
    return $false
  }
}

function Open-App {
  try {
    Start-Process $url -ErrorAction Stop | Out-Null
    Write-Host 'Browser opened automatically.' -ForegroundColor DarkGray
  } catch {
    Write-Host "Open this URL in your browser: $url" -ForegroundColor Yellow
  }
}

Set-Location $projectRoot

$nodePath = $null
$nodeCommand = Get-Command 'node.exe' -ErrorAction SilentlyContinue
if ($nodeCommand) {
  $nodePath = $nodeCommand.Source
}

$nodeCandidates = @(
  (Join-Path ${env:ProgramFiles} 'nodejs\node.exe'),
  (Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe'),
  (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe'),
  (Join-Path $env:LOCALAPPDATA 'Volta\bin\node.exe'),
  (Join-Path $env:APPDATA 'nvm\current\node.exe'),
  (Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe')
)
foreach ($candidate in $nodeCandidates) {
  if (-not $nodePath -and $candidate -and (Test-Path $candidate)) {
    $nodePath = $candidate
  }
}

if (-not $nodePath) {
  throw 'Node.js was not found. Install Node.js 20 or newer, then run this launcher again.'
}
$nodeDirectory = Split-Path -Parent $nodePath
if (-not (($env:Path -split ';') -contains $nodeDirectory)) {
  $env:Path = "$nodeDirectory;$env:Path"
}

$vitePath = Join-Path $projectRoot 'node_modules\.bin\vite.cmd'
if (-not (Test-Path $vitePath)) {
  $packageManager = $null
  if (Get-Command 'pnpm.cmd' -ErrorAction SilentlyContinue) {
    $packageManager = 'pnpm.cmd'
  } elseif (Get-Command 'npm.cmd' -ErrorAction SilentlyContinue) {
    $packageManager = 'npm.cmd'
  }
  if (-not $packageManager) {
    throw 'Neither pnpm nor npm was found. Install Node.js, then run this launcher again.'
  }
  Write-Host 'Dependencies are missing. Installing them now...' -ForegroundColor Yellow
  if ($packageManager -eq 'pnpm.cmd') {
    & $packageManager install --frozen-lockfile
  } else {
    & $packageManager install --no-package-lock
  }
  if ($LASTEXITCODE -ne 0) {
    throw 'Dependency installation failed. Check the network connection and the error above.'
  }
  if (-not (Test-Path $vitePath)) {
    throw 'Vite was not installed successfully. Check the package manager output above.'
  }
}

if (Test-AppUrl) {
  Write-Host "A local app is already running. Opening $url" -ForegroundColor Green
  Open-App
  exit 0
}

Write-Host 'Starting Sea Trial Logger...' -ForegroundColor Cyan
$server = Start-Process -FilePath $vitePath -ArgumentList @('--host', '127.0.0.1', '--port', '5173') -WorkingDirectory $projectRoot -NoNewWindow -PassThru

$ready = $false
$deadline = (Get-Date).AddSeconds(30)
while ((Get-Date) -lt $deadline) {
  if ($server.HasExited) {
    break
  }
  if (Test-AppUrl) {
    $ready = $true
    break
  }
  Start-Sleep -Milliseconds 300
}

if (-not $ready) {
  if ($server.HasExited) {
    throw "The local app failed to start (exit code: $($server.ExitCode))."
  }
  throw 'Timed out while waiting for the local app. Check the Vite output above.'
}

Write-Host "App is ready: $url" -ForegroundColor Green
Write-Host 'Close this window to stop the local server.' -ForegroundColor DarkGray
Open-App
Wait-Process -Id $server.Id
