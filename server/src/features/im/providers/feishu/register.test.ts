/**
 * One-click registration orchestration tests.
 *
 * The SDK and the v7 config API are both replaced with doubles so the fixed
 * contract can be pinned: China-only account domain, `createOnly`, the exact
 * minimal addons payload (`preset=false`, four tenant scopes, one tenant
 * event, nothing else), and the status/result mapping. The addons gray-scale
 * is deliberately NOT asserted as a platform guarantee — `preset=false` here
 * only proves what c3 REQUESTED, never what the confirm page granted.
 */
import { describe, expect, it, vi } from 'vitest'
import { registerApp as sdkRegisterApp } from '@larksuiteoapi/node-sdk'
import {
  FEISHU_ACCOUNTS_DOMAIN,
  FEISHU_APP_REGISTRATION_EVENTS,
  FEISHU_APP_REGISTRATION_SCOPES,
  runFeishuAppRegistration,
  type FeishuRegistrationOutcome,
  type FeishuRegistrationProgress,
} from './register.js'
import type { AppConfigOutcome } from './api.js'

type SdkRegisterOptions = Parameters<typeof sdkRegisterApp>[0]
type SdkRegisterResult = Awaited<ReturnType<typeof sdkRegisterApp>>
type RegisterDouble = (opts: SdkRegisterOptions) => Promise<Partial<SdkRegisterResult>>

async function run(
  opts: {
    register?: RegisterDouble
    configure?: (appId: string, appSecret: string) => Promise<AppConfigOutcome>
    signal?: AbortSignal
    abort?: () => void
  } = {},
) {
  const controller = new AbortController()
  const progress: FeishuRegistrationProgress[] = []
  const results: FeishuRegistrationOutcome[] = []
  await runFeishuAppRegistration({
    signal: opts.signal ?? controller.signal,
    abort: opts.abort ?? (() => controller.abort()),
    onProgress: (p) => progress.push(p),
    onResult: (r) => results.push(r),
    register: opts.register as typeof import('@larksuiteoapi/node-sdk').registerApp,
    configure: opts.configure as typeof import('./api.js').configureAppWebsocket,
    now: () => 1000,
  })
  return { progress, results }
}

function successRegister(): RegisterDouble {
  return async () => ({ client_id: 'cli_new', client_secret: 'new-secret' })
}

describe('feishu one-click registration orchestration', () => {
  it('sends the fixed China-only, createOnly, minimal-addons request', async () => {
    let captured: SdkRegisterOptions | undefined
    const register = vi.fn(async (opts: SdkRegisterOptions) => {
      captured = opts
      return { client_id: 'cli_new', client_secret: 'new-secret' }
    })
    await run({ register, configure: async () => 'configured' })

    expect(captured?.domain).toBe(FEISHU_ACCOUNTS_DOMAIN)
    expect(captured?.createOnly).toBe(true)
    expect(captured?.addons?.preset).toBe(false)
    expect(captured?.addons?.scopes?.tenant).toEqual([...FEISHU_APP_REGISTRATION_SCOPES])
    expect(captured?.addons?.events?.items?.tenant).toEqual([...FEISHU_APP_REGISTRATION_EVENTS])
    // No extra permissions, user scopes, callbacks or app id are ever requested.
    expect(captured?.addons?.scopes?.user).toBeUndefined()
    expect(captured?.addons?.callbacks).toBeUndefined()
    expect(captured?.appId).toBeUndefined()
    expect(captured?.larkDomain).toBeUndefined()
  })

  it('runs starting → waiting_scan → configuring → ready with the QR expiry', async () => {
    const register = vi.fn(async (opts: SdkRegisterOptions) => {
      opts.onQRCodeReady?.({ url: 'https://accounts.feishu.cn/qr?x=1', expireIn: 600 })
      opts.onStatusChange?.({ status: 'polling' })
      return { client_id: 'cli_new', client_secret: 'new-secret' }
    })
    const configure = vi.fn(async (): Promise<AppConfigOutcome> => 'configured')
    const { progress, results } = await run({ register, configure })

    expect(progress[0]).toEqual({ status: 'starting' })
    expect(progress).toContainEqual({
      status: 'waiting_scan',
      verificationUrl: 'https://accounts.feishu.cn/qr?x=1',
      expiresAt: 1000 + 600 * 1000,
    })
    expect(progress).toContainEqual({ status: 'configuring' })
    expect(configure).toHaveBeenCalledWith('cli_new', 'new-secret', {
      signal: expect.any(AbortSignal),
    })
    expect(results).toEqual([{ kind: 'ready', appId: 'cli_new', appSecret: 'new-secret' }])
  })

  it('surfaces slow_down as a non-terminal progress state', async () => {
    const register = vi.fn(async (opts: SdkRegisterOptions) => {
      opts.onStatusChange?.({ status: 'slow_down', interval: 10 })
      return { client_id: 'cli_new', client_secret: 'new-secret' }
    })
    const { progress } = await run({ register, configure: async () => 'configured' })
    expect(progress).toContainEqual({ status: 'slow_down' })
  })

  it.each([
    [{ code: 'access_denied' }, 'denied'],
    [{ code: 'expired_token' }, 'expired'],
    [{ code: 'invalid_grant' }, 'expired'],
  ] as const)('maps SDK rejection %j to failed/%s without credentials', async (err, reason) => {
    const register = vi.fn(async () => {
      throw err
    })
    const { results } = await run({ register })
    expect(results).toEqual([{ kind: 'failed', reason }])
    expect(JSON.stringify(results)).not.toContain('secret')
  })

  it('maps a pre-credential transport failure to network_error', async () => {
    const register = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    })
    const { results } = await run({ register })
    expect(results).toEqual([{ kind: 'failed', reason: 'network_error' }])
  })

  it('maps an unknown SDK error code to server_error', async () => {
    const register = vi.fn(async () => {
      throw { code: 'unsupported_grant_type' }
    })
    const { results } = await run({ register })
    expect(results[0]).toMatchObject({ kind: 'failed', reason: 'server_error' })
  })

  it('maps a success without full credentials to server_error', async () => {
    const register = vi.fn(async () => ({ client_id: 'cli_new' }))
    const { results } = await run({ register })
    expect(results[0]).toMatchObject({ kind: 'failed', reason: 'server_error' })
  })

  it('maps an abort before credentials to cancelled', async () => {
    const controller = new AbortController()
    controller.abort()
    const register = vi.fn(async () => {
      throw { code: 'abort' }
    })
    const { results } = await run({ register, signal: controller.signal })
    expect(results).toEqual([{ kind: 'failed', reason: 'cancelled' }])
  })

  it('aborts on domain_switched and converges to unsupported_region, discarding any result', async () => {
    const controller = new AbortController()
    const register = vi.fn(async (opts: SdkRegisterOptions) => {
      opts.onStatusChange?.({ status: 'domain_switched' })
      // Simulate the SDK still resolving with Lark credentials after the switch.
      return { client_id: 'lark_cli', client_secret: 'lark-secret' }
    })
    const { results } = await run({
      register,
      signal: controller.signal,
      abort: () => controller.abort(),
    })
    expect(controller.signal.aborted).toBe(true)
    expect(results).toEqual([
      { kind: 'failed', reason: 'unsupported_region', detail: 'lark tenant detected' },
    ])
    expect(JSON.stringify(results)).not.toContain('lark-secret')
  })

  it('reports manual_setup_required with full credentials when v7 config is refused', async () => {
    const register = vi.fn(successRegister())
    const configure = vi.fn(async (): Promise<AppConfigOutcome> => 'config_forbidden')
    const { results } = await run({ register, configure })
    expect(results).toEqual([
      {
        kind: 'manual_setup_required',
        appId: 'cli_new',
        appSecret: 'new-secret',
        reason: 'config_forbidden',
      },
    ])
  })

  it('never reports ready when configuration did not return code=0', async () => {
    const register = vi.fn(successRegister())
    const configure = vi.fn(async (): Promise<AppConfigOutcome> => 'config_network_error')
    const { results } = await run({ register, configure })
    expect(results.some((r) => r.kind === 'ready')).toBe(false)
    expect(results[0]).toMatchObject({
      kind: 'manual_setup_required',
      reason: 'config_network_error',
    })
  })
})
