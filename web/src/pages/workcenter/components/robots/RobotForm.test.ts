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
import { QrcodeSvg } from 'qrcode.vue'
import type {
  AgentConfig,
  ImRobot,
  RobotConfigInput,
  ToolManifestEntry,
} from '@ccc/shared/protocol'
import { idleFeishuAppRegistration } from '@/controls/state'
import type { FeishuAppRegistrationState } from '@/controls/state'
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
    feishuRegistration: FeishuAppRegistrationState
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
      feishuRegistration: idleFeishuAppRegistration(),
      ...over,
    },
  })
}

function registrationState(over: Partial<FeishuAppRegistrationState>): FeishuAppRegistrationState {
  return { ...idleFeishuAppRegistration(), ...over }
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

describe('RobotForm — one-click Feishu app creation', () => {
  it('shows the entry only in create mode, never while editing', () => {
    const create = mountForm()
    expect(create.find('[data-testid="feishu-one-click"]').exists()).toBe(true)

    const edit = mountForm({ robot: robotFixture() })
    expect(edit.find('[data-testid="feishu-one-click"]').exists()).toBe(false)
    expect(edit.find('[data-testid="feishu-registration-panel"]').exists()).toBe(false)
  })

  it('emits start on click and disables the button + credential inputs while active', async () => {
    const w = mountForm()
    await w.get('[data-testid="feishu-one-click"]').trigger('click')
    expect(w.emitted('start-feishu-registration')).toHaveLength(1)

    const active = registrationState({ requestId: 'req-1', phase: 'starting' })
    await w.setProps({ feishuRegistration: active })
    expect((w.get('[data-testid="feishu-one-click"]').element as HTMLButtonElement).disabled).toBe(
      true,
    )
    expect((w.get('[data-testid="robot-app-id"]').element as HTMLInputElement).disabled).toBe(true)
    expect((w.get('[data-testid="robot-app-secret"]').element as HTMLInputElement).disabled).toBe(
      true,
    )
    expect(w.find('[data-testid="feishu-status-starting"]').exists()).toBe(true)
  })

  it('renders the QR with the same value as the clickable/copyable URL, plus scopes', async () => {
    const w = mountForm({
      feishuRegistration: registrationState({
        requestId: 'req-1',
        phase: 'waiting_scan',
        verificationUrl: 'https://accounts.feishu.cn/oauth/v1/app/registration?from=sdk',
        expiresAt: Date.now() + 90_000,
      }),
    })
    const qr = w.findComponent(QrcodeSvg)
    expect(qr.exists()).toBe(true)
    expect(qr.props('value')).toBe('https://accounts.feishu.cn/oauth/v1/app/registration?from=sdk')
    const link = w.get('[data-testid="feishu-url"]')
    expect(link.attributes('href')).toBe(
      'https://accounts.feishu.cn/oauth/v1/app/registration?from=sdk',
    )
    expect(link.text()).toBe('https://accounts.feishu.cn/oauth/v1/app/registration?from=sdk')
    expect(w.find('[data-testid="feishu-countdown"]').exists()).toBe(true)

    const scopeItems = w.findAll('[data-testid="feishu-scopes"] li')
    expect(scopeItems).toHaveLength(5)
    expect(scopeItems.map((li) => li.text()).join('\n')).toContain('im:message:send_as_bot')
    expect(scopeItems.map((li) => li.text()).join('\n')).toContain(
      'im:message.group_at_msg:readonly',
    )
    expect(scopeItems.map((li) => li.text()).join('\n')).toContain('im:message.p2p_msg:readonly')
    expect(scopeItems.map((li) => li.text()).join('\n')).toContain(
      'application:bot.basic_info:read',
    )
    expect(scopeItems.map((li) => li.text()).join('\n')).toContain('im.message.receive_v1')
    expect(w.find('[data-testid="feishu-scope-warning"]').exists()).toBe(true)

    // Copying is a user gesture over the same URL; no network request is made.
    await w.get('[data-testid="feishu-copy"]').trigger('click')
    expect(w.find('[data-testid="feishu-copy"]').exists()).toBe(true)
  })

  it('shows slow_down as a banner over the still-visible QR/link, not in place of them', async () => {
    // slow_down is a non-terminal rate-limit hint during polling, per the design
    // doc and protocol contract — it must not unmount the scan UI, or the admin
    // loses the ability to scan once Feishu emits it.
    const slow = mountForm({
      feishuRegistration: registrationState({
        requestId: 'req-1',
        phase: 'slow_down',
        verificationUrl: 'https://accounts.feishu.cn/oauth/v1/app/registration?from=sdk',
        expiresAt: Date.now() + 90_000,
      }),
    })
    expect(slow.find('[data-testid="feishu-status-slow-down"]').exists()).toBe(true)
    expect(slow.findComponent(QrcodeSvg).exists()).toBe(true)
    expect(slow.find('[data-testid="feishu-url"]').exists()).toBe(true)
    expect(slow.find('[data-testid="feishu-countdown"]').exists()).toBe(true)
    expect(slow.find('[data-testid="feishu-scopes"]').exists()).toBe(true)

    const configuring = mountForm({
      feishuRegistration: registrationState({ requestId: 'req-1', phase: 'configuring' }),
    })
    expect(configuring.find('[data-testid="feishu-status-configuring"]').exists()).toBe(true)
  })

  it('backfills both credentials on ready and keeps them editable', async () => {
    const w = mountForm()
    await w.setProps({
      feishuRegistration: registrationState({
        requestId: 'req-1',
        phase: 'ready',
        appId: 'cli_new',
        appSecret: 'new-secret',
      }),
    })
    expect((w.get('[data-testid="robot-app-id"]').element as HTMLInputElement).value).toBe(
      'cli_new',
    )
    expect((w.get('[data-testid="robot-app-secret"]').element as HTMLInputElement).value).toBe(
      'new-secret',
    )
    expect((w.get('[data-testid="robot-app-id"]').element as HTMLInputElement).disabled).toBe(false)
    expect(w.find('[data-testid="feishu-status-ready"]').exists()).toBe(true)
  })

  it('backfills on manual_setup_required and keeps the manual steps visible', async () => {
    const w = mountForm()
    await w.setProps({
      feishuRegistration: registrationState({
        requestId: 'req-1',
        phase: 'manual_setup_required',
        appId: 'cli_new',
        appSecret: 'new-secret',
        manualSetupReason: 'config_forbidden',
      }),
    })
    expect((w.get('[data-testid="robot-app-id"]').element as HTMLInputElement).value).toBe(
      'cli_new',
    )
    expect(w.find('[data-testid="feishu-manual-title"]').exists()).toBe(true)
    expect(w.find('[data-testid="feishu-manual-warning"]').exists()).toBe(true)
    expect(w.get('[data-testid="feishu-manual-console"]').attributes('href')).toBe(
      'https://open.feishu.cn/app',
    )
    // Still editable after the fill — the user can correct or replace values.
    await w.get('[data-testid="robot-app-id"]').setValue('cli_manual')
    expect((w.get('[data-testid="robot-app-id"]').element as HTMLInputElement).value).toBe(
      'cli_manual',
    )
  })

  it.each([
    ['denied', 'denied'],
    ['expired', 'expired'],
    ['cancelled', 'cancelled'],
    ['unsupported_region', 'unsupported_region'],
    ['network_error', 'network_error'],
    ['server_error', 'server_error'],
  ] as const)(
    'failed %s keeps the prior form values and shows the failed status',
    async (_, reason) => {
      const w = mountForm()
      await w.get('[data-testid="robot-app-id"]').setValue('cli_kept')
      await w.get('[data-testid="robot-app-secret"]').setValue('kept-secret')
      await w.setProps({
        feishuRegistration: registrationState({
          requestId: 'req-1',
          phase: 'failed',
          failedReason: reason,
        }),
      })
      expect((w.get('[data-testid="robot-app-id"]').element as HTMLInputElement).value).toBe(
        'cli_kept',
      )
      expect((w.get('[data-testid="robot-app-secret"]').element as HTMLInputElement).value).toBe(
        'kept-secret',
      )
      expect(w.find('[data-testid="feishu-status-failed"]').exists()).toBe(true)
    },
  )

  it('clears the result hint when the user edits a credential after a result', async () => {
    const w = mountForm()
    await w.setProps({
      feishuRegistration: registrationState({
        requestId: 'req-1',
        phase: 'ready',
        appId: 'cli_new',
        appSecret: 'new-secret',
      }),
    })
    await w.get('[data-testid="robot-app-id"]').setValue('cli_edited')
    expect(w.emitted('clear-feishu-registration')).toHaveLength(1)
  })

  it('closing cancels the registration together with the dialog', async () => {
    const w = mountForm({
      feishuRegistration: registrationState({
        requestId: 'req-1',
        phase: 'waiting_scan',
        verificationUrl: 'https://accounts.feishu.cn/x',
        expiresAt: Date.now() + 60_000,
      }),
    })
    await w.get('[data-testid="feishu-cancel"]').trigger('click')
    expect(w.emitted('cancel')).toHaveLength(1)
    expect(w.emitted('cancel-feishu-registration')).toHaveLength(1)
  })
})
