import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, copyFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

function buildPowerBiBridge() {
  if (process.platform !== 'win32') return
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const cache =
    process.env.SEMAPATH_DEV_CACHE ??
    path.join(homedir(), 'Documents', 'ChatGPT', '数据分析工具开发', 'SemaPath开发缓存')
  const sdk = process.env.SEMAPATH_DOTNET_ROOT ?? path.join(cache, 'toolchains', 'dotnet-10.0.403')
  const dotnet = path.join(sdk, 'dotnet.exe')
  if (!existsSync(dotnet))
    throw new Error(
      'Power BI bridge SDK missing: configure SEMAPATH_DOTNET_ROOT or prepare pinned .NET 10.0.403 in the external development cache'
    )
  const output = path.join(root, 'out', 'powerbi-bridge')
  const packages = path.join(cache, 'nuget')
  const artifacts = path.join(cache, 'powerbi-build')
  mkdirSync(output, { recursive: true })
  const result = spawnSync(
    dotnet,
    [
      'publish',
      path.join(root, 'native', 'powerbi', 'PowerBiBridge.csproj'),
      '-c',
      'Release',
      '-r',
      'win-x64',
      '--self-contained',
      'true',
      '--artifacts-path',
      artifacts,
      '-o',
      output,
      '-p:ContinuousIntegrationBuild=true',
      '-p:RestoreLockedMode=true'
    ],
    {
      cwd: root,
      windowsHide: true,
      stdio: 'inherit',
      env: {
        ...process.env,
        DOTNET_ROOT: sdk,
        DOTNET_CLI_HOME: path.join(cache, 'dotnet-home'),
        DOTNET_CLI_TELEMETRY_OPTOUT: '1',
        DOTNET_NOLOGO: '1',
        NUGET_PACKAGES: packages,
        NUGET_HTTP_CACHE_PATH: path.join(cache, 'nuget-http'),
        TEMP: path.join(cache, 'tmp'),
        TMP: path.join(cache, 'tmp')
      }
    }
  )
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error('Power BI bridge publish failed (' + result.status + ')')
  const licenses = path.join(output, 'licenses')
  mkdirSync(licenses, { recursive: true })
  for (const file of readdirSync(path.join(root, 'native', 'powerbi', 'licenses')))
    copyFileSync(path.join(root, 'native', 'powerbi', 'licenses', file), path.join(licenses, file))
  for (const file of ['LICENSE.TXT', 'THIRD-PARTY-NOTICES.TXT'])
    copyFileSync(
      path.join(packages, 'microsoft.netcore.app.runtime.win-x64', '10.0.14', file),
      path.join(licenses, 'dotnet-' + file)
    )
  copyFileSync(
    path.join(root, 'node_modules', '@azure', 'msal-node', 'LICENSE'),
    path.join(licenses, 'msal-node-MIT.txt')
  )
}
buildPowerBiBridge()
