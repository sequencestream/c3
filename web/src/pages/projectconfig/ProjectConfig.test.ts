import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import ProjectConfig from './ProjectConfig.vue'
import type {
  ProjectConfig as ProjectConfigType,
  SkillRepoConfig,
  VendorId,
  VendorModeCatalog,
  ModeToken,
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
function cfg(overrides?: Partial<ProjectConfigType>): ProjectConfigType {
  return {
    defaultMode: { claude: 'plan', codex: 'auto', opencode: 'build' },
    devSkill: '/my-skill',
    maxRoundsPerStage: 14,
    maxSpeechChars: 400,
    consensus: { enabled: true, majority: true },
    ...overrides,
  }
}

describe('ProjectConfig.vue — per-vendor default mode', () => {
  it('renders a mode select for each vendor in correct order', () => {
    const w = mount(ProjectConfig, {
      props: {
        open: true,
        projectConfig: null,
        currentWorkspace: '/test',
        vendorModes: MOCK_VENDOR_MODES,
      },
    })
    const selects = w.findAll('.mode-select')
    expect(selects).toHaveLength(3)
    // Order: claude, codex, opencode
    expect(w.findAll('[data-testid="default-mode-claude"]').length).toBe(1)
    expect(w.findAll('[data-testid="default-mode-codex"]').length).toBe(1)
    expect(w.findAll('[data-testid="default-mode-opencode"]').length).toBe(1)
  })

  it('seeds each vendor select from per-vendor project config', () => {
    const w = mount(ProjectConfig, {
      props: {
        open: true,
        projectConfig: cfg(),
        currentWorkspace: '/test',
        vendorModes: MOCK_VENDOR_MODES,
      },
    })
    expect((w.find('[data-testid="default-mode-claude"]').element as HTMLSelectElement).value).toBe(
      'plan',
    )
    expect((w.find('[data-testid="default-mode-codex"]').element as HTMLSelectElement).value).toBe(
      'auto',
    )
    expect(
      (w.find('[data-testid="default-mode-opencode"]').element as HTMLSelectElement).value,
    ).toBe('build')
  })

  it('defaults each vendor to the catalog defaultToken when config omits defaultMode', () => {
    const w = mount(ProjectConfig, {
      props: {
        open: true,
        projectConfig: {},
        currentWorkspace: '/test',
        vendorModes: MOCK_VENDOR_MODES,
      },
    })
    // catalog defaultTokens: claude='default', codex='auto', opencode='build'
    expect((w.find('[data-testid="default-mode-claude"]').element as HTMLSelectElement).value).toBe(
      'default',
    )
    expect((w.find('[data-testid="default-mode-codex"]').element as HTMLSelectElement).value).toBe(
      'auto',
    )
    expect(
      (w.find('[data-testid="default-mode-opencode"]').element as HTMLSelectElement).value,
    ).toBe('build')
  })

  it('renders vendor-specific mode options (not the full cross-vendor set)', () => {
    const w = mount(ProjectConfig, {
      props: {
        open: true,
        projectConfig: null,
        currentWorkspace: '/test',
        vendorModes: MOCK_VENDOR_MODES,
      },
    })
    // claude menu: 'default', 'plan'
    const claudeOpts = w
      .find('[data-testid="default-mode-claude"]')
      .findAll('option')
      .map((o) => o.attributes('value'))
    expect(claudeOpts).toEqual(['default', 'plan'])

    // codex menu: 'read-only', 'auto', 'full-access'
    const codexOpts = w
      .find('[data-testid="default-mode-codex"]')
      .findAll('option')
      .map((o) => o.attributes('value'))
    expect(codexOpts).toEqual(['read-only', 'auto', 'full-access'])
  })

  it('renders a vendor section heading for each vendor', () => {
    const w = mount(ProjectConfig, {
      props: {
        open: true,
        projectConfig: null,
        currentWorkspace: '/test',
        vendorModes: MOCK_VENDOR_MODES,
      },
    })
    // Section labels come from i18n; just confirm the CSS class exists.
    const labels = w.findAll('.project-config-vendor-label')
    expect(labels).toHaveLength(3)
    expect(labels[0].text()).toBeTruthy()
  })

  it('emits the entire per-vendor map on save', async () => {
    const w = mount(ProjectConfig, {
      props: {
        open: true,
        projectConfig: cfg(),
        currentWorkspace: '/test',
        vendorModes: MOCK_VENDOR_MODES,
      },
    })
    await w.find('[data-testid="project-config-save"]').trigger('click')
    const emitted = w.emitted('save') as [ProjectConfigType][]
    expect(emitted).toBeTruthy()
    const payload = emitted[0][0]
    expect(payload.defaultMode).toEqual({
      claude: 'plan',
      codex: 'auto',
      opencode: 'build',
    })
  })

  it('emits the edited per-vendor value on save after changing one vendor', async () => {
    const w = mount(ProjectConfig, {
      props: {
        open: true,
        projectConfig: cfg(),
        currentWorkspace: '/test',
        vendorModes: MOCK_VENDOR_MODES,
      },
    })
    await w.find('[data-testid="default-mode-claude"]').setValue('default')
    await w.find('[data-testid="project-config-save"]').trigger('click')
    const emitted = w.emitted('save') as [ProjectConfigType][]
    const payload = emitted[0][0]
    expect((payload.defaultMode as Record<VendorId, ModeToken>).claude).toBe('default')
    expect((payload.defaultMode as Record<VendorId, ModeToken>).codex).toBe('auto')
  })
})

describe('ProjectConfig.vue — dev skill', () => {
  it('seeds the dev skill input from project config', () => {
    const w = mount(ProjectConfig, {
      props: {
        open: true,
        projectConfig: cfg(),
        currentWorkspace: '/test',
        vendorModes: MOCK_VENDOR_MODES,
      },
    })
    const inputs = w.findAll('.project-config-field')
    const skillInput = inputs.find((el) => (el.element as HTMLInputElement).type !== 'number')
    expect(skillInput?.exists()).toBe(true)
    expect((skillInput?.element as HTMLInputElement).value).toBe('/my-skill')
  })

  it('defaults dev skill to empty string when config omits it', () => {
    const w = mount(ProjectConfig, {
      props: {
        open: true,
        projectConfig: {},
        currentWorkspace: '/test',
        vendorModes: MOCK_VENDOR_MODES,
      },
    })
    const inputs = w.findAll('.project-config-field')
    const skillInput = inputs.find((el) => (el.element as HTMLInputElement).type !== 'number')
    expect((skillInput?.element as HTMLInputElement).value ?? '').toBe('')
  })
})

describe('ProjectConfig.vue — discussion rounds per stage', () => {
  it('seeds the rounds input from project config', () => {
    const w = mount(ProjectConfig, {
      props: {
        open: true,
        projectConfig: cfg(),
        currentWorkspace: '/test',
        vendorModes: MOCK_VENDOR_MODES,
      },
    })
    const inputs = w.findAll('.project-config-number')
    expect(inputs.length).toBeGreaterThanOrEqual(1)
    expect((inputs[0].element as HTMLInputElement).value).toBe('14')
  })

  it('defaults the rounds input when config omits the field', () => {
    const w = mount(ProjectConfig, {
      props: {
        open: true,
        projectConfig: cfg({ maxRoundsPerStage: undefined }),
        currentWorkspace: '/test',
        vendorModes: MOCK_VENDOR_MODES,
      },
    })
    const inputs = w.findAll('.project-config-number')
    expect((inputs[0].element as HTMLInputElement).value).toBe('12')
  })

  it('emits the edited rounds value on save', async () => {
    const w = mount(ProjectConfig, {
      props: {
        open: true,
        projectConfig: cfg(),
        currentWorkspace: '/test',
        vendorModes: MOCK_VENDOR_MODES,
      },
    })
    const inputs = w.findAll('.project-config-number')
    await inputs[0].setValue(20)
    await w.find('[data-testid="project-config-save"]').trigger('click')
    const emitted = w.emitted('save') as [ProjectConfigType][]
    expect(emitted).toBeTruthy()
    expect(emitted[0][0].maxRoundsPerStage).toBe(20)
  })
})

describe('ProjectConfig.vue — discussion speech character limit', () => {
  it('seeds the speech-chars input from project config', () => {
    const w = mount(ProjectConfig, {
      props: {
        open: true,
        projectConfig: cfg(),
        currentWorkspace: '/test',
        vendorModes: MOCK_VENDOR_MODES,
      },
    })
    const inputs = w.findAll('.project-config-number')
    expect(inputs.length).toBeGreaterThanOrEqual(2)
    expect((inputs[1].element as HTMLInputElement).value).toBe('400')
  })

  it('defaults the speech-chars input when config omits the field', () => {
    const w = mount(ProjectConfig, {
      props: {
        open: true,
        projectConfig: cfg({ maxSpeechChars: undefined }),
        currentWorkspace: '/test',
        vendorModes: MOCK_VENDOR_MODES,
      },
    })
    const inputs = w.findAll('.project-config-number')
    expect((inputs[1].element as HTMLInputElement).value).toBe('300')
  })

  it('emits the edited speech-chars value on save', async () => {
    const w = mount(ProjectConfig, {
      props: {
        open: true,
        projectConfig: cfg(),
        currentWorkspace: '/test',
        vendorModes: MOCK_VENDOR_MODES,
      },
    })
    const inputs = w.findAll('.project-config-number')
    await inputs[1].setValue(600)
    await w.find('[data-testid="project-config-save"]').trigger('click')
    const emitted = w.emitted('save') as [ProjectConfigType][]
    expect(emitted).toBeTruthy()
    expect(emitted[0][0].maxSpeechChars).toBe(600)
  })
})

describe('ProjectConfig.vue — consensus majority toggle', () => {
  it('seeds the majority checkbox from project config', () => {
    const w = mount(ProjectConfig, {
      props: {
        open: true,
        projectConfig: cfg(),
        currentWorkspace: '/test',
        vendorModes: MOCK_VENDOR_MODES,
      },
    })
    const box = w.find('[data-testid="project-config-consensus-majority"]')
    expect(box.exists()).toBe(true)
    expect((box.element as HTMLInputElement).checked).toBe(true)
  })

  it('defaults the majority checkbox to false when config omits it', () => {
    const w = mount(ProjectConfig, {
      props: {
        open: true,
        projectConfig: { consensus: { enabled: true } },
        currentWorkspace: '/test',
        vendorModes: MOCK_VENDOR_MODES,
      },
    })
    expect(
      (w.find('[data-testid="project-config-consensus-majority"]').element as HTMLInputElement)
        .checked,
    ).toBe(false)
  })

  it('emits the toggled majority value on save', async () => {
    const w = mount(ProjectConfig, {
      props: {
        open: true,
        projectConfig: cfg(),
        currentWorkspace: '/test',
        vendorModes: MOCK_VENDOR_MODES,
      },
    })
    await w.find('[data-testid="project-config-consensus-majority"]').setValue(false)
    await w.find('[data-testid="project-config-save"]').trigger('click')
    const emitted = w.emitted('save') as [ProjectConfigType][]
    expect(emitted[0][0].consensus?.majority).toBe(false)
  })
})

describe('ProjectConfig.vue — save emits full payload', () => {
  it('emits the entire draft on save', async () => {
    const w = mount(ProjectConfig, {
      props: {
        open: true,
        projectConfig: cfg(),
        currentWorkspace: '/test',
        vendorModes: MOCK_VENDOR_MODES,
      },
    })
    await w.find('[data-testid="project-config-save"]').trigger('click')
    const emitted = w.emitted('save') as [ProjectConfigType][]
    expect(emitted).toBeTruthy()
    const payload = emitted[0][0]
    expect(payload.defaultMode).toEqual({
      claude: 'plan',
      codex: 'auto',
      opencode: 'build',
    })
    expect(payload.devSkill).toBe('/my-skill')
    expect(payload.maxRoundsPerStage).toBe(14)
    expect(payload.maxSpeechChars).toBe(400)
    expect(payload.consensus?.enabled).toBe(true)
    expect(payload.consensus?.majority).toBe(true)
  })
})

describe('ProjectConfig.vue — external skill repos (ADR-0016/0017)', () => {
  const configWithSkillRepos: ProjectConfigType = {
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
    const w = mount(ProjectConfig, {
      props: {
        open: true,
        projectConfig: configWithSkillRepos,
        currentWorkspace: '/test',
        vendorModes: MOCK_VENDOR_MODES,
      },
    })
    const rows = w.findAll('[data-testid="skill-repo-row"]')
    expect(rows).toHaveLength(2)
  })

  it('shows an empty hint when skillRepos is empty', () => {
    const w = mount(ProjectConfig, {
      props: {
        open: true,
        projectConfig: cfg(),
        currentWorkspace: '/test',
        vendorModes: MOCK_VENDOR_MODES,
      },
    })
    expect(w.text()).toContain('No external skill repositories configured.')
  })

  it('adds a new row on + Add skill repo', async () => {
    const w = mount(ProjectConfig, {
      props: {
        open: true,
        projectConfig: cfg(),
        currentWorkspace: '/test',
        vendorModes: MOCK_VENDOR_MODES,
      },
    })
    await w.find('[data-testid="project-config-add-skill-repo"]').trigger('click')
    const rows = w.findAll('[data-testid="skill-repo-row"]')
    expect(rows).toHaveLength(1)
  })

  it('removes a row on click', async () => {
    const w = mount(ProjectConfig, {
      props: {
        open: true,
        projectConfig: configWithSkillRepos,
        currentWorkspace: '/test',
        vendorModes: MOCK_VENDOR_MODES,
      },
    })
    const removes = w.findAll('[data-testid="skill-repo-remove"]')
    expect(removes).toHaveLength(2)
    await removes[0].trigger('click')
    expect(w.findAll('[data-testid="skill-repo-row"]')).toHaveLength(1)
  })

  it('shows ref required error when ref is empty', () => {
    const w = mount(ProjectConfig, {
      props: {
        open: true,
        projectConfig: {
          ...cfg(),
          skillRepos: [
            {
              id: 's',
              repo: '',
              ref: '',
            } as SkillRepoConfig,
          ],
        },
        currentWorkspace: '/test',
        vendorModes: MOCK_VENDOR_MODES,
      },
    })
    const errors = w.findAll('[data-testid="skill-repo-ref-error"]')
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0].text()).toBeTruthy()
  })

  it('renders only id/repo/ref/subpath fields (no vendor/trust/pin controls)', () => {
    const w = mount(ProjectConfig, {
      props: {
        open: true,
        projectConfig: configWithSkillRepos,
        currentWorkspace: '/test',
        vendorModes: MOCK_VENDOR_MODES,
      },
    })
    expect(w.find('[data-testid="skill-repo-vendor"]').exists()).toBe(false)
    expect(w.find('[data-testid="skill-repo-trust"]').exists()).toBe(false)
    expect(w.find('[data-testid="skill-repo-pin-commit"]').exists()).toBe(false)
  })

  it('carries the edited skillRepos into the Save payload', async () => {
    const w = mount(ProjectConfig, {
      props: {
        open: true,
        projectConfig: configWithSkillRepos,
        currentWorkspace: '/test',
        vendorModes: MOCK_VENDOR_MODES,
      },
    })
    const inputs = w.findAll('[data-testid="skill-repo-ref"]')
    await inputs[0].setValue('develop')
    await w.find('[data-testid="project-config-save"]').trigger('click')
    const emitted = w.emitted('save') as [ProjectConfigType][]
    expect(emitted[0][0].skillRepos?.[0]?.ref).toBe('develop')
  })
})
