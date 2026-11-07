import type { VendorAdapter } from '../types.js'
import { dshCapabilities } from './capabilities.js'
import { DshApprovalBridge } from './approval.js'
import { DshDriver, type DshDriverDeps } from './driver.js'
import { DshSessionStore } from './session-store.js'
import { createDshSkillLoader } from './skill.js'
import { listDshTools } from './tools.js'

export { dshCapabilities } from './capabilities.js'
export { dshModeCatalog } from './modes.js'
export { DshStreamTranslator } from './translate.js'
export { DSH_SUPPORTED_PACKAGE_VERSION, DSH_MIN_NODE } from './capabilities.js'

export function createDshAdapter(deps: Partial<DshDriverDeps> = {}): VendorAdapter {
  const approval = deps.approval ?? new DshApprovalBridge()
  return {
    vendor: 'dsh',
    capabilities: dshCapabilities,
    driver: new DshDriver({ approval, resolveBinary: deps.resolveBinary }),
    approval,
    sessions: new DshSessionStore(),
    skill: createDshSkillLoader(),
    listTools(_workspacePath, mcpServers) {
      return listDshTools(mcpServers)
    },
  }
}
