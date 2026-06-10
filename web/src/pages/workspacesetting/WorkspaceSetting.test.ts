import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import WorkspaceSetting from './WorkspaceSetting.vue'
import type {
  WorkspaceSetting as WorkspaceSettingType,
  SkillRepoConfig,
  VendorId,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  ModeToken,
  VendorModeCatalog,
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
  opencode: {
    vendor: 'opencode',
    defaultToken: 'build',
    modes: [
      {
        token: 'plan',
        labelCode: 'nav.mode.plan.label',
        actionMode: 'plan',
        toolGate: 'on-sensitive',
      },
      {
        token: 'build',
        labelCode: 'nav.mode.build.label',
        actionMode: 'build',
        toolGate: 'on-sensitive',
      },
      {
        token: 'build-allow',
        labelCode: 'nav.mode.buildAllow.label',
        actionMode: 'build',
        toolGate: 'never-ask',
      },
    ],
  },
}

/** Convenience: per-vendor config with the given claude token. */
function cfg(overrides?: Partial<WorkspaceSettingType>): WorkspaceSettingType {
  return {
    defaultMode: { claude: 'plan', codex: 'auto', opencode: 'build' },
    devSkill: '/my-skill',
    maxRoundsPerStage: 14,
    maxSpeechChars: 400,
    consensus: { enabled: true, majority: true },
    ...overrides,
  }
}

describe('WorkspaceSetting.vue — per-vendor default mode', () => {
  it('renders a mode select for each vendor in correct order', () => {
    const w = mount(WorkspaceSetting, {
      props: {
        open: true,
        workspaceSetting: null,
        detectedMainBranch: null,
        currentWorkspace: '/test',
        vendorModes: MOCK_VENDOR_MODES,
        systemSandboxes: [],
      },
    })
    // 2 codex policy selects (sandbox + approval) + 1 claude + 1 opencode
    // + 1 git-commit-mode select = 5
    const selects = w.findAll('.mode-select')
    expect(selects).toHaveLength(5)
    // Claude + OpenCode still have a mode select; Codex uses dual-policy selects.
    expect(w.findAll('[data-testid="default-mode-claude"]').length).toBe(1)
    expect(w.findAll('[data-testid="default-mode-codex-sandbox"]').length).toBe(1)
    expect(w.findAll('[data-testid="default-mode-codex-approval"]').length).toBe(1)
    expect(w.findAll('[data-testid="default-mode-opencode"]').length).toBe(1)
  })

  it('seeds each vendor select from per-vendor project config', () => {
    const w = mount(WorkspaceSetting, {
      props: {
        open: true,
        workspaceSetting: cfg(),
        detectedMainBranch: null,
        currentWorkspace: '/test',
        vendorModes: MOCK_VENDOR_MODES,
        systemSandboxes: [],
      },
    })
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
    expect(
      (w.find('[data-testid="default-mode-opencode"]').element as HTMLSelectElement).value,
    ).toBe('build')
  })

  it('defaults each vendor to the catalog defaultToken when config omits defaultMode', () => {
    const w = mount(WorkspaceSetting, {
      props: {
        open: true,
        workspaceSetting: {},
        detectedMainBranch: null,
        currentWorkspace: '/test',
        vendorModes: MOCK_VENDOR_MODES,
        systemSandboxes: [],
      },
    })
    // catalog defaultTokens: claude='default', codex='auto', opencode='build'
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
    expect(
      (w.find('[data-testid="default-mode-opencode"]').element as HTMLSelectElement).value,
    ).toBe('build')
  })

  it('renders vendor-specific mode options (not the full cross-vendor set)', () => {
    const w = mount(WorkspaceSetting, {
      props: {
        open: true,
        workspaceSetting: null,
        detectedMainBranch: null,
        currentWorkspace: '/test',
        vendorModes: MOCK_VENDOR_MODES,
        systemSandboxes: [],
      },
    })
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
    const w = mount(WorkspaceSetting, {
      props: {
        open: true,
        workspaceSetting: null,
        detectedMainBranch: null,
        currentWorkspace: '/test',
        vendorModes: MOCK_VENDOR_MODES,
        systemSandboxes: [],
      },
    })
    // 3 vendor row-labels + devSkill + rounds + speechChars
    // + gitCommitMode + defaultMainBranch = 8
    const labels = w.findAll('.project-config-row-label')
    expect(labels).toHaveLength(8)
    expect(labels[0].text()).toBeTruthy()
  })

  it('emits the entire per-vendor map on save', async () => {
    const w = mount(WorkspaceSetting, {
      props: {
        open: true,
        workspaceSetting: cfg(),
        detectedMainBranch: null,
        currentWorkspace: '/test',
        vendorModes: MOCK_VENDOR_MODES,
        systemSandboxes: [],
      },
    })
    await w.find('[data-testid="project-config-save"]').trigger('click')
    const emitted = w.emitted('save') as [WorkspaceSettingType][]
    expect(emitted).toBeTruthy()
    const payload = emitted[0][0]
    expect(payload.defaultMode).toEqual({
      claude: 'plan',
      codex: { sandboxMode: 'workspace-write', approvalPolicy: 'on-request' },
      opencode: 'build',
    })
  })

  it('emits the edited per-vendor value on save after changing one vendor', async () => {
    const w = mount(WorkspaceSetting, {
      props: {
        open: true,
        workspaceSetting: cfg(),
        detectedMainBranch: null,
        currentWorkspace: '/test',
        vendorModes: MOCK_VENDOR_MODES,
        systemSandboxes: [],
      },
    })
    await w.find('[data-testid="default-mode-claude"]').setValue('default')
    await w.find('[data-testid="project-config-save"]').trigger('click')
    const emitted = w.emitted('save') as [WorkspaceSettingType][]
    const payload = emitted[0][0]
    expect((payload.defaultMode as Record<VendorId, unknown>).claude).toBe('default')
    expect((payload.defaultMode as Record<VendorId, unknown>).codex).toEqual({
      sandboxMode: 'workspace-write',
      approvalPolicy: 'on-request',
    })
  })
})

describe('WorkspaceSetting.vue — dev skill', () => {
  it('seeds the dev skill input from project config', () => {
    const w = mount(WorkspaceSetting, {
      props: {
        open: true,
        workspaceSetting: cfg(),
        detectedMainBranch: null,
        currentWorkspace: '/test',
        vendorModes: MOCK_VENDOR_MODES,
        systemSandboxes: [],
      },
    })
    const inputs = w.findAll('.project-config-field')
    const skillInput = inputs.find((el) => (el.element as HTMLInputElement).type !== 'number')
    expect(skillInput?.exists()).toBe(true)
    expect((skillInput?.element as HTMLInputElement).value).toBe('/my-skill')
  })

  it('defaults dev skill to empty string when config omits it', () => {
    const w = mount(WorkspaceSetting, {
      props: {
        open: true,
        workspaceSetting: {},
        detectedMainBranch: null,
        currentWorkspace: '/test',
        vendorModes: MOCK_VENDOR_MODES,
        systemSandboxes: [],
      },
    })
    const inputs = w.findAll('.project-config-field')
    const skillInput = inputs.find((el) => (el.element as HTMLInputElement).type !== 'number')
    expect((skillInput?.element as HTMLInputElement).value ?? '').toBe('')
  })
})

describe('WorkspaceSetting.vue — discussion rounds per stage', () => {
  it('seeds the rounds input from project config', () => {
    const w = mount(WorkspaceSetting, {
      props: {
        open: true,
        workspaceSetting: cfg(),
        detectedMainBranch: null,
        currentWorkspace: '/test',
        vendorModes: MOCK_VENDOR_MODES,
        systemSandboxes: [],
      },
    })
    const inputs = w.findAll('.project-config-number')
    expect(inputs.length).toBeGreaterThanOrEqual(1)
    expect((inputs[0].element as HTMLInputElement).value).toBe('14')
  })

  it('defaults the rounds input when config omits the field', () => {
    const w = mount(WorkspaceSetting, {
      props: {
        open: true,
        workspaceSetting: cfg({ maxRoundsPerStage: undefined }),
        detectedMainBranch: null,
        currentWorkspace: '/test',
        vendorModes: MOCK_VENDOR_MODES,
        systemSandboxes: [],
      },
    })
    const inputs = w.findAll('.project-config-number')
    expect((inputs[0].element as HTMLInputElement).value).toBe('12')
  })

  it('emits the edited rounds value on save', async () => {
    const w = mount(WorkspaceSetting, {
      props: {
        open: true,
        workspaceSetting: cfg(),
        detectedMainBranch: null,
        currentWorkspace: '/test',
        vendorModes: MOCK_VENDOR_MODES,
        systemSandboxes: [],
      },
    })
    const inputs = w.findAll('.project-config-number')
    await inputs[0].setValue(20)
    await w.find('[data-testid="project-config-save"]').trigger('click')
    const emitted = w.emitted('save') as [WorkspaceSettingType][]
    expect(emitted).toBeTruthy()
    expect(emitted[0][0].maxRoundsPerStage).toBe(20)
  })
})

describe('WorkspaceSetting.vue — discussion speech character limit', () => {
  it('seeds the speech-chars input from project config', () => {
    const w = mount(WorkspaceSetting, {
      props: {
        open: true,
        workspaceSetting: cfg(),
        detectedMainBranch: null,
        currentWorkspace: '/test',
        vendorModes: MOCK_VENDOR_MODES,
        systemSandboxes: [],
      },
    })
    const inputs = w.findAll('.project-config-number')
    expect(inputs.length).toBeGreaterThanOrEqual(2)
    expect((inputs[1].element as HTMLInputElement).value).toBe('400')
  })

  it('defaults the speech-chars input when config omits the field', () => {
    const w = mount(WorkspaceSetting, {
      props: {
        open: true,
        workspaceSetting: cfg({ maxSpeechChars: undefined }),
        detectedMainBranch: null,
        currentWorkspace: '/test',
        vendorModes: MOCK_VENDOR_MODES,
        systemSandboxes: [],
      },
    })
    const inputs = w.findAll('.project-config-number')
    expect((inputs[1].element as HTMLInputElement).value).toBe('300')
  })

  it('emits the edited speech-chars value on save', async () => {
    const w = mount(WorkspaceSetting, {
      props: {
        open: true,
        workspaceSetting: cfg(),
        detectedMainBranch: null,
        currentWorkspace: '/test',
        vendorModes: MOCK_VENDOR_MODES,
        systemSandboxes: [],
      },
    })
    const inputs = w.findAll('.project-config-number')
    await inputs[1].setValue(600)
    await w.find('[data-testid="project-config-save"]').trigger('click')
    const emitted = w.emitted('save') as [WorkspaceSettingType][]
    expect(emitted).toBeTruthy()
    expect(emitted[0][0].maxSpeechChars).toBe(600)
  })
})

describe('WorkspaceSetting.vue — consensus majority toggle', () => {
  it('seeds the majority checkbox from project config', () => {
    const w = mount(WorkspaceSetting, {
      props: {
        open: true,
        workspaceSetting: cfg(),
        detectedMainBranch: null,
        currentWorkspace: '/test',
        vendorModes: MOCK_VENDOR_MODES,
        systemSandboxes: [],
      },
    })
    const box = w.find('[data-testid="project-config-consensus-majority"]')
    expect(box.exists()).toBe(true)
    expect((box.element as HTMLInputElement).checked).toBe(true)
  })

  it('defaults the majority checkbox to false when config omits it', () => {
    const w = mount(WorkspaceSetting, {
      props: {
        open: true,
        workspaceSetting: { consensus: { enabled: true } },
        detectedMainBranch: null,
        currentWorkspace: '/test',
        vendorModes: MOCK_VENDOR_MODES,
        systemSandboxes: [],
      },
    })
    expect(
      (w.find('[data-testid="project-config-consensus-majority"]').element as HTMLInputElement)
        .checked,
    ).toBe(false)
  })

  it('emits the toggled majority value on save', async () => {
    const w = mount(WorkspaceSetting, {
      props: {
        open: true,
        workspaceSetting: cfg(),
        detectedMainBranch: null,
        currentWorkspace: '/test',
        vendorModes: MOCK_VENDOR_MODES,
        systemSandboxes: [],
      },
    })
    await w.find('[data-testid="project-config-consensus-majority"]').setValue(false)
    await w.find('[data-testid="project-config-save"]').trigger('click')
    const emitted = w.emitted('save') as [WorkspaceSettingType][]
    expect(emitted[0][0].consensus?.majority).toBe(false)
  })
})

describe('WorkspaceSetting.vue — save emits full payload', () => {
  it('emits the entire draft on save', async () => {
    const w = mount(WorkspaceSetting, {
      props: {
        open: true,
        workspaceSetting: cfg(),
        detectedMainBranch: null,
        currentWorkspace: '/test',
        vendorModes: MOCK_VENDOR_MODES,
        systemSandboxes: [],
      },
    })
    await w.find('[data-testid="project-config-save"]').trigger('click')
    const emitted = w.emitted('save') as [WorkspaceSettingType][]
    expect(emitted).toBeTruthy()
    const payload = emitted[0][0]
    expect(payload.defaultMode).toEqual({
      claude: 'plan',
      codex: { sandboxMode: 'workspace-write', approvalPolicy: 'on-request' },
      opencode: 'build',
    })
    expect(payload.devSkill).toBe('/my-skill')
    expect(payload.maxRoundsPerStage).toBe(14)
    expect(payload.maxSpeechChars).toBe(400)
    expect(payload.consensus?.enabled).toBe(true)
    expect(payload.consensus?.majority).toBe(true)
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
    const w = mount(WorkspaceSetting, {
      props: {
        open: true,
        workspaceSetting: configWithSkillRepos,
        detectedMainBranch: null,
        currentWorkspace: '/test',
        vendorModes: MOCK_VENDOR_MODES,
        systemSandboxes: [],
      },
    })
    const rows = w.findAll('[data-testid="skill-repo-row"]')
    expect(rows).toHaveLength(2)
  })

  it('shows an empty hint when skillRepos is empty', () => {
    const w = mount(WorkspaceSetting, {
      props: {
        open: true,
        workspaceSetting: cfg(),
        detectedMainBranch: null,
        currentWorkspace: '/test',
        vendorModes: MOCK_VENDOR_MODES,
        systemSandboxes: [],
      },
    })
    expect(w.text()).toContain('No external skill repositories configured.')
  })

  it('adds a new row on + Add skill repo', async () => {
    const w = mount(WorkspaceSetting, {
      props: {
        open: true,
        workspaceSetting: cfg(),
        detectedMainBranch: null,
        currentWorkspace: '/test',
        vendorModes: MOCK_VENDOR_MODES,
        systemSandboxes: [],
      },
    })
    await w.find('[data-testid="project-config-add-skill-repo"]').trigger('click')
    const rows = w.findAll('[data-testid="skill-repo-row"]')
    expect(rows).toHaveLength(1)
  })

  it('removes a row on click', async () => {
    const w = mount(WorkspaceSetting, {
      props: {
        open: true,
        workspaceSetting: configWithSkillRepos,
        detectedMainBranch: null,
        currentWorkspace: '/test',
        vendorModes: MOCK_VENDOR_MODES,
        systemSandboxes: [],
      },
    })
    const removes = w.findAll('[data-testid="skill-repo-remove"]')
    expect(removes).toHaveLength(2)
    await removes[0].trigger('click')
    expect(w.findAll('[data-testid="skill-repo-row"]')).toHaveLength(1)
  })

  it('shows ref required error when ref is empty', () => {
    const w = mount(WorkspaceSetting, {
      props: {
        open: true,
        workspaceSetting: {
          ...cfg(),
          skillRepos: [
            {
              id: 's',
              repo: '',
              ref: '',
            } as SkillRepoConfig,
          ],
        },
        detectedMainBranch: null,
        currentWorkspace: '/test',
        vendorModes: MOCK_VENDOR_MODES,
        systemSandboxes: [],
      },
    })
    const errors = w.findAll('[data-testid="skill-repo-ref-error"]')
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0].text()).toBeTruthy()
  })

  it('renders only id/repo/ref/subpath fields (no vendor/trust/pin controls)', () => {
    const w = mount(WorkspaceSetting, {
      props: {
        open: true,
        workspaceSetting: configWithSkillRepos,
        detectedMainBranch: null,
        currentWorkspace: '/test',
        vendorModes: MOCK_VENDOR_MODES,
        systemSandboxes: [],
      },
    })
    expect(w.find('[data-testid="skill-repo-vendor"]').exists()).toBe(false)
    expect(w.find('[data-testid="skill-repo-trust"]').exists()).toBe(false)
    expect(w.find('[data-testid="skill-repo-pin-commit"]').exists()).toBe(false)
  })

  it('carries the edited skillRepos into the Save payload', async () => {
    const w = mount(WorkspaceSetting, {
      props: {
        open: true,
        workspaceSetting: configWithSkillRepos,
        detectedMainBranch: null,
        currentWorkspace: '/test',
        vendorModes: MOCK_VENDOR_MODES,
        systemSandboxes: [],
      },
    })
    const inputs = w.findAll('[data-testid="skill-repo-ref"]')
    await inputs[0].setValue('develop')
    await w.find('[data-testid="project-config-save"]').trigger('click')
    const emitted = w.emitted('save') as [WorkspaceSettingType][]
    expect(emitted[0][0].skillRepos?.[0]?.ref).toBe('develop')
  })
})

describe('WorkspaceSetting.vue — git commit mode + default main branch', () => {
  it('defaults to current-branch with an empty branch when config is null', () => {
    const w = mount(WorkspaceSetting, {
      props: {
        open: true,
        workspaceSetting: null,
        detectedMainBranch: null,
        currentWorkspace: '/test',
        vendorModes: MOCK_VENDOR_MODES,
        systemSandboxes: [],
      },
    })
    expect((w.find('[data-testid="git-commit-mode"]').element as HTMLSelectElement).value).toBe(
      'current-branch',
    )
    expect((w.find('[data-testid="default-main-branch"]').element as HTMLInputElement).value).toBe(
      '',
    )
  })

  it('pre-fills the branch from detectedMainBranch when config has none', () => {
    const w = mount(WorkspaceSetting, {
      props: {
        open: true,
        workspaceSetting: cfg(),
        detectedMainBranch: 'main',
        currentWorkspace: '/test',
        vendorModes: MOCK_VENDOR_MODES,
        systemSandboxes: [],
      },
    })
    expect((w.find('[data-testid="default-main-branch"]').element as HTMLInputElement).value).toBe(
      'main',
    )
  })

  it('a saved branch value wins over the detected one', () => {
    const w = mount(WorkspaceSetting, {
      props: {
        open: true,
        workspaceSetting: cfg({ gitCommitMode: 'worktree', defaultMainBranch: 'develop' }),
        detectedMainBranch: 'main',
        currentWorkspace: '/test',
        vendorModes: MOCK_VENDOR_MODES,
        systemSandboxes: [],
      },
    })
    expect((w.find('[data-testid="git-commit-mode"]').element as HTMLSelectElement).value).toBe(
      'worktree',
    )
    expect((w.find('[data-testid="default-main-branch"]').element as HTMLInputElement).value).toBe(
      'develop',
    )
  })

  it('emits the edited git commit mode + branch on save', async () => {
    const w = mount(WorkspaceSetting, {
      props: {
        open: true,
        workspaceSetting: cfg(),
        detectedMainBranch: null,
        currentWorkspace: '/test',
        vendorModes: MOCK_VENDOR_MODES,
        systemSandboxes: [],
      },
    })
    await w.find('[data-testid="git-commit-mode"]').setValue('worktree')
    await w.find('[data-testid="default-main-branch"]').setValue('release')
    await w.find('[data-testid="project-config-save"]').trigger('click')
    const emitted = w.emitted('save') as [WorkspaceSettingType][]
    const payload = emitted[0][0]
    expect(payload.gitCommitMode).toBe('worktree')
    expect(payload.defaultMainBranch).toBe('release')
  })

  it('emits an undefined branch when the input is blank', async () => {
    const w = mount(WorkspaceSetting, {
      props: {
        open: true,
        workspaceSetting: cfg({ gitCommitMode: 'worktree', defaultMainBranch: '   ' }),
        detectedMainBranch: null,
        currentWorkspace: '/test',
        vendorModes: MOCK_VENDOR_MODES,
        systemSandboxes: [],
      },
    })
    await w.find('[data-testid="project-config-save"]').trigger('click')
    const emitted = w.emitted('save') as [WorkspaceSettingType][]
    expect(emitted[0][0].defaultMainBranch).toBeUndefined()
  })
})
