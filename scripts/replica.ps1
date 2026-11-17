[CmdletBinding(PositionalBinding = $false)]
param(
  [Parameter(Position = 0)]
  [ValidateSet('doctor','install','dev','start','sample','build','build-main','build-ui','test','e2e','typecheck','lint','format','unpack','package-win','i18n')]
  [string]$Action = 'doctor',
  [string]$CacheRoot = $env:SEMAPATH_DEV_CACHE,
  [switch]$UseBaselineNativeModules,
  [string]$BaselineResources = (Join-Path ([Environment]::GetFolderPath('DesktopDirectory')) 'SemaPath\应用\SemaPath-0.2.19\resources'),
  [Parameter(ValueFromRemainingArguments=$true)]
  [string[]]$RemainingArguments
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
if (-not $CacheRoot) {
  $CacheRoot = Join-Path ([Environment]::GetFolderPath('UserProfile')) 'Documents\ChatGPT\数据分析工具开发\SemaPath开发缓存'
}
$CacheRoot = [IO.Path]::GetFullPath($CacheRoot)
$nodeRoot = Join-Path $CacheRoot 'toolchains\node-v24.18.0'
$pnpmRoot = Join-Path $CacheRoot 'toolchains\pnpm-10.34.5'
$nodeExe = Join-Path $nodeRoot 'node.exe'
$pnpmEntry = Join-Path $pnpmRoot 'node_modules\pnpm\bin\pnpm.cjs'
if (-not (Test-Path -LiteralPath $nodeExe) -or -not (Test-Path -LiteralPath $pnpmEntry)) {
  throw 'Project toolchain missing. See docs/replica/development.md and set SEMAPATH_DEV_CACHE if needed.'
}
$env:PATH = $nodeRoot + ';' + (Join-Path $pnpmRoot 'node_modules\.bin') + ';' + $env:PATH
$env:SEMAPATH_DEV_CACHE = $CacheRoot
$env:NODE_PATH = Join-Path $projectRoot 'node_modules'
$env:npm_config_cache = Join-Path $CacheRoot 'npm'
$taskTemp = Join-Path $CacheRoot 'tmp'
New-Item -ItemType Directory -Path $taskTemp -Force | Out-Null
$env:TEMP = $taskTemp
$env:TMP = $taskTemp
$env:ELECTRON_CACHE = Join-Path $CacheRoot 'electron'
$env:ELECTRON_BUILDER_CACHE = Join-Path $CacheRoot 'electron-builder'
$env:SEMAPATH_REPLICA_DATA_DIR = Join-Path $CacheRoot 'profiles\development'
$env:SEMAPATH_REPLICA_HOME = Join-Path $CacheRoot 'profiles\development\home'
$env:DEEPCHAT_VUE_DEVTOOLS_OVERLAY = '0'
$env:COREPACK_ENABLE_PROJECT_SPEC = '0'
Set-Location -LiteralPath $projectRoot
function Invoke-ProjectPnpm([string[]]$CommandArguments) {
  & $nodeExe $pnpmEntry @CommandArguments
  if ($LASTEXITCODE -ne 0) { throw ('Project command failed: pnpm ' + ($CommandArguments -join ' ')) }
}
switch ($Action) {
  'doctor' {
    & $nodeExe --version
    & $nodeExe $pnpmEntry --version
    [pscustomobject]@{Project=$projectRoot;Cache=$CacheRoot;Profile=$env:SEMAPATH_REPLICA_DATA_DIR;AgentHome=$env:SEMAPATH_REPLICA_HOME} | Format-List
  }
  'install' {
    Invoke-ProjectPnpm @('install','--frozen-lockfile','--ignore-scripts','--store-dir',(Join-Path $CacheRoot 'pnpm-store'),'--virtual-store-dir',(Join-Path $CacheRoot 'virtual-store'))
    & $nodeExe (Join-Path $projectRoot 'node_modules\electron\install.js')
    if ($LASTEXITCODE -ne 0) { throw 'Electron installation failed' }
    if ($UseBaselineNativeModules) {
      & $nodeExe (Join-Path $PSScriptRoot 'import-baseline-native.mjs') $BaselineResources
      if ($LASTEXITCODE -ne 0) { throw 'Baseline native bootstrap failed' }
    } else {
      Invoke-ProjectPnpm @('exec','electron-builder','install-app-deps')
    }
  }
  'dev' { Invoke-ProjectPnpm (@('dev') + $RemainingArguments) }
  'start' {
    if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'out\main\index.js')) -or -not (Test-Path -LiteralPath (Join-Path $projectRoot 'out\renderer\index.html'))) {
      throw 'Built development app missing. Run scripts/replica.ps1 build first.'
    }
    Invoke-ProjectPnpm @('exec','electron-vite','preview','--skipBuild')
  }
  'sample' { & $nodeExe (Join-Path $PSScriptRoot 'create-analysis-sample.mjs'); if ($LASTEXITCODE -ne 0) { throw 'Sample generation failed' } }
  'build' { Invoke-ProjectPnpm (@('build') + $RemainingArguments) }
  'build-main' { Invoke-ProjectPnpm @('exec','node','scripts/build-replica-main.mjs') }
  'build-ui' { Invoke-ProjectPnpm @('exec','node','scripts/build-replica-ui.mjs') }
  'test' { Invoke-ProjectPnpm (@('exec','vitest','run') + $RemainingArguments) }
  'e2e' { Invoke-ProjectPnpm (@('exec','playwright','test','-c','test/e2e/playwright.replica.config.ts') + $RemainingArguments) }
  'typecheck' { Invoke-ProjectPnpm @('typecheck') }
  'lint' { Invoke-ProjectPnpm @('lint') }
  'i18n' { Invoke-ProjectPnpm @('i18n') }
  'format' { Invoke-ProjectPnpm (@('exec','oxfmt','--check') + $(if ($RemainingArguments.Count) {$RemainingArguments} else {@('.')})) }
  'package-win' { Invoke-ProjectPnpm @('exec','node','scripts/package-replica-windows.mjs') }
  'unpack' {
    Invoke-ProjectPnpm @('build')
    Invoke-ProjectPnpm @('exec','electron-builder','--win','--x64','--dir',('-c.directories.output='+(Join-Path $CacheRoot 'build')))
  }
}
