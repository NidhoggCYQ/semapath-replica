import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { homedir } from 'node:os'
import { createAnalysisWorkbook } from '../test/fixtures/analysisWorkbook.ts'

const cache = process.env.SEMAPATH_DEV_CACHE ?? path.join(homedir(), 'Documents', 'ChatGPT', '数据分析工具开发', 'SemaPath开发缓存')
const directory = path.join(cache, 'examples')
await mkdir(directory, { recursive: true })
const file = path.join(directory, 'Excel链路验收样例-合成数据.xlsx')
await writeFile(file, createAnalysisWorkbook(), { flag: 'wx' }).catch((error) => { if (error.code !== 'EEXIST') throw error })
console.log(file)