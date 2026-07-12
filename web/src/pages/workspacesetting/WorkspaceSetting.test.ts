import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { mount } from '@vue/test-utils'
import WorkspaceSetting from './WorkspaceSetting.vue'
import type {
  WorkspaceSetting as WorkspaceSettingType,
  SkillRepoConfig,
  VendorId,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  ModeToken,
  VendorModeCatalog,
  SystemSandboxDef,
  AgentConfig,
} from '@ccc/shared/protocol'

/** Stub vendorModes so the form can render each vendor's catalog options. */
const MOCK_VENDOR_MODES: Record<VendorId, VendorModeCatalog> = {
  claude: {
    vendor: 'claude',
    defaultToken: 'default',
    modes: [
      {
        token: 'default',
        labelCode: 'nav.mode.default.label',
        actionMode: 'build',
        toolGate: 'on-sensitive',
      },
      {
        token: 'plan',
        labelCode: 'nav.mode.plan.label',
        actionMode: 'plan',
        toolGate: 'on-sensitive',
      },
    ],
  },
  codex: {
    vendor: 'codex',
    defaultToken: 'auto',
    modes: [
      {
        token: 'read-only',
        labelCode: 'nav.mode.readOnly.label',
        actionMode: 'plan',
        toolGate: 'on-sensitive',
      },
      {
        token: 'auto',
        labelCode: 'nav.mode.auto.label',
        actionMode: 'build',
        toolGate: 'on-sensitive',
      },
      {
        token: 'full-access',
        labelCode: 'nav.mode.fullAccess.label',
        actionMode: 'build',
        toolGate: 'never-ask',
      },
    ],
  },
}

/** The per-tab Save button after the Tab grouping refactor. Every tab panel is
 *  rendered (v-show), so a control and its tab's Save button are always in the
 *  DOM — a test can drive either without activating the tab first. */
const SAVE = {
  defaultMode: '[data-testid="project-config-save-defaultMode"]',
  gitSandbox: '[data-testid="project-config-save-gitSandbox"]',
  collab: '[data-testid="project-config-save-collab"]',
  skillRepos: '[data-testid="project-config-save-skillRepos"]',
} as const

// `@vue/test-utils` `isVisible()` is unreliable for nested v-show in this env, but
// v-show writes `display: none` inline — read that directly to check tab visibility.
function panelHidden(w: ReturnType<typeof mount>, testid: string): boolean {
  return (w.find(`[data-testid="${testid}"]`).attributes('style') ?? '').includes('display: none')
}

/** Convenience: per-vendor config with the given claude token. */
function cfg(overrides?: Partial<WorkspaceSettingType>): WorkspaceSettingType {
  return {
    defaultMode: { claude: 'plan', codex: 'auto' },
    devSkill: '/my-skill',
    maxRoundsPerStage: 14,
    maxSpeechChars: 400,
    consensus: { enabled: true, majority: true },
    ...overrides,
  }
}

/** Shorthand mount with the common prop set. */
function mountWs(config: WorkspaceSettingType | null, extra?: Record<string, unknown>) {
  return mount(WorkspaceSetting, {
    props: {
      open: true,
      workspaceSetting: config,
      detectedMainBranch: null,
      currentWorkspace: '/test',
      vendorModes: MOCK_VENDOR_MODES,
      systemSandboxes: [],
      ...extra,
    },
  })
}

describe('WorkspaceSetting.vue — per-vendor default mode', () => {
  it('renders a mode select for each vendor in correct order', () => {
    const w = mountWs(null)
    // 2 codex policy selects (sandbox + approval) + 1 claude
    // + 1 git-branch-mode select = 4
    const selects = w.findAll('.mode-select')
    expect(selects).toHaveLength(4)
    // Claude still has a mode select; Codex uses dual-policy selects.
    expect(w.findAll('[data-testid="default-mode-claude"]').length).toBe(1)
    expect(w.findAll('[data-testid="default-mode-codex-sandbox"]').length).toBe(1)
    expect(w.findAll('[data-testid="default-mode-codex-approval"]').length).toBe(1)
  })

  it('seeds each vendor select from per-vendor project config', () => {
    const w = mountWs(cfg())
    expect((w.find('[data-testid="default-mode-claude"]').element as HTMLSelectElement).value).toBe(
      'plan',
    )
    // Codex uses dual-policy selects instead of a single mode select.
    expect(
      (w.find('[data-testid="default-mode-codex-sandbox"]').element as HTMLSelectElement).value,
    ).toBe('workspace-write')
    expect(
      (w.find('[data-testid="default-mode-codex-approval"]').element as HTMLSelectElement).value,
    ).toBe('on-request')
  })

  it('defaults each vendor to the catalog defaultToken when config omits defaultMode', () => {
    const w = mountWs({})
    // catalog defaultTokens: claude='default', codex='auto'
    expect((w.find('[data-testid="default-mode-claude"]').element as HTMLSelectElement).value).toBe(
      'default',
    )
    // Codex dual-policy defaults: workspace-write, on-request
    expect(
      (w.find('[data-testid="default-mode-codex-sandbox"]').element as HTMLSelectElement).value,
    ).toBe('workspace-write')
    expect(
      (w.find('[data-testid="default-mode-codex-approval"]').element as HTMLSelectElement).value,
    ).toBe('on-request')
  })

  it('renders vendor-specific mode options (not the full cross-vendor set)', () => {
    const w = mountWs(null)
    // claude menu: 'default', 'plan'
    const claudeOpts = w
      .find('[data-testid="default-mode-claude"]')
      .findAll('option')
      .map((o) => o.attributes('value'))
    expect(claudeOpts).toEqual(['default', 'plan'])

    // Codex uses dual-policy selects instead of a single mode select.
    const sandboxOpts = w
      .find('[data-testid="default-mode-codex-sandbox"]')
      .findAll('option')
      .map((o) => o.attributes('value'))
    expect(sandboxOpts).toEqual(['workspace-write', 'read-only'])
    const approvalOpts = w
      .find('[data-testid="default-mode-codex-approval"]')
      .findAll('option')
      .map((o) => o.attributes('value'))
    expect(approvalOpts).toEqual(['on-request', 'on-failure', 'never'])
  })

  it('renders a row label for each config item', () => {
    const w = mountWs(null)
    // 2 vendor row-labels + devSkill + rounds + speechChars
    // + gitBranchMode + defaultMainBranch = 7
    const labels = w.findAll('.project-config-row-label')
    expect(labels).toHaveLength(7)
    expect(labels[0].text()).toBeTruthy()
  })

  it('emits the entire per-vendor map on the default-mode tab save', async () => {
    const w = mountWs(cfg())
    await w.find(SAVE.defaultMode).trigger('click')
    const emitted = w.emitted('save') as [WorkspaceSettingType][]
    expect(emitted).toBeTruthy()
    const payload = emitted[0][0]
    expect(payload.defaultMode).toEqual({
      claude: 'plan',
      codex: { sandboxMode: 'workspace-write', approvalPolicy: 'on-request' },
    })
  })

  it('emits the edited per-vendor value on save after changing one vendor', async () => {
    const w = mountWs(cfg())
    await w.find('[data-testid="default-mode-claude"]').setValue('default')
    await w.find(SAVE.defaultMode).trigger('click')
    const emitted = w.emitted('save') as [WorkspaceSettingType][]
    const payload = emitted[0][0]
    expect((payload.defaultMode as Record<VendorId, unknown>).claude).toBe('default')
    expect((payload.defaultMode as Record<VendorId, unknown>).codex).toEqual({
      sandboxMode: 'workspace-write',
      approvalPolicy: 'on-request',
    })
  })

  it('rebuilds the Codex dual-policy object on the default-mode save', async () => {
    const w = mountWs(cfg())
    await w.find('[data-testid="default-mode-codex-sandbox"]').setValue('read-only')
    await w.find('[data-testid="default-mode-codex-approval"]').setValue('never')
    await w.find(SAVE.defaultMode).trigger('click')
    const payload = (w.emitted('save') as [WorkspaceSettingType][])[0][0]
    expect((payload.defaultMode as Record<VendorId, unknown>).codex).toEqual({
      sandboxMode: 'read-only',
      approvalPolicy: 'never',
    })
  })
})

describe('WorkspaceSetting.vue — dev skill', () => {
  it('seeds the dev skill input from project config', () => {
    const w = mountWs(cfg())
    const inputs = w.findAll('.project-config-field')
    const skillInput = inputs.find((el) => (el.element as HTMLInputElement).type !== 'number')
    expect(skillInput?.exists()).toBe(true)
    expect((skillInput?.element as HTMLInputElement).value).toBe('/my-skill')
  })

  it('defaults dev skill to empty string when config omits it', () => {
    const w = mountWs({})
    const inputs = w.findAll('.project-config-field')
    const skillInput = inputs.find((el) => (el.element as HTMLInputElement).type !== 'number')
    expect((skillInput?.element as HTMLInputElement).value ?? '').toBe('')
  })
})

describe('WorkspaceSetting.vue — discussion rounds per stage', () => {
  it('seeds the rounds input from project config', () => {
    const w = mountWs(cfg())
    const inputs = w.findAll('.project-config-number')
    expect(inputs.length).toBeGreaterThanOrEqual(1)
    expect((inputs[0].element as HTMLInputElement).value).toBe('14')
  })

  it('defaults the rounds input when config omits the field', () => {
    const w = mountWs(cfg({ maxRoundsPerStage: undefined }))
    const inputs = w.findAll('.project-config-number')
    expect((inputs[0].element as HTMLInputElement).value).toBe('12')
  })

  it('emits the edited rounds value on the collaboration tab save', async () => {
    const w = mountWs(cfg())
    const inputs = w.findAll('.project-config-number')
    await inputs[0].setValue(20)
    await w.find(SAVE.collab).trigger('click')
    const emitted = w.emitted('save') as [WorkspaceSettingType][]
    expect(emitted).toBeTruthy()
    expect(emitted[0][0].maxRoundsPerStage).toBe(20)
  })
})

describe('WorkspaceSetting.vue — discussion speech character limit', () => {
  it('seeds the speech-chars input from project config', () => {
    const w = mountWs(cfg())
    const inputs = w.findAll('.project-config-number')
    expect(inputs.length).toBeGreaterThanOrEqual(2)
    expect((inputs[1].element as HTMLInputElement).value).toBe('400')
  })

  it('defaults the speech-chars input when config omits the field', () => {
    const w = mountWs(cfg({ maxSpeechChars: undefined }))
    const inputs = w.findAll('.project-config-number')
    expect((inputs[1].element as HTMLInputElement).value).toBe('300')
  })

  it('emits the edited speech-chars value on the collaboration tab save', async () => {
    const w = mountWs(cfg())
    const inputs = w.findAll('.project-config-number')
    await inputs[1].setValue(600)
    await w.find(SAVE.collab).trigger('click')
    const emitted = w.emitted('save') as [WorkspaceSettingType][]
    expect(emitted).toBeTruthy()
    expect(emitted[0][0].maxSpeechChars).toBe(600)
  })
})

describe('WorkspaceSetting.vue — consensus majority toggle', () => {
  it('seeds the majority checkbox from project config', () => {
    const w = mountWs(cfg())
    const box = w.find('[data-testid="project-config-consensus-majority"]')
    expect(box.exists()).toBe(true)
    expect((box.element as HTMLInputElement).checked).toBe(true)
  })

  it('defaults the majority checkbox to false when config omits it', () => {
    const w = mountWs({ consensus: { enabled: true } })
    expect(
      (w.find('[data-testid="project-config-consensus-majority"]').element as HTMLInputElement)
        .checked,
    ).toBe(false)
  })

  it('emits the toggled majority value on the collaboration tab save', async () => {
    const w = mountWs(cfg())
    await w.find('[data-testid="project-config-consensus-majority"]').setValue(false)
    await w.find(SAVE.collab).trigger('click')
    const emitted = w.emitted('save') as [WorkspaceSettingType][]
    expect(emitted[0][0].consensus?.majority).toBe(false)
  })
})

describe('WorkspaceSetting.vue — consensus custom voters', () => {
  const VOTER_AGENTS: AgentConfig[] = [
    {
      id: 'v1',
      vendor: 'claude',
      configMode: 'custom',
      displayName: 'Voter One',
      enabled: true,
      config: { baseUrl: '', apiKey: '', model: '' },
    },
    {
      id: 'v2',
      vendor: 'claude',
      configMode: 'custom',
      displayName: 'Voter Two',
      enabled: true,
      config: { baseUrl: '', apiKey: '', model: '' },
    },
  ]

  it('defaults the mode radio to "all" when config omits it', () => {
    const w = mountWs(cfg(), { agents: VOTER_AGENTS })
    const all = w.find('[data-testid="project-config-consensus-mode-all"]')
    expect((all.element as HTMLInputElement).checked).toBe(true)
    // No agent checklist while in "all" mode.
    expect(w.find('[data-testid="project-config-consensus-agent-v1"]').exists()).toBe(false)
  })

  it('shows the agent checklist in custom mode and emits the picked agentIds on save', async () => {
    const w = mountWs(cfg({ consensus: { enabled: true, mode: 'custom', agentIds: [] } }), {
      agents: VOTER_AGENTS,
    })
    expect(
      (w.find('[data-testid="project-config-consensus-mode-custom"]').element as HTMLInputElement)
        .checked,
    ).toBe(true)
    // Pick v2 only.
    await w.find('[data-testid="project-config-consensus-agent-v2"]').setValue(true)
    await w.find(SAVE.collab).trigger('click')
    const emitted = w.emitted('save') as [WorkspaceSettingType][]
    expect(emitted[0][0].consensus?.mode).toBe('custom')
    expect(emitted[0][0].consensus?.agentIds).toEqual(['v2'])
  })

  it('seeds the custom agentIds from config', () => {
    const w = mountWs(cfg({ consensus: { enabled: true, mode: 'custom', agentIds: ['v1'] } }), {
      agents: VOTER_AGENTS,
    })
    expect(
      (w.find('[data-testid="project-config-consensus-agent-v1"]').element as HTMLInputElement)
        .checked,
    ).toBe(true)
    expect(
      (w.find('[data-testid="project-config-consensus-agent-v2"]').element as HTMLInputElement)
        .checked,
    ).toBe(false)
  })
})

describe('WorkspaceSetting.vue — external skill repos (ADR-0016/0017)', () => {
  const configWithSkillRepos: WorkspaceSettingType = {
    ...cfg(),
    skillRepos: [
      {
        id: 'my-skills',
        repo: 'https://github.com/owner/repo',
        ref: 'main',
        subpath: 'skills/my-skill',
      },
      {
        id: 'more-skills',
        repo: 'https://github.com/owner/more',
        ref: 'v1.0',
      },
    ] as SkillRepoConfig[],
  }

  it('renders a row per skill repo when projectConfig carries skillRepos', () => {
    const w = mountWs(configWithSkillRepos)
    const rows = w.findAll('[data-testid="skill-repo-row"]')
    expect(rows).toHaveLength(2)
  })

  it('shows an empty hint when skillRepos is empty', () => {
    const w = mountWs(cfg())
    expect(w.text()).toContain('No external skill repositories configured.')
  })

  it('adds a new row on + Add skill repo', async () => {
    const w = mountWs(cfg())
    await w.find('[data-testid="project-config-add-skill-repo"]').trigger('click')
    const rows = w.findAll('[data-testid="skill-repo-row"]')
    expect(rows).toHaveLength(1)
  })

  it('removes a row on click', async () => {
    const w = mountWs(configWithSkillRepos)
    const removes = w.findAll('[data-testid="skill-repo-remove"]')
    expect(removes).toHaveLength(2)
    await removes[0].trigger('click')
    expect(w.findAll('[data-testid="skill-repo-row"]')).toHaveLength(1)
  })

  it('shows ref required error when ref is empty', () => {
    const w = mountWs({
      ...cfg(),
      skillRepos: [
        {
          id: 's',
          repo: '',
          ref: '',
        } as SkillRepoConfig,
      ],
    })
    const errors = w.findAll('[data-testid="skill-repo-ref-error"]')
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0].text()).toBeTruthy()
  })

  it('renders only id/repo/ref/subpath fields (no vendor/trust/pin controls)', () => {
    const w = mountWs(configWithSkillRepos)
    expect(w.find('[data-testid="skill-repo-vendor"]').exists()).toBe(false)
    expect(w.find('[data-testid="skill-repo-trust"]').exists()).toBe(false)
    expect(w.find('[data-testid="skill-repo-pin-commit"]').exists()).toBe(false)
  })

  it('carries the edited skillRepos into the skill-repos tab Save payload', async () => {
    const w = mountWs(configWithSkillRepos)
    const inputs = w.findAll('[data-testid="skill-repo-ref"]')
    await inputs[0].setValue('develop')
    await w.find(SAVE.skillRepos).trigger('click')
    const emitted = w.emitted('save') as [WorkspaceSettingType][]
    expect(emitted[0][0].skillRepos?.[0]?.ref).toBe('develop')
  })

  it('emits queryLinkStatus when the panel opens', () => {
    const w = mountWs(configWithSkillRepos)
    expect((w.emitted('queryLinkStatus') ?? []).length).toBeGreaterThanOrEqual(1)
  })

  it('renders linked vs not-linked per row from linkStatuses (both dirs required)', () => {
    const w = mountWs(configWithSkillRepos, {
      // row 0 fully linked; row 1 only one dir → counts as not linked
      linkStatuses: [
        { id: 'my-skills', claudeSkills: true, agentsSkills: true },
        { id: 'more-skills', claudeSkills: true, agentsSkills: false },
      ],
    })
    const statuses = w.findAll('[data-testid="skill-repo-status"]')
    expect(statuses).toHaveLength(2)
    expect(statuses[0].text()).toBe('Linked')
    expect(statuses[0].attributes('data-linked')).toBe('true')
    expect(statuses[1].text()).toBe('Not linked')
    expect(statuses[1].attributes('data-linked')).toBe('false')
  })

  it('shows not-linked for a row absent from linkStatuses', () => {
    const w = mountWs(configWithSkillRepos, { linkStatuses: [] })
    const statuses = w.findAll('[data-testid="skill-repo-status"]')
    expect(statuses[0].attributes('data-linked')).toBe('false')
  })

  it('emits installSkill with the row id on Install click', async () => {
    const w = mountWs(configWithSkillRepos)
    const buttons = w.findAll('[data-testid="skill-repo-install"]')
    expect(buttons).toHaveLength(2)
    await buttons[0].trigger('click')
    const emitted = w.emitted('installSkill') as [string][]
    expect(emitted).toBeTruthy()
    expect(emitted[0][0]).toBe('my-skills')
  })

  it('disables Install when ref is missing or repo is empty', () => {
    const w = mountWs({
      ...cfg(),
      skillRepos: [{ id: 's', repo: '', ref: '' } as SkillRepoConfig],
    })
    const btn = w.find('[data-testid="skill-repo-install"]')
    expect(btn.attributes('disabled')).toBeDefined()
  })

  it('shows a busy label and disables Install while installing', () => {
    const w = mountWs(configWithSkillRepos, { installingSkillIds: ['my-skills'] })
    const buttons = w.findAll('[data-testid="skill-repo-install"]')
    expect(buttons[0].text()).toBe('Installing…')
    expect(buttons[0].attributes('disabled')).toBeDefined()
    // the other row is not installing → enabled, default label
    expect(buttons[1].text()).toBe('Install')
    expect(buttons[1].attributes('disabled')).toBeUndefined()
  })

  it('an install/link-status pushback never reseeds or clears skill-repo drafts', async () => {
    const w = mountWs(configWithSkillRepos)
    // Dirty the skill-repos tab by adding a row.
    await w.find('[data-testid="project-config-add-skill-repo"]').trigger('click')
    expect(w.findAll('[data-testid="skill-repo-row"]')).toHaveLength(3)
    // Install/link status arrive via dedicated props, not workspace_setting — they
    // must not touch the skill-repos draft.
    await w.setProps({
      installingSkillIds: ['my-skills'],
      linkStatuses: [{ id: 'my-skills', claudeSkills: true, agentsSkills: true }],
    })
    expect(w.findAll('[data-testid="skill-repo-row"]')).toHaveLength(3)
    expect(w.find('[data-testid="project-config-tab-dirty-skillRepos"]').exists()).toBe(true)
  })
})

describe('WorkspaceSetting.vue — git branch mode + default main branch', () => {
  it('defaults to current-branch with an empty branch when config is null', () => {
    const w = mountWs(null)
    expect((w.find('[data-testid="git-branch-mode"]').element as HTMLSelectElement).value).toBe(
      'current-branch',
    )
    expect((w.find('[data-testid="default-main-branch"]').element as HTMLInputElement).value).toBe(
      '',
    )
  })

  it('pre-fills the branch from detectedMainBranch when config has none', () => {
    const w = mountWs(cfg(), { detectedMainBranch: 'main' })
    expect((w.find('[data-testid="default-main-branch"]').element as HTMLInputElement).value).toBe(
      'main',
    )
  })

  it('a saved branch value wins over the detected one', () => {
    const w = mountWs(cfg({ gitBranchMode: 'worktree', defaultMainBranch: 'develop' }), {
      detectedMainBranch: 'main',
    })
    expect((w.find('[data-testid="git-branch-mode"]').element as HTMLSelectElement).value).toBe(
      'worktree',
    )
    expect((w.find('[data-testid="default-main-branch"]').element as HTMLInputElement).value).toBe(
      'develop',
    )
  })

  it('emits the edited git branch mode + branch on the git-sandbox tab save', async () => {
    const w = mountWs(cfg())
    await w.find('[data-testid="git-branch-mode"]').setValue('worktree')
    await w.find('[data-testid="default-main-branch"]').setValue('release')
    await w.find(SAVE.gitSandbox).trigger('click')
    const emitted = w.emitted('save') as [WorkspaceSettingType][]
    const payload = emitted[0][0]
    expect(payload.gitBranchMode).toBe('worktree')
    expect(payload.defaultMainBranch).toBe('release')
  })

  it('emits an undefined branch when the input is blank', async () => {
    const w = mountWs(cfg({ gitBranchMode: 'worktree', defaultMainBranch: '   ' }))
    await w.find(SAVE.gitSandbox).trigger('click')
    const emitted = w.emitted('save') as [WorkspaceSettingType][]
    expect(emitted[0][0].defaultMainBranch).toBeUndefined()
  })
})

describe('WorkspaceSetting.vue — spec-driven development (SDD)', () => {
  it('hides the spec root display when SDD is disabled (default)', () => {
    const w = mountWs(null, { resolvedSpecRoot: '/home/u/.c3/specs/test' })
    expect((w.find('[data-testid="sdd-enabled"]').element as HTMLInputElement).checked).toBe(false)
    expect(w.find('[data-testid="sdd-spec-root"]').exists()).toBe(false)
  })

  it('reveals the read-only spec root when SDD is toggled on', async () => {
    const w = mountWs(null, { resolvedSpecRoot: '/home/u/.c3/specs/test' })
    expect(w.find('[data-testid="sdd-spec-root"]').exists()).toBe(false)
    await w.find('[data-testid="sdd-enabled"]').setValue(true)
    expect(w.find('[data-testid="sdd-spec-root"]').exists()).toBe(true)
  })

  it('displays the resolved spec root and it is NOT an editable input (REQ-3)', () => {
    const w = mountWs(cfg({ sddEnabled: true }), { resolvedSpecRoot: '/home/u/.c3/specs/test' })
    const display = w.find('[data-testid="sdd-spec-root"]')
    expect(display.exists()).toBe(true)
    expect(display.text()).toBe('/home/u/.c3/specs/test')
    // Read-only: a <code> display, never an <input> the user can edit/submit.
    expect(display.element.tagName).toBe('CODE')
  })

  it('emits the toggled SDD config on the collaboration tab save with NO spec directory value (REQ-3)', async () => {
    const w = mountWs(cfg(), { resolvedSpecRoot: '/home/u/.c3/specs/test' })
    await w.find('[data-testid="sdd-enabled"]').setValue(true)
    await w.find(SAVE.collab).trigger('click')
    const payload = (w.emitted('save') as [WorkspaceSettingType][])[0][0]
    expect(payload.sddEnabled).toBe(true)
    // The save payload carries no spec directory — the path is fixed/centralized.
    expect((payload as Record<string, unknown>).specPath).toBeUndefined()
  })
})

describe('WorkspaceSetting.vue — sandbox worktree gating + agent multi-select', () => {
  const SANDBOXES: SystemSandboxDef[] = [
    { name: 'default', type: 'docker', image: 'node:22-alpine' },
  ]
  // A custom-enabled agent (selectable), a custom-disabled one, and a system one.
  const AGENTS: AgentConfig[] = [
    {
      id: 'custom-on',
      vendor: 'claude',
      configMode: 'custom',
      displayName: 'Custom On',
      enabled: true,
      config: { baseUrl: '', apiKey: '', model: '' },
    },
    {
      id: 'custom-off',
      vendor: 'claude',
      configMode: 'custom',
      displayName: 'Custom Off',
      enabled: false,
      config: { baseUrl: '', apiKey: '', model: '' },
    },
    {
      id: 'system-on',
      vendor: 'claude',
      configMode: 'system',
      displayName: 'System On',
      enabled: true,
      config: { baseUrl: '', apiKey: '', model: '' },
    },
  ]

  function mountSandbox(overrides?: Partial<WorkspaceSettingType>) {
    return mountWs(cfg(overrides), { systemSandboxes: SANDBOXES, agents: AGENTS })
  }

  it('hides the sandbox section under current-branch even with system defs', () => {
    const w = mountSandbox({ gitBranchMode: 'current-branch' })
    expect(w.find('[data-testid="project-config-sandbox"]').exists()).toBe(false)
  })

  it('shows the sandbox section under worktree when system defs exist', () => {
    const w = mountSandbox({ gitBranchMode: 'worktree' })
    expect(w.find('[data-testid="project-config-sandbox"]').exists()).toBe(true)
  })

  it('reveals the section when switching current-branch → worktree', async () => {
    const w = mountSandbox({ gitBranchMode: 'current-branch' })
    expect(w.find('[data-testid="project-config-sandbox"]').exists()).toBe(false)
    await w.find('[data-testid="git-branch-mode"]').setValue('worktree')
    expect(w.find('[data-testid="project-config-sandbox"]').exists()).toBe(true)
  })

  it('lists only enabled custom agents in the picker', () => {
    const w = mountSandbox({
      gitBranchMode: 'worktree',
      sandbox: { enabled: true, sandbox: 'default' },
    })
    expect(w.find('[data-testid="project-config-sandbox-agent-custom-on"]').exists()).toBe(true)
    expect(w.find('[data-testid="project-config-sandbox-agent-custom-off"]').exists()).toBe(false)
    expect(w.find('[data-testid="project-config-sandbox-agent-system-on"]').exists()).toBe(false)
  })

  it('shows the empty state when no custom agents are eligible', () => {
    const w = mountWs(
      cfg({
        gitBranchMode: 'worktree',
        sandbox: { enabled: true, sandbox: 'default' },
      }),
      { systemSandboxes: SANDBOXES, agents: [AGENTS[1], AGENTS[2]] }, // only disabled-custom + system
    )
    expect(w.find('[data-testid="project-config-sandbox-agents-empty"]').exists()).toBe(true)
    expect(w.find('[data-testid="project-config-sandbox-agents"]').exists()).toBe(false)
  })

  it('writes the toggled agent ids into the saved sandbox config (git-sandbox tab)', async () => {
    const w = mountSandbox({
      gitBranchMode: 'worktree',
      sandbox: { enabled: true, sandbox: 'default' },
    })
    await w.find('[data-testid="project-config-sandbox-agent-custom-on"]').trigger('change')
    await w.find(SAVE.gitSandbox).trigger('click')
    const payload = (w.emitted('save') as [WorkspaceSettingType][])[0][0]
    expect(payload.sandbox?.enabled).toBe(true)
    expect(payload.sandbox?.agentIds).toEqual(['custom-on'])
  })

  it('drops the sandbox from the save payload when not in worktree mode', async () => {
    // Start in worktree with an enabled sandbox, then switch back to current-branch.
    const w = mountSandbox({
      gitBranchMode: 'worktree',
      sandbox: { enabled: true, sandbox: 'default' },
    })
    await w.find('[data-testid="git-branch-mode"]').setValue('current-branch')
    await w.find(SAVE.gitSandbox).trigger('click')
    const payload = (w.emitted('save') as [WorkspaceSettingType][])[0][0]
    expect(payload.sandbox).toBeUndefined()
  })
})

describe('WorkspaceSetting.vue — Tab grouping', () => {
  it('renders exactly four tabs in order: 默认模式 / Git 与沙箱 / 协作 / 技能仓库', () => {
    const w = mountWs(cfg())
    const labels = w
      .findAll('[data-testid="project-config-tabs"] .project-config-tab span')
      .map((s) => s.text())
    const tabButtons = w.findAll('[data-testid^="project-config-tab-btn-"]')
    expect(tabButtons).toHaveLength(4)
    expect(labels.slice(0, 4)).toEqual([
      'Default mode',
      'Git & Sandbox',
      'Collaboration',
      'Skill repos',
    ])
  })

  it('assigns every config block to exactly one tab panel', () => {
    const w = mountWs(cfg(), { resolvedSpecRoot: '/home/u/.c3/specs/test' })
    // Marker testids that uniquely identify each config block, and the panel each
    // must live under. Each appears exactly once (no duplication) and under its tab.
    const membership: Record<string, string> = {
      'default-mode-claude': 'project-config-tab-defaultMode',
      'default-mode-codex-sandbox': 'project-config-tab-defaultMode',
      'git-branch-mode': 'project-config-tab-gitSandbox',
      'default-main-branch': 'project-config-tab-gitSandbox',
      'project-config-consensus-majority': 'project-config-tab-collab',
      'sdd-enabled': 'project-config-tab-collab',
      'project-config-add-skill-repo': 'project-config-tab-skillRepos',
    }
    for (const [block, panel] of Object.entries(membership)) {
      expect(w.findAll(`[data-testid="${block}"]`)).toHaveLength(1)
      expect(w.find(`[data-testid="${panel}"] [data-testid="${block}"]`).exists()).toBe(true)
    }
  })

  it('defaults to the default-mode tab and switches to a clean tab without confirmation', async () => {
    const w = mountWs(cfg())
    expect(panelHidden(w, 'project-config-tab-defaultMode')).toBe(false)
    expect(panelHidden(w, 'project-config-tab-collab')).toBe(true)
    await w.find('[data-testid="project-config-tab-btn-collab"]').trigger('click')
    // No dirty edits ⇒ immediate switch, no confirm dialog.
    expect(w.find('[data-testid="confirm-overlay"]').exists()).toBe(false)
    expect(panelHidden(w, 'project-config-tab-collab')).toBe(false)
    expect(panelHidden(w, 'project-config-tab-defaultMode')).toBe(true)
  })

  it('the sandbox worktree gate + SDD read-only spec root are unchanged inside their tabs', async () => {
    const w = mountWs(
      cfg({
        gitBranchMode: 'worktree',
        sddEnabled: true,
        sandbox: { enabled: true, sandbox: 'x' },
      }),
      {
        systemSandboxes: [{ name: 'x', type: 'docker', image: 'node' }],
        resolvedSpecRoot: '/home/u/.c3/specs/test',
      },
    )
    // Sandbox visible under worktree, inside the git-sandbox panel.
    expect(
      w
        .find(
          '[data-testid="project-config-tab-gitSandbox"] [data-testid="project-config-sandbox"]',
        )
        .exists(),
    ).toBe(true)
    // SDD spec root is a read-only <code> inside the collaboration panel.
    const specRoot = w.find(
      '[data-testid="project-config-tab-collab"] [data-testid="sdd-spec-root"]',
    )
    expect(specRoot.exists()).toBe(true)
    expect(specRoot.element.tagName).toBe('CODE')
  })

  it('the tab bar scrolls horizontally so all tabs stay reachable on mobile', () => {
    const vue = readFileSync(
      resolve(process.cwd(), 'web/src/pages/workspacesetting/WorkspaceSetting.vue'),
      'utf8',
    )
    expect(vue).toMatch(/\.project-config-tabs \{[^}]*overflow-x:\s*auto;/)
  })
})

describe('WorkspaceSetting.vue — per-tab dirty state', () => {
  it('starts clean on every tab (detected-branch prefill matches its baseline)', () => {
    const w = mountWs(cfg(), { detectedMainBranch: 'main' })
    for (const tab of ['defaultMode', 'gitSandbox', 'collab', 'skillRepos']) {
      expect(w.find(`[data-testid="project-config-tab-dirty-${tab}"]`).exists()).toBe(false)
    }
  })

  it('marks only the edited tab dirty, and clears it after that tab saves + echoes', async () => {
    const w = mountWs(cfg())
    // Edit a collaboration field.
    const inputs = w.findAll('.project-config-number')
    await inputs[0].setValue(20)
    expect(w.find('[data-testid="project-config-tab-dirty-collab"]').exists()).toBe(true)
    // Other tabs stay clean.
    expect(w.find('[data-testid="project-config-tab-dirty-defaultMode"]').exists()).toBe(false)
    expect(w.find('[data-testid="project-config-tab-dirty-gitSandbox"]').exists()).toBe(false)
    // Save collaboration, then simulate the server echo (workspace_setting pushback).
    await w.find(SAVE.collab).trigger('click')
    await w.setProps({ workspaceSetting: cfg({ maxRoundsPerStage: 20 }) })
    expect(w.find('[data-testid="project-config-tab-dirty-collab"]').exists()).toBe(false)
  })

  it('detects structural edits (adding a skill repo) as dirty', async () => {
    const w = mountWs(cfg())
    expect(w.find('[data-testid="project-config-tab-dirty-skillRepos"]').exists()).toBe(false)
    await w.find('[data-testid="project-config-add-skill-repo"]').trigger('click')
    expect(w.find('[data-testid="project-config-tab-dirty-skillRepos"]').exists()).toBe(true)
  })

  it('detects a sandbox enable toggle (git-sandbox) as dirty', async () => {
    const w = mountWs(cfg({ gitBranchMode: 'worktree' }), {
      systemSandboxes: [{ name: 'x', type: 'docker', image: 'node' }],
    })
    expect(w.find('[data-testid="project-config-tab-dirty-gitSandbox"]').exists()).toBe(false)
    await w.find('[data-testid="project-config-sandbox-enabled"]').setValue(true)
    expect(w.find('[data-testid="project-config-tab-dirty-gitSandbox"]').exists()).toBe(true)
  })
})

describe('WorkspaceSetting.vue — independent per-tab save', () => {
  it('saving one tab emits only that tab’s new values; other tabs use the committed value', async () => {
    const w = mountWs(cfg({ forge: 'gitlab' }))
    // Edit BOTH the default-mode tab (claude) and the collaboration tab (rounds).
    await w.find('[data-testid="default-mode-claude"]').setValue('default')
    const inputs = w.findAll('.project-config-number')
    await inputs[0].setValue(20)
    // Save only the default-mode tab.
    await w.find(SAVE.defaultMode).trigger('click')
    const saved = (w.emitted('save') as [WorkspaceSettingType][])[0][0]
    // default-mode's new value is present…
    expect((saved.defaultMode as Record<VendorId, unknown>).claude).toBe('default')
    // …but the collaboration draft (rounds 20) is NOT committed — payload keeps 14.
    expect(saved.maxRoundsPerStage).toBe(14)
    // …and the non-page `forge` field passes through untouched.
    expect(saved.forge).toBe('gitlab')
  })

  it('after the saved tab’s echo, the other dirty tab keeps its draft and dirty flag', async () => {
    const w = mountWs(cfg())
    await w.find('[data-testid="default-mode-claude"]').setValue('default')
    const inputs = w.findAll('.project-config-number')
    await inputs[0].setValue(20)
    // Save collaboration; server echoes it (rounds applied, defaultMode unchanged).
    await w.find(SAVE.collab).trigger('click')
    await w.setProps({ workspaceSetting: cfg({ maxRoundsPerStage: 20 }) })
    // Collaboration is now clean…
    expect(w.find('[data-testid="project-config-tab-dirty-collab"]').exists()).toBe(false)
    // …while the default-mode tab keeps its unsaved draft and stays dirty.
    expect((w.find('[data-testid="default-mode-claude"]').element as HTMLSelectElement).value).toBe(
      'default',
    )
    expect(w.find('[data-testid="project-config-tab-dirty-defaultMode"]').exists()).toBe(true)
  })

  it('an unrelated config pushback refreshes clean tabs without reseeding a dirty tab', async () => {
    const w = mountWs(cfg())
    // Dirty the default-mode tab.
    await w.find('[data-testid="default-mode-claude"]').setValue('default')
    // A pushback bumps a collaboration field (clean tab) — no pending save.
    await w.setProps({ workspaceSetting: cfg({ maxSpeechChars: 800 }) })
    // Clean collaboration tab follows the server…
    const inputs = w.findAll('.project-config-number')
    expect((inputs[1].element as HTMLInputElement).value).toBe('800')
    // …and the dirty default-mode draft survives.
    expect((w.find('[data-testid="default-mode-claude"]').element as HTMLSelectElement).value).toBe(
      'default',
    )
    expect(w.find('[data-testid="project-config-tab-dirty-defaultMode"]').exists()).toBe(true)
  })

  it('saving a non-git tab preserves the committed sandbox and does not clear it', async () => {
    const w = mountWs(
      cfg({ gitBranchMode: 'worktree', sandbox: { enabled: true, sandbox: 'x' } }),
      { systemSandboxes: [{ name: 'x', type: 'docker', image: 'node' }] },
    )
    // Save the collaboration tab — the committed sandbox must pass through intact.
    await w.find(SAVE.collab).trigger('click')
    const payload = (w.emitted('save') as [WorkspaceSettingType][])[0][0]
    expect(payload.sandbox?.enabled).toBe(true)
    expect(payload.sandbox?.sandbox).toBe('x')
  })

  it('saving a second tab before the first save echoes does not revert the first save', async () => {
    const w = mountWs(cfg())
    // Save the default-mode tab with an edited value…
    await w.find('[data-testid="default-mode-claude"]').setValue('default')
    await w.find(SAVE.defaultMode).trigger('click')
    // …then, WITHOUT the server echo arriving, edit + save the collaboration tab.
    const inputs = w.findAll('.project-config-number')
    await inputs[0].setValue(20)
    await w.find(SAVE.collab).trigger('click')
    // The second payload must carry the first save's default-mode value (not the
    // stale committed one), or the second save would silently revert the first.
    const emitted = w.emitted('save') as [WorkspaceSettingType][]
    expect(emitted).toHaveLength(2)
    expect((emitted[1][0].defaultMode as Record<VendorId, unknown>).claude).toBe('default')
    expect(emitted[1][0].maxRoundsPerStage).toBe(20)
    // And the saved default-mode tab's dirty flag clears optimistically (no lingering
    // "unsaved" dot before the echo).
    expect(w.find('[data-testid="project-config-tab-dirty-defaultMode"]').exists()).toBe(false)
  })
})

describe('WorkspaceSetting.vue — dirty-tab switch confirmation', () => {
  it('cancelling the confirm keeps the current tab and its draft', async () => {
    const w = mountWs(cfg())
    await w.find('[data-testid="default-mode-claude"]').setValue('default') // dirty defaultMode
    await w.find('[data-testid="project-config-tab-btn-collab"]').trigger('click')
    // Confirm appears; still on default-mode.
    expect(w.find('[data-testid="confirm-overlay"]').exists()).toBe(true)
    expect(panelHidden(w, 'project-config-tab-defaultMode')).toBe(false)
    await w.find('[data-testid="confirm-cancel"]').trigger('click')
    // Stayed on default-mode, draft intact.
    expect(w.find('[data-testid="confirm-overlay"]').exists()).toBe(false)
    expect(panelHidden(w, 'project-config-tab-defaultMode')).toBe(false)
    expect((w.find('[data-testid="default-mode-claude"]').element as HTMLSelectElement).value).toBe(
      'default',
    )
  })

  it('confirming switches tabs and preserves the leaving tab’s draft for later editing', async () => {
    const w = mountWs(cfg())
    await w.find('[data-testid="default-mode-claude"]').setValue('default') // dirty defaultMode
    await w.find('[data-testid="project-config-tab-btn-collab"]').trigger('click')
    await w.find('[data-testid="confirm-accept"]').trigger('click')
    // Switched to collaboration.
    expect(panelHidden(w, 'project-config-tab-collab')).toBe(false)
    expect(panelHidden(w, 'project-config-tab-defaultMode')).toBe(true)
    // default-mode draft neither saved nor discarded: still dirty, no save emitted.
    expect(w.find('[data-testid="project-config-tab-dirty-defaultMode"]').exists()).toBe(true)
    expect(w.emitted('save')).toBeUndefined()
    // Returning to default-mode (clean collaboration ⇒ no confirm) shows the draft.
    await w.find('[data-testid="project-config-tab-btn-defaultMode"]').trigger('click')
    expect((w.find('[data-testid="default-mode-claude"]').element as HTMLSelectElement).value).toBe(
      'default',
    )
  })
})
