/**
 * The redaction patterns, exercised directly. The false-positive cases are as
 * load-bearing as the true positives: a redactor that mangles ordinary prose
 * corrupts the very error summaries it is protecting.
 */
import { describe, expect, it } from 'vitest'
import { redactSecrets } from './credential-redact.js'

describe('redactSecrets — secret-shaped substring redaction', () => {
  it('redacts GitHub / generic tokens from free text', () => {
    const out = redactSecrets('token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 leaked')
    expect(out).not.toContain('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345')
    expect(out).toContain('[redacted]')
  })

  it('redacts vendor tokens of several shapes', () => {
    const out = redactSecrets(
      'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 github_pat_11ABCDEFG0aBcDeFgHiJkLmNoPqRsTuVwXyZ glpat-ABCDEFGHIJKLMNOP1234 sk-abcdefghijklmnopqrstuvwxyz',
    )
    expect(out).not.toMatch(/ghp_|github_pat_|glpat-|sk-[A-Za-z]/)
    expect(out).toContain('[redacted]')
  })

  it('redacts a key=value secret and a bearer token', () => {
    const out = redactSecrets(
      'api_key=sk-abcdefghijklmnopqrstuvwxyz Authorization: bearer foobarbazqux',
    )
    expect(out).not.toContain('sk-abcdefghijklmnopqrstuvwxyz')
    expect(out.toLowerCase()).not.toContain('bearer foobar')
  })

  it('redacts JWTs and long hex blobs', () => {
    const out = redactSecrets(
      'token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N hash abcdef0123456789abcdef0123456789abcdef01',
    )
    expect(out).not.toContain('eyJhbGciOiJIUzI1NiJ9')
    expect(out).not.toContain('abcdef0123456789abcdef0123456789abcdef01')
  })

  it('does not touch ordinary prose that merely mentions a credential by name', () => {
    for (const s of [
      'token 由环境变量注入,不写进配置文件。',
      'CI 的 secret 由运维在 forge 上配置,开发本地不持有。',
      'password 策略由 IT 统一下发,c3 不参与也不存储。',
      '这个仓库的 API key 管理走 1Password,不进代码库。',
      'The user prefers Chinese commit bodies and no Co-Authored-By trailer.',
    ]) {
      expect(redactSecrets(s)).toBe(s)
    }
  })
})
