/**
 * 目录选择的请求 / 回复关联。
 *
 * 服务端在自己所在主机弹原生对话框,用户可以让它一直开着。所以「哪条回复算数」
 * 必须由 requestId 说了算:弹框关掉、或用户又点了一次「选择目录」之后,旧对话框
 * 迟到的结果都不能落到表单上,否则用户会看到一个自己没选过的路径。
 */
import { describe, it, expect, vi } from 'vitest'
import { nextTick, ref } from 'vue'
import type { ClientToServer } from '@ccc/shared/protocol'
import { installSessionActions } from './session-actions'
import { emptyDirectoryPicker } from './state'
import type { AppCtx } from './types'

function makeCtx() {
  const send = vi.fn<(msg: ClientToServer) => void>()
  const addWorkspaceOpen = ref(false)
  const workspaceDirectoryPicker = ref(emptyDirectoryPicker())
  const ctx = {
    send,
    addWorkspaceOpen,
    workspaceDirectoryPicker,
    t: (key: string) => key,
    showToast: vi.fn(),
  } as unknown as AppCtx
  installSessionActions(ctx)
  return { ctx, send, addWorkspaceOpen, workspaceDirectoryPicker }
}

/** 从 send 里取最后一条目录选择请求的 requestId。 */
function lastRequestId(send: ReturnType<typeof vi.fn>): string {
  const calls = send.mock.calls
    .map((c) => c[0] as ClientToServer)
    .filter((m) => m.type === 'select_workspace_directory')
  return (calls[calls.length - 1] as { requestId: string }).requestId
}

describe('发起目录选择', () => {
  it('发一条带 requestId 的请求,并进入 pending', () => {
    const { ctx, send, workspaceDirectoryPicker } = makeCtx()
    ctx.selectWorkspaceDirectory()
    expect(send).toHaveBeenCalledWith({
      type: 'select_workspace_directory',
      requestId: expect.any(String) as string,
    })
    expect(workspaceDirectoryPicker.value.pending).toBe(true)
    expect(workspaceDirectoryPicker.value.requestId).toBe(lastRequestId(send))
  })

  it('重新发起会清掉上一次的失败提示,但保留已选路径', () => {
    const { ctx, workspaceDirectoryPicker } = makeCtx()
    workspaceDirectoryPicker.value = {
      requestId: null,
      pending: false,
      error: { code: 'workspace.directoryPickerFailed' },
      selection: { path: '/kept' },
    }
    ctx.selectWorkspaceDirectory()
    expect(workspaceDirectoryPicker.value.error).toBeNull()
    expect(workspaceDirectoryPicker.value.selection).toEqual({ path: '/kept' })
  })

  it('连续两次点击换新的 requestId', () => {
    const { ctx, send } = makeCtx()
    ctx.selectWorkspaceDirectory()
    const first = lastRequestId(send)
    ctx.selectWorkspaceDirectory()
    expect(lastRequestId(send)).not.toBe(first)
  })
})

describe('弹框关闭', () => {
  it('有未决请求时告知服务端可以中止,并把状态归零', async () => {
    const { ctx, send, addWorkspaceOpen, workspaceDirectoryPicker } = makeCtx()
    addWorkspaceOpen.value = true
    await nextTick()
    ctx.selectWorkspaceDirectory()
    const requestId = lastRequestId(send)
    addWorkspaceOpen.value = false
    await nextTick()
    expect(send).toHaveBeenCalledWith({
      type: 'cancel_workspace_directory_selection',
      requestId,
    })
    expect(workspaceDirectoryPicker.value).toEqual(emptyDirectoryPicker())
  })

  it('没有未决请求时不发多余的取消', async () => {
    const { send, addWorkspaceOpen } = makeCtx()
    addWorkspaceOpen.value = true
    await nextTick()
    addWorkspaceOpen.value = false
    await nextTick()
    expect(
      send.mock.calls.some(
        (c) => (c[0] as ClientToServer).type === 'cancel_workspace_directory_selection',
      ),
    ).toBe(false)
  })

  it('重新打开也清一次,不继承上一次的失败与选中', async () => {
    const { addWorkspaceOpen, workspaceDirectoryPicker } = makeCtx()
    workspaceDirectoryPicker.value = {
      requestId: null,
      pending: false,
      error: { code: 'workspace.directoryPickerFailed' },
      selection: { path: '/old' },
    }
    addWorkspaceOpen.value = true
    await nextTick()
    expect(workspaceDirectoryPicker.value).toEqual(emptyDirectoryPicker())
  })
})
