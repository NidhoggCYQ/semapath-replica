import { createRouteMap } from '@/routes/routeRegistry'
import {
  analysisReferenceCatalogRoute,
  analysisReferenceCreateRoute,
  analysisQuoteCreateRoute,
  analysisContextGetRoute,
  analysisPanelsGetRoute,
  analysisPanelsSaveRoute,
  analysisGuideGetRoute,
  analysisGuideSaveRoute,
  analysisWorkspaceLookupRoute
} from '@shared/contracts/routes/analysisInteraction.routes'
import type { AnalysisInteractionService } from './interactionService'
import type { AnalysisWorkspaceService } from './workspaceService'
import { handle } from './routes'
export function createAnalysisInteractionRoutes(
  service: AnalysisInteractionService,
  workspace: AnalysisWorkspaceService
) {
  return createRouteMap([
    [
      analysisReferenceCatalogRoute.name,
      handle(analysisReferenceCatalogRoute.input, ({ taskId, query }) =>
        service.catalog(taskId, query)
      )
    ],
    [
      analysisReferenceCreateRoute.name,
      handle(analysisReferenceCreateRoute.input, ({ taskId, reference }) =>
        service.reference(taskId, reference)
      )
    ],
    [
      analysisQuoteCreateRoute.name,
      handle(analysisQuoteCreateRoute.input, ({ taskId, origin, text }) =>
        service.quote(taskId, origin, text)
      )
    ],
    [
      analysisContextGetRoute.name,
      handle(analysisContextGetRoute.input, ({ taskId, contextId }) =>
        service.read(taskId, contextId, undefined, false)
      )
    ],
    [
      analysisPanelsGetRoute.name,
      handle(analysisPanelsGetRoute.input, ({ taskId }) => service.panels(taskId))
    ],
    [
      analysisPanelsSaveRoute.name,
      handle(analysisPanelsSaveRoute.input, ({ taskId, patch }) =>
        service.savePanels(taskId, patch)
      )
    ],
    [analysisGuideGetRoute.name, handle(analysisGuideGetRoute.input, () => service.guide())],
    [
      analysisGuideSaveRoute.name,
      handle(analysisGuideSaveRoute.input, ({ patch }) => service.saveGuide(patch))
    ],
    [
      analysisWorkspaceLookupRoute.name,
      handle(analysisWorkspaceLookupRoute.input, ({ sessionId }) => workspace.forSession(sessionId))
    ]
  ])
}
