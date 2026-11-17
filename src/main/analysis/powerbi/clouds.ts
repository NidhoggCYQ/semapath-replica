import type { PbiApplication } from '@shared/analysisPowerBi'
export const PBI_CLOUDS = {
  global: {
    authority: 'https://login.microsoftonline.com',
    authHosts: ['login.microsoftonline.com'],
    resource: 'https://analysis.windows.net/powerbi/api',
    rest: 'https://api.powerbi.com/v1.0/myorg',
    fabric: 'https://api.fabric.microsoft.com/v1'
  },
  china: {
    authority: 'https://login.chinacloudapi.cn',
    authHosts: ['login.chinacloudapi.cn', 'login.partner.microsoftonline.cn'],
    resource: 'https://analysis.chinacloudapi.cn/powerbi/api',
    rest: 'https://api.powerbi.cn/v1.0/myorg',
    fabric: null
  }
} as const
export function pbiScopes(app: PbiApplication) {
  const cloud = PBI_CLOUDS[app.environment]
  return [cloud.resource + '/Workspace.Read.All', cloud.resource + '/Dataset.Read.All']
}
