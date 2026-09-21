import { describe, expect, it } from 'vitest'
import { tarExtractInvocation } from './archive.js'

describe('tarExtractInvocation', () => {
  it('keeps a Windows drive letter out of the archive operand', () => {
    const archive = 'C:\\Users\\Administrator\\.c3\\vendor\\codex\\downloads\\0.155.1.tgz'
    const invocation = tarExtractInvocation(archive, 'C:\\Temp\\c3-codex', true)

    expect(invocation).toEqual({
      command: 'tar',
      args: ['-xzf', '0.155.1.tgz', '-C', 'C:\\Temp\\c3-codex'],
      cwd: 'C:\\Users\\Administrator\\.c3\\vendor\\codex\\downloads',
    })
  })

  it('uses a relative archive operand and auto-detection when requested', () => {
    expect(tarExtractInvocation('/tmp/install/artifact', '/tmp/unpack', false)).toEqual({
      command: 'tar',
      args: ['-xf', 'artifact', '-C', '/tmp/unpack'],
      cwd: '/tmp/install',
    })
  })
})
