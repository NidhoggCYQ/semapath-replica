import { createRouteMap } from '@/routes/routeRegistry'
import {
  analysisWorkspaceListRoute,
  analysisWorkspaceSessionRoute,
  analysisWorkspaceChatRoute,
  analysisWorkspacePinRoute,
  analysisWorkspaceOperationsRoute,
  analysisWorkspaceProjectRoute
} from '@shared/contracts/routes/analysis.routes'
import type { AnalysisWorkspaceService } from './workspaceService'
import { handle } from './routes'

export function createAnalysisWorkspaceRoutes(service: AnalysisWorkspaceService) {
  return createRouteMap([
    [
      analysisWorkspaceProjectRoute.name,
      handle(analysisWorkspaceProjectRoute.input, ({ taskId, projectDir }) =>
        service.setProject(taskId, projectDir)
      )
    ],
    [
      analysisWorkspaceListRoute.name,
      handle(analysisWorkspaceListRoute.input, () => service.list())
    ],
    [
      analysisWorkspaceSessionRoute.name,
      handle(analysisWorkspaceSessionRoute.input, ({ sessionId }) =>
        service.ensureForSession(sessionId)
      )
    ],
    [
      analysisWorkspaceChatRoute.name,
      handle(analysisWorkspaceChatRoute.input, ({ taskId }) => service.openChat(taskId))
    ],
    [
      analysisWorkspacePinRoute.name,
      handle(analysisWorkspacePinRoute.input, async ({ taskId, pinned }) => {
        await service.pin(taskId, pinned)
        return true
      })
    ],
    [
      analysisWorkspaceOperationsRoute.name,
      handle(analysisWorkspaceOperationsRoute.input, ({ taskId }) => service.operations(taskId))
    ]
  ])
}
