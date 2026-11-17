import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { unzipSync } from 'fflate'

const require = createRequire(import.meta.url)
const root = path.resolve(import.meta.dirname, '..')
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'))
if (pkg.dependencies['better-sqlite3-multiple-ciphers'] !== '12.9.0' || pkg.devDependencies.electron !== '41.10.4')
  throw new Error('Review and repin native prebuilds before changing SQLite or Electron versions')
if (process.platform !== 'win32' || process.arch !== 'x64')
  throw new Error('This release workflow targets Windows x64 only')
if (!process.env.SEMAPATH_DEV_CACHE || !path.isAbsolute(process.env.SEMAPATH_DEV_CACHE))
  throw new Error('SEMAPATH_DEV_CACHE must be an absolute external cache path')
const cache = path.join(process.env.SEMAPATH_DEV_CACHE, 'release-2026-11-18', pkg.version)
await fs.mkdir(cache, { recursive: true })
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
async function download(url, file, expected) {
  let bytes
  try {
    bytes = await fs.readFile(file)
  } catch {
    console.log(`Downloading verified runtime: ${path.basename(file)}`)
    const response = await fetch(url, { signal: AbortSignal.timeout(120000) })
    if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`)
    bytes = Buffer.from(await response.arrayBuffer())
    if (sha256(bytes) !== expected) throw new Error(`Checksum mismatch: ${url}`)
    await fs.writeFile(file, bytes)
  }
  if (sha256(bytes) !== expected) throw new Error(`Cached archive checksum mismatch: ${file}`)
  return bytes
}
function command(executable, args, options = {}) {
  const result = spawnSync(executable, args, { cwd: root, stdio: 'inherit', ...options })
  if (result.error || result.status !== 0)
    throw new Error(`Command failed: ${path.basename(executable)} ${args.join(' ')}`, {
      cause: result.error
    })
}

const sqliteName = 'better-sqlite3-multiple-ciphers-v12.9.0-electron-v145-win32-x64.tar.gz'
const sqliteUrl = `https://github.com/m4heshd/better-sqlite3-multiple-ciphers/releases/download/v12.9.0/${sqliteName}`
const sqliteArchive = path.join(cache, sqliteName)
const sqliteDigest = 'cd4b5711b432b617bc252cef773b76029182f407f58fab800acc977bc0fb7d81'
await download(sqliteUrl, sqliteArchive, sqliteDigest)
const sqliteStage = path.join(cache, 'sqlite-prebuilt')
await fs.mkdir(sqliteStage, { recursive: true })
command('tar.exe', ['-xf', sqliteArchive, '-C', sqliteStage])
const binary = await fs.readFile(path.join(sqliteStage, 'build', 'Release', 'better_sqlite3.node'))
const sqlitePackage = path.dirname(require.resolve('better-sqlite3-multiple-ciphers/package.json'))
const sqliteRelease = path.join(sqlitePackage, 'build', 'Release')
await fs.mkdir(sqliteRelease, { recursive: true })
await fs.writeFile(path.join(sqliteRelease, 'better_sqlite3.node'), binary)

const nodeName = 'node-v24.18.0-win-x64.zip'
const nodeUrl = `https://nodejs.org/dist/v24.18.0/${nodeName}`
const nodeDigest = '0ae68406b42d7725661da979b1403ec9926da205c6770827f33aac9d8f26e821'
const nodeArchive = await download(nodeUrl, path.join(cache, nodeName), nodeDigest)
const runtime = path.join(cache, 'runtime', 'node')
await fs.mkdir(runtime, { recursive: true })
const prefix = 'node-v24.18.0-win-x64/'
for (const [name, bytes] of Object.entries(unzipSync(nodeArchive))) {
  if (!name.startsWith(prefix)) throw new Error('Unexpected Node archive entry')
  const relative = name.slice(prefix.length)
  if (!relative || name.endsWith('/')) continue
  const target = path.resolve(runtime, relative)
  const contained = path.relative(runtime, target)
  if (contained.startsWith('..') || path.isAbsolute(contained)) throw new Error('Unsafe archive path')
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, bytes)
}
const nodeBinaryDigest = sha256(await fs.readFile(path.join(runtime, 'node.exe')))
if (nodeBinaryDigest !== '9a4eb5f1c29c6a2e93852ead46b999e284a6a5ca8bab4d4e241d587d025a52de')
  throw new Error('Bundled Node executable does not match resources/runtime-versions.json')
for (const file of ['npm.cmd', 'npx.cmd', 'corepack.cmd', 'LICENSE'])
  await fs.access(path.join(runtime, file))
await fs.writeFile(
  path.join(cache, 'runtime-provenance.json'),
  JSON.stringify(
    {
      sqlite: { url: sqliteUrl, archiveSha256: sqliteDigest, binarySha256: sha256(binary), abi: 145 },
      node: { url: nodeUrl, archiveSha256: nodeDigest, binarySha256: nodeBinaryDigest }
    },
    null,
    2
  )
)
const pnpm = path.join(
  process.env.SEMAPATH_DEV_CACHE,
  'toolchains',
  'pnpm-10.34.5',
  'node_modules',
  'pnpm',
  'bin',
  'pnpm.cjs'
)
command(process.execPath, ['scripts/generate-replica-icons.mjs'])
command(process.execPath, [pnpm, 'run', 'build'])
command(
  process.execPath,
  [pnpm, 'exec', 'electron-builder', '--config', 'build/replica-windows.config.cjs', '--win', '--x64', '--publish', 'never'],
  {
    env: { ...process.env, SEMAPATH_RELEASE_CACHE: cache, CSC_IDENTITY_AUTO_DISCOVERY: 'false' }
  }
)
console.log(`Windows package staged at ${path.join(cache, 'build')}`)
