import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import ProjectConfig from './ProjectConfig.vue'
import type { ProjectConfig as ProjectConfigType, SkillRepoConfig } from '@ccc/shared/protocol'

const baseConfig: ProjectConfigType = {
  defaultMode: 'plan',
  devSkill: '/my-skill',
  maxRoundsPerStage: 14,
  maxSpeechChars: 400,
  consensus: { enabled: true, majority: true },
}

describe('ProjectConfig.vue — default mode', () => {
  it('seeds the mode select from project config', () => {
    const w = mount(ProjectConfig, {
      props: { open: true, projectConfig: baseConfig, currentWorkspace: '/test' },
    })
    const select = w.find('.mode-select')
    expect(select.exists()).toBe(true)
    expect((select.element as HTMLSelectElement).value).toBe('plan')
  })

  it('defaults mode to "default" when config omits it', () => {
    const w = mount(ProjectConfig, {
      props: { open: true, projectConfig: {}, currentWorkspace: '/test' },
    })
    expect((w.find('.mode-select').element as HTMLSelectElement).value).toBe('default')
  })
})

describe('ProjectConfig.vue — dev skill', () => {
  it('seeds the dev skill input from project config', () => {
    const w = mount(ProjectConfig, {
      props: { open: true, projectConfig: baseConfig, currentWorkspace: '/test' },
    })
    const inputs = w.findAll('.project-config-field')
    const skillInput = inputs.find((el) => (el.element as HTMLInputElement).type !== 'number')
    expect(skillInput?.exists()).toBe(true)
    expect((skillInput?.element as HTMLInputElement).value).toBe('/my-skill')
  })

  it('defaults dev skill to empty string when config omits it', () => {
    const w = mount(ProjectConfig, {
      props: { open: true, projectConfig: {}, currentWorkspace: '/test' },
    })
    const inputs = w.findAll('.project-config-field')
    const skillInput = inputs.find((el) => (el.element as HTMLInputElement).type !== 'number')
    expect((skillInput?.element as HTMLInputElement).value ?? '').toBe('')
  })
})

describe('ProjectConfig.vue — discussion rounds per stage', () => {
  it('seeds the rounds input from project config', () => {
    const w = mount(ProjectConfig, {
      props: { open: true, projectConfig: baseConfig, currentWorkspace: '/test' },
    })
    const inputs = w.findAll('.project-config-number')
    expect(inputs.length).toBeGreaterThanOrEqual(1)
    expect((inputs[0].element as HTMLInputElement).value).toBe('14')
  })

  it('defaults the rounds input when config omits the field', () => {
    const w = mount(ProjectConfig, {
      props: {
        open: true,
        projectConfig: { ...baseConfig, maxRoundsPerStage: undefined },
        currentWorkspace: '/test',
      },
    })
    const inputs = w.findAll('.project-config-number')
    expect((inputs[0].element as HTMLInputElement).value).toBe('12')
  })

  it('emits the edited rounds value on save', async () => {
    const w = mount(ProjectConfig, {
      props: { open: true, projectConfig: baseConfig, currentWorkspace: '/test' },
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
      props: { open: true, projectConfig: baseConfig, currentWorkspace: '/test' },
    })
    const inputs = w.findAll('.project-config-number')
    expect(inputs.length).toBeGreaterThanOrEqual(2)
    expect((inputs[1].element as HTMLInputElement).value).toBe('400')
  })

  it('defaults the speech-chars input when config omits the field', () => {
    const w = mount(ProjectConfig, {
      props: {
        open: true,
        projectConfig: { ...baseConfig, maxSpeechChars: undefined },
        currentWorkspace: '/test',
      },
    })
    const inputs = w.findAll('.project-config-number')
    expect((inputs[1].element as HTMLInputElement).value).toBe('300')
  })

  it('emits the edited speech-chars value on save', async () => {
    const w = mount(ProjectConfig, {
      props: { open: true, projectConfig: baseConfig, currentWorkspace: '/test' },
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
      props: { open: true, projectConfig: baseConfig, currentWorkspace: '/test' },
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
      },
    })
    expect(
      (w.find('[data-testid="project-config-consensus-majority"]').element as HTMLInputElement)
        .checked,
    ).toBe(false)
  })

  it('emits the toggled majority value on save', async () => {
    const w = mount(ProjectConfig, {
      props: { open: true, projectConfig: baseConfig, currentWorkspace: '/test' },
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
      props: { open: true, projectConfig: baseConfig, currentWorkspace: '/test' },
    })
    await w.find('[data-testid="project-config-save"]').trigger('click')
    const emitted = w.emitted('save') as [ProjectConfigType][]
    expect(emitted).toBeTruthy()
    const payload = emitted[0][0]
    expect(payload.defaultMode).toBe('plan')
    expect(payload.devSkill).toBe('/my-skill')
    expect(payload.maxRoundsPerStage).toBe(14)
    expect(payload.maxSpeechChars).toBe(400)
    expect(payload.consensus?.enabled).toBe(true)
    expect(payload.consensus?.majority).toBe(true)
  })
})

describe('ProjectConfig.vue — external skill repos (ADR-0016/0017)', () => {
  const configWithSkillRepos: ProjectConfigType = {
    ...baseConfig,
    skillRepos: [
      {
        id: 'my-skills',
        repo: 'https://github.com/owner/repo',
        ref: 'main',
        subpath: 'skills/my-skill',
        vendor: 'claude',
        trust: 'review-on-update',
      },
      {
        id: 'pinned-skills',
        repo: 'https://github.com/owner/pinned',
        ref: 'v1.0',
        vendor: 'all',
        trust: 'pinned',
        pinCommit: 'abcdef1234567890abcdef1234567890abcdef12',
      },
    ] as SkillRepoConfig[],
  }

  it('renders a row per skill repo when projectConfig carries skillRepos', () => {
    const w = mount(ProjectConfig, {
      props: { open: true, projectConfig: configWithSkillRepos, currentWorkspace: '/test' },
    })
    const rows = w.findAll('[data-testid="skill-repo-row"]')
    expect(rows).toHaveLength(2)
  })

  it('shows an empty hint when skillRepos is empty', () => {
    const w = mount(ProjectConfig, {
      props: { open: true, projectConfig: baseConfig, currentWorkspace: '/test' },
    })
    expect(w.text()).toContain('No external skill repositories configured.')
  })

  it('adds a new row on + Add skill repo', async () => {
    const w = mount(ProjectConfig, {
      props: { open: true, projectConfig: baseConfig, currentWorkspace: '/test' },
    })
    await w.find('[data-testid="project-config-add-skill-repo"]').trigger('click')
    const rows = w.findAll('[data-testid="skill-repo-row"]')
    expect(rows).toHaveLength(1)
  })

  it('removes a row on click', async () => {
    const w = mount(ProjectConfig, {
      props: { open: true, projectConfig: configWithSkillRepos, currentWorkspace: '/test' },
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
          ...baseConfig,
          skillRepos: [
            {
              id: 's',
              repo: '',
              ref: '',
              vendor: 'claude',
              trust: 'unreviewed',
            } as SkillRepoConfig,
          ],
        },
        currentWorkspace: '/test',
      },
    })
    const errors = w.findAll('[data-testid="skill-repo-ref-error"]')
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0].text()).toBeTruthy()
  })

  it('shows pin required error when trust is pinned but pinCommit is missing', () => {
    const w = mount(ProjectConfig, {
      props: {
        open: true,
        projectConfig: {
          ...baseConfig,
          skillRepos: [
            {
              id: 's',
              repo: '',
              ref: 'main',
              vendor: 'claude',
              trust: 'pinned',
            } as SkillRepoConfig,
          ],
        },
        currentWorkspace: '/test',
      },
    })
    const errors = w.findAll('[data-testid="skill-repo-pin-error"]')
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0].text()).toBeTruthy()
  })

  it('no pin error when trust is pinned and pinCommit is present', () => {
    const w = mount(ProjectConfig, {
      props: {
        open: true,
        projectConfig: {
          ...baseConfig,
          skillRepos: [
            {
              id: 's',
              repo: '',
              ref: 'main',
              vendor: 'claude',
              trust: 'pinned' as const,
              pinCommit: 'abcdef1234567890abcdef1234567890abcdef12',
            },
          ] as SkillRepoConfig[],
        },
        currentWorkspace: '/test',
      },
    })
    expect(w.findAll('[data-testid="skill-repo-pin-error"]')).toHaveLength(0)
  })

  it('carries the edited skillRepos into the Save payload', async () => {
    const w = mount(ProjectConfig, {
      props: { open: true, projectConfig: configWithSkillRepos, currentWorkspace: '/test' },
    })
    const inputs = w.findAll('[data-testid="skill-repo-ref"]')
    await inputs[0].setValue('develop')
    await w.find('[data-testid="project-config-save"]').trigger('click')
    const emitted = w.emitted('save') as [ProjectConfigType][]
    expect(emitted[0][0].skillRepos?.[0]?.ref).toBe('develop')
  })
})
