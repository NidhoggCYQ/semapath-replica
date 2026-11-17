const path = require('node:path')
const fs = require('node:fs')
const { parse } = require('yaml')

if (!process.env.SEMAPATH_RELEASE_CACHE) throw new Error('Use scripts/replica.ps1 package-win')
const config = parse(fs.readFileSync(path.join(__dirname, '..', 'electron-builder.yml'), 'utf8'))
config.directories.output = path.join(process.env.SEMAPATH_RELEASE_CACHE, 'build')
// The packaging script first installs the checksum-pinned official Electron prebuild.
// Avoid rebuilding it for the host Node ABI or requiring a compiler on the packaging host.
config.npmRebuild = false
config.extraResources = config.extraResources.filter((entry) => entry.from !== './runtime/')
config.extraResources.push({
  from: path.join(process.env.SEMAPATH_RELEASE_CACHE, 'runtime'),
  to: 'app.asar.unpacked/runtime',
  filter: ['**/*']
})
config.win.target = [{ target: 'nsis', arch: ['x64'] }]
module.exports = config
