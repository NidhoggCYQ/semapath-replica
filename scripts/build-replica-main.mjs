import { build } from 'vite'
import { resolveConfig } from 'electron-vite'
import './build-powerbi-bridge.mjs'

process.env.NODE_ENV_ELECTRON_VITE = 'production'
const resolved = await resolveConfig({}, 'build', 'production')
// Both processes embed the shared IPC contracts. Rebuilding just main can leave a stale
// preload that strips new fields or rejects valid responses before the renderer sees them.
for (const target of ['main', 'preload']) {
  const config = resolved.config?.[target]
  if (!config) throw new Error(`${target} build configuration is missing`)
  if (config.build?.watch) config.build.watch = null
  await build(config)
}
