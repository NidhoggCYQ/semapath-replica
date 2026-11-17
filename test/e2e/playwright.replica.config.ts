import { defineConfig } from '@playwright/test'
import { homedir } from 'node:os'
import path from 'node:path'
import baseConfig from './playwright.config'

const cache =
  process.env.SEMAPATH_DEV_CACHE ??
  path.join(homedir(), 'Documents', 'ChatGPT', '数据分析工具开发', 'SemaPath开发缓存')

export default defineConfig({
  ...baseConfig,
  testMatch: [
    '00-replica-isolation.smoke.spec.ts',
    '01-launch.smoke.spec.ts',
    '02-analysis-chain.smoke.spec.ts',
    '03-natural-analysis.smoke.spec.ts',
    '04-analysis-reports.smoke.spec.ts',
    '05-analysis-methods.smoke.spec.ts',
    '06-analysis-framework.smoke.spec.ts',
    '07-data-connections.smoke.spec.ts',
    '08-powerbi-connections.smoke.spec.ts',
    '09-natural-data.smoke.spec.ts',
    '10-task-workspace.smoke.spec.ts',
    '11-task-interactions.smoke.spec.ts',
    '12-task-guide-connections.smoke.spec.ts',
    '13-task-message-actions.smoke.spec.ts',
    '14-file-execution.smoke.spec.ts'
  ],
  workers: 1,
  retries: 0,
  outputDir: path.join(cache, 'e2e', 'results'),
  reporter: [['list'], ['html', { outputFolder: path.join(cache, 'e2e', 'report'), open: 'never' }]]
})
