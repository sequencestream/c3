import { describe, it, expect } from 'vitest'
import { LOGS_ROUTE_HASH, isLogsRoute, logsUrl } from './logs-route'
import { parseDeepLink } from './deep-link'

describe('isLogsRoute', () => {
  it('accepts the viewer route with or without the leading # and trailing /', () => {
    for (const hash of ['#/logs', '/logs', 'logs', '#/logs/', '#logs']) {
      expect(isLogsRoute(hash), hash).toBe(true)
    }
  })

  it('rejects anything else, including deep links and an empty hash', () => {
    for (const hash of ['', '#', '#/session/ws1/sid1', '#/logs/extra', '#/login']) {
      expect(isLogsRoute(hash), hash).toBe(false)
    }
  })

  it('is not a deep link, so the main app never consumes it as one', () => {
    expect(parseDeepLink(LOGS_ROUTE_HASH.slice(1))).toBeNull()
  })
})

describe('logsUrl', () => {
  it('keeps the current path and query so the tab opens on the same server', () => {
    expect(logsUrl({ pathname: '/', search: '' })).toBe('/#/logs')
    expect(logsUrl({ pathname: '/c3/', search: '?ws=proj' })).toBe('/c3/?ws=proj#/logs')
  })
})
