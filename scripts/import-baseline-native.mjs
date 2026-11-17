// SemaPath Replica modification: explicit development bootstrap for a missing Windows SDK.
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const baselineResources = process.argv[2]
const cache = process.env.SEMAPATH_DEV_CACHE
if (!baselineResources || !path.isAbsolute(baselineResources) || !cache || !path.isAbsolute(cache)) {
  throw new Error('An absolute baseline resources path and SEMAPATH_DEV_CACHE are required')
}
const require = createRequire(path.join(root, 'package.json'))
const packageName = 'better-sqlite3-multiple-ciphers'
const packagePath = require.resolve(packageName + '/package.json')
const installed = JSON.parse(await fs.readFile(packagePath, 'utf8'))
if (installed.version !== '12.9.0') throw new Error('Bootstrap only supports SQLite 12.9.0')
const source = path.join(baselineResources, 'app.asar.unpacked', 'node_modules', packageName, 'build', 'Release', 'better_sqlite3.node')
const bytes = await fs.readFile(source)
const sha256 = createHash('sha256').update(bytes).digest('hex')
if (sha256 !== '8db62c896c32bee994456cebc05ca7367b57003ad30b09472151180cdd3d3083') {
  throw new Error('Baseline native dependency hash differs from the audited 0.2.19 binary')
}
const targetRoot = await fs.realpath(path.dirname(packagePath))
const relative = path.relative(await fs.realpath(cache), targetRoot)
if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
  throw new Error('Native bootstrap may only write to the external dependency cache')
}
const destination = path.join(targetRoot, 'build', 'Release', 'better_sqlite3.node')
await fs.mkdir(path.dirname(destination), { recursive: true })
await fs.writeFile(destination, bytes)
await fs.writeFile(path.join(cache, 'native-bootstrap.json'), JSON.stringify({
  package: packageName, version: installed.version, source, destination, sha256,
  mode: 'audited-baseline-prebuilt',
  note: 'Development bootstrap only; not a native source rebuild. Requires Electron ABI 145.',
  runtimeValidation: 'pending Electron load test'
}, null, 2))
console.log('Prepared audited SQLite 12.9.0 development binary in the external dependency cache.')
