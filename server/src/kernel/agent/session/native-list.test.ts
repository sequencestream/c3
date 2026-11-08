/**
 * The projection store's native-list seam: one vendor per call, and a read
 * failure stays distinguishable from an empty vendor.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionAccessor } from './accessor.js'
import { accessorNativeList, lastModifiedOf } from './native-list.js'
import type { SessionStore, SessionSummary } from '../adapters/types.js'

function fakeStore(summaries: SessionSummary[]): SessionStore {
  return { list: vi.fn(async () => summaries), read: vi.fn(async () => []) }
}

const cwd = '/ws'

afterEach(() => vi.restoreAllMocks())

describe('lastModifiedOf', () => {
  it('prefers a direct lastModified, then the latest of time.updated/created', () => {
    expect(lastModifiedOf({ lastModified: 10, time: { updated: 20 } })).toBe(10)
    expect(lastModifiedOf({ time: { created: 30, updated: 40 } })).toBe(40)
    expect(lastModifiedOf({ time: { created: 30 } })).toBe(30)
    expect(lastModifiedOf({})).toBe(0)
  })
})

describe('accessorNativeList', () => {
  it('maps one vendor to the projection shape without listing the others', async () => {
    const claude = fakeStore([
      { sessionId: 'c-1', title: 'Claude one', vendorExtra: { lastModified: 111 } },
    ])
    const dsh = fakeStore([
      { sessionId: 'd-1', title: 'DSH one', vendorExtra: { lastModified: 222 } },
    ])
    const nativeList = accessorNativeList(
      new SessionAccessor([
        { vendor: 'claude', sessions: claude },
        { vendor: 'dsh', sessions: dsh },
      ]),
    )

    const out = await nativeList('dsh', cwd)

    expect(out).toEqual({
      sessions: [{ vendorSessionId: 'd-1', title: 'DSH one', lastModified: 222 }],
    })
    expect(dsh.list).toHaveBeenCalledTimes(1)
    expect(claude.list).not.toHaveBeenCalled()
  })

  it('returns null, not an empty list, when the vendor store fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const nativeList = accessorNativeList(
      new SessionAccessor([
        {
          vendor: 'dsh',
          sessions: {
            list: vi.fn(async () => {
              throw new Error('unreadable')
            }),
            read: vi.fn(async () => []),
          },
        },
      ]),
    )

    await expect(nativeList('dsh', cwd)).resolves.toBeNull()
    expect(error).toHaveBeenCalled()
  })

  it('returns null for a vendor it cannot list at all', async () => {
    const nativeList = accessorNativeList(new SessionAccessor([]))

    await expect(nativeList('dsh', cwd)).resolves.toBeNull()
  })
})
