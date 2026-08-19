/**
 * The deny patterns, exercised directly so the two failure modes stay separable:
 * a credential shape and an artifact shape are refused for different stated
 * reasons, and ordinary prose that merely TALKS about credentials or code is not.
 *
 * The false-positive cases are as load-bearing as the true positives. A guard that
 * refuses normal sentences trains the model to stop writing memories at all, which
 * is the same outcome as having no memory.
 */
import { describe, expect, it } from 'vitest'
import { detectMemoryGuardViolation, memoryGuardMessage } from './content-guard.js'

describe('credential shapes', () => {
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
  ])('refuses %s', (_label, value) => {
    expect(detectMemoryGuardViolation(value)).toBe('credential')
  })
})

describe('artifact shapes', () => {
  it.each([
    ['a fenced block', '写法是\n```ts\nconst a = 1\n```'],
    ['a tilde fence', '~~~\nls -la\n~~~'],
    ['tool-call framing', '<invoke name="Bash">'],
    ['tool-result framing', '<tool_result>done</tool_result>'],
    ['harness tag framing', '<invoke name="Read">'],
    ['a role transcript', 'user: 改一下\nassistant: 好'],
    ['a raw message object', '{ "role": "assistant", "content": "hi" }'],
  ])('refuses %s', (_label, value) => {
    expect(detectMemoryGuardViolation(value)).toBe('artifact')
  })
})

describe('ordinary prose stays writable', () => {
  it.each([
    '用户偏好:令牌一律由环境变量注入,不写进配置文件。',
    'CI 的 secret 由运维在 forge 上配置,开发本地不持有。',
    '教训:提交前必须跑 pnpm allcheck,否则 CI 会在 lint 阶段挂掉。',
    'password 策略由 IT 统一下发,c3 不参与也不存储。',
    '这个仓库的 API key 管理走 1Password,不进代码库。',
    'The user prefers Chinese commit bodies and no Co-Authored-By trailer.',
    '部署目标是 staging,不是 production —— 用户在 2026 年确认过。',
    'bearer 认证由网关统一处理,应用层不解析。',
  ])('accepts %s', (value) => {
    expect(detectMemoryGuardViolation(value)).toBeNull()
  })
})

describe('the refusal message', () => {
  it('names the field and the category without quoting the input', () => {
    const secret = 'ghp_A1b2C3d4E5f6G7h8I9j0KlMnOpQrSt'
    const msg = memoryGuardMessage(detectMemoryGuardViolation(secret)!, 'content')
    expect(msg).toContain('content')
    expect(msg).toContain('凭据')
    expect(msg).not.toContain(secret)
  })

  it('tells the caller what to write instead of the artifact it refused', () => {
    const msg = memoryGuardMessage('artifact', 'title')
    expect(msg).toContain('title')
    expect(msg).toContain('结论')
  })
})
