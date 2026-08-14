/**
 * The administrator's account × workspace editor.
 *
 * The property this file exists for is that SEARCHING never changes what gets
 * saved. A filter that quietly dropped hidden checkboxes would revoke access as a
 * side effect of typing, which is the kind of bug nobody notices until someone
 * cannot reach their work.
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import type { UserWorkspaceAccessAccount, WorkspaceInfo } from '@ccc/shared/protocol'
import UserAccess from './UserAccess.vue'

function ws(name: string): WorkspaceInfo {
  return { name, path: `/tmp/${name}` } as WorkspaceInfo
}

const WORKSPACES = [ws('alpha'), ws('beta'), ws('gamma')]

const ACCOUNTS: UserWorkspaceAccessAccount[] = [
  { subject: 'root', isAdmin: true, editable: false, policy: null },
  { subject: 'alice', isAdmin: false, editable: true, policy: null },
  {
    subject: 'bob',
    isAdmin: false,
    editable: true,
    policy: { mode: 'selected', workspaces: ['alpha', 'gamma'] },
  },
  { subject: 'carol', isAdmin: false, editable: true, policy: { mode: 'all', workspaces: [] } },
]

function render(props: Record<string, unknown> = {}) {
  return mount(UserAccess, { props: { workspaces: WORKSPACES, accounts: ACCOUNTS, ...props } })
}

function rowFor(w: ReturnType<typeof render>, subject: string) {
  return w
    .findAll('[data-testid="settings-user-access-row"]')
    .find((r) => r.text().startsWith(subject))!
}

describe('the roster', () => {
  it('tells "not loaded yet" apart from "nothing matched"', () => {
    const loading = render({ accounts: null })
    expect(loading.find('[data-testid="settings-user-access-loading"]').exists()).toBe(true)

    const none = render({ accounts: [] })
    expect(none.find('[data-testid="settings-user-access-empty"]').exists()).toBe(true)
  })

  it('distinguishes no policy, selected-with-none, all, and the implicit administrator', () => {
    const w = render({
      accounts: [
        ...ACCOUNTS,
        {
          subject: 'dave',
          isAdmin: false,
          editable: true,
          policy: { mode: 'selected', workspaces: [] },
        },
      ],
    })
    expect(rowFor(w, 'root').text()).toContain('All workspaces (implicit)')
    expect(rowFor(w, 'alice').text()).toContain('No policy')
    expect(rowFor(w, 'dave').text()).toContain('Selected: 0')
    expect(rowFor(w, 'carol').text()).toContain('All workspaces')
  })

  it('makes the administrator row uneditable and says why', () => {
    const w = render()
    const root = rowFor(w, 'root')
    expect(
      (root.get('[data-testid="settings-user-access-edit"]').element as HTMLButtonElement).disabled,
    ).toBe(true)
    expect(root.find('[data-testid="settings-user-access-immutable"]').exists()).toBe(true)
    expect(root.find('[data-testid="settings-user-access-admin-badge"]').exists()).toBe(true)
  })

  it('filters accounts by the search box', async () => {
    const w = render()
    await w.get('[data-testid="settings-user-access-account-search"]').setValue('bo')
    const rows = w.findAll('[data-testid="settings-user-access-row"]')
    expect(rows).toHaveLength(1)
    expect(rows[0].text()).toContain('bob')
  })
})

describe('editing one account', () => {
  it('saves the complete selected set, not just what is on screen', async () => {
    const w = render()
    await rowFor(w, 'bob').get('[data-testid="settings-user-access-edit"]').trigger('click')

    // Filter the workspace list down to one that bob does NOT have selected.
    await w.get('[data-testid="settings-user-access-workspace-search"]').setValue('beta')
    expect(w.findAll('[data-testid="settings-user-access-workspace-pick"]')).toHaveLength(1)
    // The editor says outright that hidden selections survive.
    expect(w.find('[data-testid="settings-user-access-hidden-selected"]').exists()).toBe(true)

    await w.get('[data-testid="settings-user-access-workspace-pick"] input').setValue(true)
    await w.get('[data-testid="settings-user-access-save"]').trigger('click')

    // alpha and gamma were filtered out of view — and are still in the payload.
    expect(w.emitted('save')).toEqual([
      [{ subject: 'bob', mode: 'selected', workspaces: ['alpha', 'gamma', 'beta'] }],
    ])
  })

  it('sends no workspace names under `all`, which follows the registry', async () => {
    const w = render()
    await rowFor(w, 'bob').get('[data-testid="settings-user-access-edit"]').trigger('click')
    await w.get('[data-testid="settings-user-access-mode-all"]').setValue(true)
    await w.get('[data-testid="settings-user-access-save"]').trigger('click')
    expect(w.emitted('save')).toEqual([[{ subject: 'bob', mode: 'all', workspaces: [] }]])
  })

  it('starts an unconfigured account at selected-with-nothing, its actual current effect', async () => {
    const w = render()
    await rowFor(w, 'alice').get('[data-testid="settings-user-access-edit"]').trigger('click')
    expect(
      (w.get('[data-testid="settings-user-access-mode-selected"]').element as HTMLInputElement)
        .checked,
    ).toBe(true)
    await w.get('[data-testid="settings-user-access-save"]').trigger('click')
    expect(w.emitted('save')).toEqual([[{ subject: 'alice', mode: 'selected', workspaces: [] }]])
  })

  it('emits nothing when the edit is cancelled', async () => {
    const w = render()
    await rowFor(w, 'bob').get('[data-testid="settings-user-access-edit"]').trigger('click')
    await w.get('[data-testid="settings-user-access-cancel"]').trigger('click')
    expect(w.find('[data-testid="settings-user-access-edit-form"]').exists()).toBe(false)
    expect(w.emitted('save')).toBeUndefined()
  })

  it('leaves the edit form once a fresh roster arrives, rather than showing stale ticks', async () => {
    const w = render()
    await rowFor(w, 'bob').get('[data-testid="settings-user-access-edit"]').trigger('click')
    expect(w.find('[data-testid="settings-user-access-edit-form"]').exists()).toBe(true)

    await w.setProps({
      accounts: ACCOUNTS.map((a) =>
        a.subject === 'bob' ? { ...a, policy: { mode: 'all' as const, workspaces: [] } } : a,
      ),
    })
    expect(w.find('[data-testid="settings-user-access-edit-form"]').exists()).toBe(false)
    expect(rowFor(w, 'bob').text()).toContain('All workspaces')
  })

  it('asks the parent to re-read rather than mutating its own snapshot', async () => {
    const w = render()
    await w.get('[data-testid="settings-user-access-reload"]').trigger('click')
    expect(w.emitted('reload')).toHaveLength(1)
  })
})
