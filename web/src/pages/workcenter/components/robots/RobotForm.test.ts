/**
 * The chat-robot form — the caller-owned half of the shared permission grid.
 * What lives in this form (and nowhere in the grid component) is the exact
 * selection semantics the tool-grid spec and ADR-0046 depend on:
 *
 *  - CREATE is read-only by default: real read tools pre-checked, write/exec
 *    unchecked, network off;
 *  - EDIT preserves the saved allowlist verbatim — a failed/empty manifest never
 *    wipes a saved allowlist back to an empty grid;
 *  - switching vendor clears the previous vendor's tool selection (no cross-vendor
 *    name residue);
 *  - the network switch is codex-only and inert until a LOCAL write tool (shell /
 *    apply_patch) is ticked — a c3 MCP write tool alone must not open the sandbox.
 */
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import type {
  AgentConfig,
  ImRobot,
  RobotConfigInput,
  ToolManifestEntry,
} from '@ccc/shared/protocol'
import RobotForm from './RobotForm.vue'

const READ_TOOLS: ToolManifestEntry[] = [
  { name: 'Read', isWrite: false },
  { name: 'Grep', isWrite: false },
  { name: 'mcp__c3__list_workspaces', isWrite: false },
]
const WRITE_TOOLS: ToolManifestEntry[] = [
  { name: 'Write', isWrite: true },
  { name: 'Edit', isWrite: true },
]
const ALL_TOOLS = [...READ_TOOLS, ...WRITE_TOOLS]
const CODEX_TOOLS: ToolManifestEntry[] = [
  { name: 'Read', isWrite: false },
  { name: 'shell', isWrite: true },
  { name: 'apply_patch', isWrite: true },
  // A c3 MCP write tool must never count as a "local" write tool.
  { name: 'mcp__c3__save_intents', isWrite: true },
]

const AGENTS: AgentConfig[] = [
  {
    id: 'claude-a',
    vendor: 'claude',
    configMode: 'system',
    displayName: 'Claude A',
    config: { baseUrl: '', apiKey: '', model: '' },
  },
  {
    id: 'codex-a',
    vendor: 'codex',
    configMode: 'system',
    displayName: 'Codex A',
    config: { wireApi: 'chat', baseUrl: '', apiKey: '', model: '' },
  },
]

function robotFixture(over: Partial<ImRobot> = {}): ImRobot {
  return {
    id: 'r1',
    name: 'helper',
    platform: 'feishu',
    appId: 'cli_app',
    hasSecret: true,
    vendor: 'claude',
    agentId: 'claude-a',
    mode: 'robot',
    toolAllowlist: [],
    requireMention: true,
    chatAllowlist: [],
    dmMode: 'disabled',
    dmAllowlist: [],
    maxTurnMs: null,
    enabled: false,
    outboundAckAt: null,
    outboundAckHash: null,
    broadcastEventTypes: [],
    broadcastToBoundUsers: false,
    broadcastGroupChatIds: [],
    locale: null,
    configRevision: 0,
    writeGrants: [],
    createdAt: 0,
    updatedAt: 0,
    ...over,
  }
}

function mountForm(
  over: Partial<{
    open: boolean
    robot: ImRobot | null
    agents: AgentConfig[]
    toolManifest: Record<string, ToolManifestEntry[] | null>
    toolManifestLoading: boolean
    toolManifestError: string | null
  }> = {},
) {
  return mount(RobotForm, {
    props: {
      open: true,
      robot: null,
      agents: AGENTS,
      toolManifest: {},
      toolManifestLoading: false,
      toolManifestError: null,
      ...over,
    },
  })
}

function checked(w: ReturnType<typeof mountForm>, name: string): boolean {
  return (w.get(`[data-testid="tool-${name}"]`).element as HTMLInputElement).checked
}

function checkedCount(w: ReturnType<typeof mountForm>): number {
  return w.findAll('[data-testid^="tool-"]:checked').length
}

describe('RobotForm — create seeds read-only by default', () => {
  it('read tools pre-checked, write/exec unchecked, no network marker', () => {
    const w = mountForm({ toolManifest: { claude: ALL_TOOLS } })
    expect(checked(w, 'Read')).toBe(true)
    expect(checked(w, 'Grep')).toBe(true)
    expect(checked(w, 'mcp__c3__list_workspaces')).toBe(true)
    expect(checked(w, 'Write')).toBe(false)
    expect(checked(w, 'Edit')).toBe(false)
    // claude has no sandbox network knob — the switch is not even rendered.
    expect(w.find('[data-testid="network-access"]').exists()).toBe(false)
  })

  it('the create payload carries only the read-only defaults, network off', async () => {
    const w = mountForm({ toolManifest: { claude: ALL_TOOLS } })
    await w.get('[data-testid="robot-name"]').setValue('helper')
    await w.get('[data-testid="robot-app-id"]').setValue('cli_app')
    await w.get('[data-testid="robot-app-secret"]').setValue('secret')
    await w.get('[data-testid="robot-agent"]').setValue('claude-a')
    await w.get('[data-testid="robot-save"]').trigger('click')

    const [name, , config] = w.emitted('create')![0] as [string, string, RobotConfigInput]
    expect(name).toBe('helper')
    expect(config.toolAllowlist).toEqual(['Read', 'Grep', 'mcp__c3__list_workspaces'])
    expect(config.toolAllowlist).not.toContain('network-access')
  })
})

describe('RobotForm — edit preserves the saved allowlist', () => {
  it('restores the stored selection instead of re-seeding defaults', () => {
    const robot = robotFixture({ toolAllowlist: ['Write'] })
    const w = mountForm({ robot, toolManifest: { claude: ALL_TOOLS } })
    expect(checked(w, 'Write')).toBe(true)
    expect(checked(w, 'Read')).toBe(false)
    expect(checked(w, 'Grep')).toBe(false)
    expect(checkedCount(w)).toBe(1)
  })

  it('an intentionally empty saved allowlist stays empty', () => {
    const robot = robotFixture({ toolAllowlist: [] })
    const w = mountForm({ robot, toolManifest: { claude: ALL_TOOLS } })
    expect(checkedCount(w)).toBe(0)
  })

  it('a failed manifest cannot wipe a saved allowlist back to an empty grid', async () => {
    const robot = robotFixture({ toolAllowlist: ['Write', 'network-access'] })
    // manifest load failure → the grid shows its empty state…
    const w = mountForm({ robot, toolManifest: { claude: null } })
    expect(w.findAll('[data-testid^="tool-"]')).toHaveLength(0)
    // …but the stored allowlist survives verbatim into the update payload.
    await w.get('[data-testid="robot-save"]').trigger('click')
    const [, config] = w.emitted('update')![0] as [string, RobotConfigInput]
    expect(config.toolAllowlist).toEqual(['Write', 'network-access'])
  })
})

describe('RobotForm — vendor switch clears the tool selection', () => {
  it('switching vendor drops the previous vendor tool names', async () => {
    const robot = robotFixture({
      vendor: 'codex',
      agentId: 'codex-a',
      toolAllowlist: ['shell'],
    })
    const w = mountForm({
      robot,
      toolManifest: { codex: CODEX_TOOLS, claude: ALL_TOOLS },
    })
    expect(checked(w, 'shell')).toBe(true)

    await w.get('[data-testid="robot-vendor"]').setValue('claude')
    // Nothing leaks across: shell (codex) is gone and the edit never re-seeds.
    expect(checkedCount(w)).toBe(0)
    // The agent selection is cleared with it (cross-vendor identity is invalid).
    expect((w.get('[data-testid="robot-agent"]').element as HTMLSelectElement).value).toBe('')
  })
})

describe('RobotForm — codex network switch', () => {
  it('is codex-only and stays inert until a local write tool is ticked', async () => {
    const w = mountForm({ toolManifest: { codex: CODEX_TOOLS } })
    await w.get('[data-testid="robot-vendor"]').setValue('codex')

    const section = w.get('[data-testid="network-access"]')
    expect(w.find('[data-testid="network-access"]').exists()).toBe(true)
    const checkbox = section.get('[data-testid="network-access-checkbox"]')
    // Default selection is read-only → read-only sandbox → network-denied.
    expect((checkbox.element as HTMLInputElement).disabled).toBe(true)

    // A c3 MCP write tool alone must NOT open the writable sandbox.
    await w.get('[data-testid="tool-mcp__c3__save_intents"]').trigger('change')
    expect((checkbox.element as HTMLInputElement).disabled).toBe(true)

    // A LOCAL write tool (shell) does.
    await w.get('[data-testid="tool-shell"]').trigger('change')
    expect((checkbox.element as HTMLInputElement).disabled).toBe(false)
  })

  it('an open network switch with a local write tool lands in the payload', async () => {
    const w = mountForm({ toolManifest: { codex: CODEX_TOOLS } })
    await w.get('[data-testid="robot-vendor"]').setValue('codex')
    await w.get('[data-testid="tool-shell"]').trigger('change')
    const netCheckbox = w.get('[data-testid="network-access-checkbox"]')
    expect((netCheckbox.element as HTMLInputElement).disabled).toBe(false)
    await netCheckbox.trigger('change')

    await w.get('[data-testid="robot-name"]').setValue('helper')
    await w.get('[data-testid="robot-app-id"]').setValue('cli_app')
    await w.get('[data-testid="robot-app-secret"]').setValue('secret')
    await w.get('[data-testid="robot-agent"]').setValue('codex-a')
    await w.get('[data-testid="robot-save"]').trigger('click')

    const [, , config] = w.emitted('create')![0] as [string, string, RobotConfigInput]
    expect(config.toolAllowlist).toContain('shell')
    expect(config.toolAllowlist).toContain('network-access')
  })
})
