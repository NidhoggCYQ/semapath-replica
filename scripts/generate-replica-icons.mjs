import fs from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import sharp from 'sharp'

const require = createRequire(import.meta.url)
const root = path.resolve(import.meta.dirname, '..')
const icons = require('@iconify-json/lucide/icons.json')
const route = icons.icons.route
if (!route) throw new Error('The approved lucide:route logo is unavailable')
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 48 48"><rect width="48" height="48" rx="11" fill="#101827"/><g transform="translate(8 8) scale(1.3333333333)" color="#79aafa">${route.body}</g></svg>`
await fs.writeFile(path.join(root, 'resources', 'semapath-logo.svg'), svg)
const sizes = [16, 24, 32, 48, 64, 128, 256]
const images = await Promise.all(sizes.map((size) => sharp(Buffer.from(svg)).resize(size).png().toBuffer()))
const header = Buffer.alloc(6 + sizes.length * 16)
header.writeUInt16LE(1, 2)
header.writeUInt16LE(sizes.length, 4)
let offset = header.length
for (let i = 0; i < sizes.length; i++) {
  const start = 6 + i * 16
  header[start] = sizes[i] === 256 ? 0 : sizes[i]
  header[start + 1] = header[start]
  header.writeUInt16LE(1, start + 4)
  header.writeUInt16LE(32, start + 6)
  header.writeUInt32LE(images[i].length, start + 8)
  header.writeUInt32LE(offset, start + 12)
  offset += images[i].length
}
const ico = Buffer.concat([header, ...images])
for (const target of ['build/icon.ico', 'resources/icon.ico', 'resources/win_tray.ico'])
  await fs.writeFile(path.join(root, target), ico)
for (const target of ['build/icon.png', 'resources/icon.png'])
  await sharp(Buffer.from(svg)).resize(512).png().toFile(path.join(root, target))
await fs.mkdir(path.join(root, 'resources', 'licenses'), { recursive: true })
await fs.copyFile(
  path.join(root, 'node_modules', '@lucide', 'vue', 'LICENSE'),
  path.join(root, 'resources', 'licenses', 'lucide-LICENSE.txt')
)
console.log('Generated Windows application and tray icons from the approved lucide:route logo.')
