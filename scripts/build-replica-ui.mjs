import { build } from 'vite'
import { resolveConfig } from 'electron-vite'
process.env.NODE_ENV_ELECTRON_VITE = 'production'
const resolved = await resolveConfig({}, 'build', 'production')
if (!resolved.config?.renderer) throw new Error('Renderer build configuration is missing')
if (resolved.config.renderer.build?.watch) resolved.config.renderer.build.watch = null
await build(resolved.config.renderer)