/**
 * Robot safety message registry: locale fallback, parameter validation, deep links.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { releaseConfigDb, useConfigDb } from '../../kernel/config/config-fixture.js'
import { loadSettings, saveSettings } from '../../kernel/config/index.js'
import { savePersonalizedFor } from '../../kernel/config/personalized.js'
import {
  assertSendableCategory,
  buildObjectDeepLink,
  messageUsagePolicy,
  parsePublicBaseUrl,
  pickSecurityMessage,
  renderRobotMessage,
  resolveLocaleChain,
  ROBOT_MESSAGE_KEYS,
  validateRobotMessageRegistry,
  createTurnDisplaySignals,
  recordObjectNotVisible,
  recordGroupHidden,
  resetRobotMessageRegistryForTests,
} from './robot-message-registry.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-robot-msg-'))
  useConfigDb(dir)
  resetRobotMessageRegistryForTests()
})

afterEach(() => {
  releaseConfigDb()
  rmSync(dir, { recursive: true, force: true })
})

describe('validateRobotMessageRegistry', () => {
  it('passes when baseline catalog is complete', () => {
    expect(() => validateRobotMessageRegistry()).not.toThrow()
  })

  it('lists every stable key with an en template', () => {
    validateRobotMessageRegistry()
    expect(ROBOT_MESSAGE_KEYS.length).toBeGreaterThan(30)
    for (const key of ROBOT_MESSAGE_KEYS) {
      expect(messageUsagePolicy(key)).toBeTruthy()
    }
  })
})

describe('resolveLocaleChain', () => {
  it('orders personal over robot over en', () => {
    expect(resolveLocaleChain({ personalLocale: 'zh', robotLocale: 'ja', baseUrl: null })).toEqual([
      'zh',
      'ja',
      'en',
    ])
  })

  it('deduplicates identical locales', () => {
    expect(resolveLocaleChain({ personalLocale: 'en', robotLocale: 'en' })).toEqual(['en'])
  })

  it('skips illegal locales', () => {
    expect(resolveLocaleChain({ personalLocale: 'klingon' as 'en', robotLocale: null })).toEqual([
      'en',
    ])
  })
})

describe('renderRobotMessage — language fallback', () => {
  it('prefers personal zh over robot ja', () => {
    const text = renderRobotMessage(
      { key: 'runtime.busy', params: {} },
      { personalLocale: 'zh', robotLocale: 'ja' },
    )
    expect(text).toContain('上一个问题')
  })

  it('falls back to robot locale when personal missing key would use chain', () => {
    const text = renderRobotMessage(
      { key: 'runtime.busy', params: {} },
      { personalLocale: null, robotLocale: 'zh' },
    )
    expect(text).toContain('上一个问题')
  })

  it('falls back to en for unknown key params failure', () => {
    const text = renderRobotMessage(
      { key: 'visibility.groupPartiallyHidden', params: { totalCount: -1 } },
      { personalLocale: 'zh' },
    )
    expect(text.length).toBeGreaterThan(0)
    expect(text).toMatch(/cannot be completed|无法在此完成|Open c3 Web/i)
  })

  it('never returns empty for unknown key', () => {
    const text = renderRobotMessage(
      { key: 'not.a.real.key' as 'runtime.busy', params: {} },
      { personalLocale: 'zh' },
    )
    expect(text.trim().length).toBeGreaterThan(0)
  })
})

describe('renderRobotMessage — fresh personal settings', () => {
  it('reads uiLang at render time', () => {
    savePersonalizedFor('alice', { uiLang: 'zh' })
    const before = renderRobotMessage(
      { key: 'runtime.busy', params: {} },
      { personalLocale: 'en', robotLocale: null, baseUrl: null },
    )
    expect(before).toContain('Still working')

    const after = renderRobotMessage(
      { key: 'runtime.busy', params: {} },
      { personalLocale: 'zh', robotLocale: null, baseUrl: null },
    )
    expect(after).toContain('上一个问题')
  })
})

describe('parsePublicBaseUrl', () => {
  it('accepts http/https with port and path prefix', () => {
    expect(parsePublicBaseUrl('https://c3.example.com:9000/app/')).toBe(
      'https://c3.example.com:9000/app',
    )
  })

  it('rejects relative, credentialed, query and fragment URLs', () => {
    expect(parsePublicBaseUrl('//evil.test')).toBeNull()
    expect(parsePublicBaseUrl('https://user@c3.test')).toBeNull()
    expect(parsePublicBaseUrl('https://c3.test?q=1')).toBeNull()
    expect(parsePublicBaseUrl('https://c3.test#x')).toBeNull()
    expect(parsePublicBaseUrl('ftp://c3.test')).toBeNull()
    expect(parsePublicBaseUrl('')).toBeNull()
  })
})

describe('buildObjectDeepLink', () => {
  it('encodes path segments for supported kinds', () => {
    const link = buildObjectDeepLink('https://c3.test', 'intent', 'my ws', 'id/with/slash')
    expect(link).toBe('https://c3.test/#/intent/my%20ws/id%2Fwith%2Fslash')
  })

  it('rejects unknown kinds', () => {
    expect(buildObjectDeepLink('https://c3.test', 'delivery' as 'intent', 'ws', 'id')).toBeNull()
  })
})

describe('navigation suffix', () => {
  it('uses plain variant when baseUrl missing', () => {
    saveSettings({ ...loadSettings(), baseUrl: '' })
    const text = renderRobotMessage(
      {
        key: 'binding.identityRequired',
        params: { nav: { kind: 'webEntry' } },
      },
      { personalLocale: 'en', robotLocale: null },
    )
    expect(text).toContain('Open c3 Web in your browser')
    expect(text).not.toContain('http')
  })

  it('appends link when baseUrl valid', () => {
    const text = renderRobotMessage(
      {
        key: 'binding.identityRequired',
        params: { nav: { kind: 'webEntry' } },
      },
      { personalLocale: 'en', robotLocale: null, baseUrl: 'https://c3.test/app' },
    )
    expect(text).toContain('https://c3.test/app')
  })
})

describe('parameter attacks', () => {
  it('rejects extra fields on broadcast keys', () => {
    const text = renderRobotMessage(
      {
        key: 'broadcast.automationPaused',
        params: { title: 'ok', evil: 'x' } as { title: string },
      },
      { personalLocale: 'en' },
    )
    expect(text).toMatch(/cannot be completed|safely/i)
  })

  it('escapes title control characters', () => {
    const text = renderRobotMessage(
      {
        key: 'broadcast.automationPaused',
        params: { title: 'hello\u0007world' },
      },
      { personalLocale: 'en' },
    )
    expect(text).toBe('Automation "helloworld" paused.')
  })

  it('rejects overlong titles', () => {
    const text = renderRobotMessage(
      {
        key: 'broadcast.automationPaused',
        params: { title: 'x'.repeat(300) },
      },
      { personalLocale: 'en' },
    )
    expect(text).toMatch(/cannot be completed|safely/i)
  })
})

describe('pickSecurityMessage', () => {
  it('prioritizes object_not_visible over group hidden', () => {
    const s = createTurnDisplaySignals()
    recordObjectNotVisible(s)
    recordGroupHidden(s, 2, 3)
    expect(pickSecurityMessage(s, 'group')?.key).toBe('visibility.notVisible')
  })

  it('selects groupAllHidden when only hidden items', () => {
    const s = createTurnDisplaySignals()
    recordGroupHidden(s, 0, 2)
    expect(pickSecurityMessage(s, 'group')?.key).toBe('visibility.groupAllHidden')
  })

  it('selects groupPartiallyHidden with total count', () => {
    const s = createTurnDisplaySignals()
    recordGroupHidden(s, 1, 2)
    const msg = pickSecurityMessage(s, 'group')
    expect(msg?.key).toBe('visibility.groupPartiallyHidden')
    expect((msg?.params as { totalCount?: number } | undefined)?.totalCount).toBe(3)
  })
})

describe('assertSendableCategory', () => {
  it('blocks broadcast keys from fixed_notice', () => {
    expect(
      assertSendableCategory(
        { key: 'broadcast.automationPaused', params: { title: 'x' } },
        'fixed_notice',
      ),
    ).toBe(false)
  })

  it('allows binding keys on binding_notice path', () => {
    expect(assertSendableCategory({ key: 'binding.useDm', params: {} }, 'binding_notice')).toBe(
      true,
    )
  })
})
