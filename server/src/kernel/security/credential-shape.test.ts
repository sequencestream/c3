/**
 * The credential-shape patterns, exercised directly (they used to be covered
 * only through the memory guard's `detectMemoryGuardViolation`). The
 * false-positive cases are as load-bearing as the true positives: a detector
 * that flags normal sentences stops legitimate text from ever leaving the
 * machine.
 */
import { describe, expect, it } from 'vitest'
import { detectCredentialShape } from './credential-shape.js'

describe('detectCredentialShape — credential shapes', () => {
  it.each([
    [
      'PEM private key',
      '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\n-----END OPENSSH PRIVATE KEY-----',
    ],
    ['bearer header', 'Authorization: Bearer sB3xQ0pLmN7vTz91aeKdRw'],
    ['github classic token', 'ghp_A1b2C3d4E5f6G7h8I9j0KlMnOpQrSt'],
    ['github fine-grained token', 'github_pat_11ABCDEFG0aBcDeFgHiJkLmNoPqRsTuVwXyZ'],
    ['openai-style key', 'sk-A1b2C3d4E5f6G7h8I9j0KlMn'],
    ['anthropic-style key', 'sk-ant-api03-Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk'],
    ['slack token', 'xoxb-1234567890-abcdefghij'],
    ['aws access key id', 'AKIAIOSFODNN7EXAMPLE'],
    ['c3 external key', 'c3k_9aF3kZq1WmT7Yx4RbN2vLd'],
    ['jwt', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N'],
    ['password assignment', 'password: hunter2hunter2hunter2'],
    ['secret assignment', 'SECRET="a1b2c3d4e5f6g7h8"'],
  ])('detects %s', (_label, value) => {
    expect(detectCredentialShape(value)).toBe(true)
  })
})

describe('ordinary prose stays clean', () => {
  it.each([
    '用户偏好:令牌一律由环境变量注入,不写进配置文件。',
    'CI 的 secret 由运维在 forge 上配置,开发本地不持有。',
    'password 策略由 IT 统一下发,c3 不参与也不存储。',
    '这个仓库的 API key 管理走 1Password,不进代码库。',
    'The user prefers Chinese commit bodies and no Co-Authored-By trailer.',
  ])('does not flag %s', (value) => {
    expect(detectCredentialShape(value)).toBe(false)
  })
})
