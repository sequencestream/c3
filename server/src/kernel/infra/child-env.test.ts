/**
 * Unit coverage for the platform-branching executable lookup (release 4/7).
 *
 * `claudeLookupCommand` is the pure seam extracted from `findClaudeExecutable` so the
 * Windows vs POSIX branch is testable WITHOUT spawning a real process: Windows has no
 * `sh`, so it must use `where`; POSIX uses the portable `command -v`.
 */
import { describe, expect, it } from 'vitest'
import { claudeLookupCommand } from './child-env.js'

describe('claudeLookupCommand', () => {
  it('uses `where claude` on Windows (no `sh` there)', () => {
    expect(claudeLookupCommand('win32')).toEqual(['where', ['claude']])
  })

  it('uses portable `sh -c command -v claude` on POSIX', () => {
    expect(claudeLookupCommand('darwin')).toEqual(['sh', ['-c', 'command -v claude']])
    expect(claudeLookupCommand('linux')).toEqual(['sh', ['-c', 'command -v claude']])
  })
})
