/**
 * The manual vendor CLI download/check action glue. `installSettingsActions`
 * installs `syncVendorCli(vendor)`: mark the vendor in-flight, then send the one
 * `sync_vendor_cli` frame. A second click while in flight is a no-op — the server
 * merges concurrent triggers, but the console must never fire a second download.
 */
import { describe, it, expect, vi } from 'vitest'
import { ref } from 'vue'
import type { ClientToServer, VendorId } from '@ccc/shared/protocol'
import type { AppCtx } from './types'
import { installSettingsActions } from './settings-actions'

function makeCtx() {
  const send = vi.fn()
  const showToast = vi.fn()
  const vendorCliSyncing = ref<VendorId[]>([])
  const ctx = {
    send,
    t: (key: string) => key,
    showToast,
    vendorCliSyncing,
    settingsOpen: ref(false),
    personalizedSettingOpen: ref(false),
    personalizedSettings: ref({}),
    workspaceSettingOpen: ref(false),
    currentWorkspace: ref<string | null>(null),
    currentWorkspaceSetting: ref(null),
    installingSkillIds: ref<string[]>([]),
    serverSettings: ref(null),
    skillApprovalRequest: ref(null),
    viewMode: ref<'workspace' | 'workcenter'>('workspace'),
    savedTab: ref('intents'),
    activeTab: ref('intents'),
    flags: {},
    providerProbes: ref({}),
  } as unknown as AppCtx
  installSettingsActions(ctx)
  return { ctx, send, vendorCliSyncing }
}

describe('syncVendorCli action', () => {
  it('marks the vendor in-flight and sends sync_vendor_cli', () => {
    const { ctx, send, vendorCliSyncing } = makeCtx()
    ctx.syncVendorCli('claude')

    expect(vendorCliSyncing.value).toEqual(['claude'])
    expect(send).toHaveBeenCalledWith({ type: 'sync_vendor_cli', vendor: 'claude' })
  })

  it('is a no-op while the same vendor is already in flight', () => {
    const { ctx, send } = makeCtx()
    ctx.syncVendorCli('claude')
    ctx.syncVendorCli('claude')

    expect(send).toHaveBeenCalledTimes(1)
  })

  it('still allows a different vendor to start while another is in flight', () => {
    const { ctx, send, vendorCliSyncing } = makeCtx()
    ctx.syncVendorCli('claude')
    ctx.syncVendorCli('codex')

    expect(vendorCliSyncing.value).toEqual(['claude', 'codex'])
    expect(send.mock.calls.map((c) => (c[0] as ClientToServer).type)).toEqual([
      'sync_vendor_cli',
      'sync_vendor_cli',
    ])
  })
})
