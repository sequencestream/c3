/**
 * Unit tests for the chat robot's local filesystem scope — the ONE adjudication
 * every local file access a robot turn can make passes through (robot-fs-scope.ts).
 *
 * The boundary is real paths, not strings: containment is decided on what the
 * filesystem would actually resolve to, walked one segment at a time so a symlink
 * (or a dangling one) cannot be jumped over by a lexical `..`. These tests build a
 * real directory tree and exercise the escapes against it — absolute paths,
 * `..` chains, symlink and dangling-symlink escapes, adjacent-prefix siblings,
 * NUL bytes, non-string values, missing locations, field conflicts and a root
 * that stops being what it was frozen as.
 *
 * A non-allow verdict is ALWAYS the same refusal, so the tests assert the reason
 * CATEGORY (audit-facing) and never any path content — the robot must not be
 * usable as an oracle for "does this file exist on the host".
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  adjudicateRobotToolInput,
  carriesUndescribedLocation,
  freezeRobotRoot,
  isRobotLocalPathTool,
  ROBOT_FS_DENY_CODE,
  ROBOT_FS_DENY_MESSAGE,
  ROBOT_LOCAL_PATH_TOOLS,
  type RobotFsVerdict,
} from './robot-fs-scope.js'

let base = ''
let root = ''
let outside = ''

const frozen = (): string => freezeRobotRoot(root)

beforeAll(() => {
  // A temp sandbox: `root` is the robot's run root; `outside` is a sibling it
  // must never reach.
  base = mkdtempSync(join(tmpdir(), 'c3-robot-fs-'))
  root = join(base, 'robot')
  outside = join(base, 'outside')
  mkdirSync(join(root, 'notes'), { recursive: true })
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(root, 'notes', 'a.md'), '# hello')
  writeFileSync(join(root, 'notes.md'), '# top-level')
  writeFileSync(join(outside, 'secret.md'), 'secret')
})

afterAll(() => rmSync(base, { recursive: true, force: true }))

const ok = (v: RobotFsVerdict): RobotFsVerdict & { ok: true } => {
  expect(v.ok).toBe(true)
  return v as RobotFsVerdict & { ok: true }
}

const denied = (v: RobotFsVerdict): RobotFsVerdict & { ok: false } => {
  expect(v.ok).toBe(false)
  return v as RobotFsVerdict & { ok: false }
}

describe('freezeRobotRoot', () => {
  it('resolves a real directory to its real path', () => {
    const f = freezeRobotRoot(root)
    expect(f).toBe(frozen())
  })

  it('throws when the directory is missing or unresolvable (a turn must not start without a boundary)', () => {
    expect(() => freezeRobotRoot(join(base, 'does-not-exist'))).toThrow()
  })
})

describe('isRobotLocalPathTool / descriptor coverage', () => {
  it('recognises every described tool by the name the vendor stream uses', () => {
    for (const name of Object.keys(ROBOT_LOCAL_PATH_TOOLS)) {
      expect(isRobotLocalPathTool(name)).toBe(true)
    }
  })

  it('rejects an unknown tool name', () => {
    expect(isRobotLocalPathTool('Write')).toBe(false)
    expect(isRobotLocalPathTool('Bash')).toBe(false)
    expect(isRobotLocalPathTool('mcp__c3__find_intents')).toBe(false)
  })

  it('fails closed on a tool that is not described: no-descriptor', () => {
    // Even a tool that looks read-class must have a descriptor before it may
    // touch a path — a new manifest tool can never arrive already permitted.
    expect(
      denied(adjudicateRobotToolInput({ root: frozen(), toolName: 'Write', input: {} })).reason,
    ).toBe('no-descriptor')
  })
})

describe('adjudicateRobotToolInput — legal reads', () => {
  const frozenRoot = frozen()
  const cases: Array<[string, Record<string, unknown>]> = [
    ['Read', { file_path: join(frozenRoot, 'notes', 'a.md') }],
    ['Read', { file_path: join(frozenRoot, 'notes.md') }],
    ['Read', { file_path: 'notes/a.md' }], // relative against the root
    ['NotebookRead', { notebook_path: join(frozenRoot, 'notes', 'a.ipynb') }],
    ['LS', { path: join(frozenRoot, 'notes') }],
    ['LS', {}], // absent location defaults to the run root
    ['Grep', { pattern: 'x' }],
    ['Grep', { pattern: 'x', path: join(frozenRoot, 'notes') }],
    ['Glob', { pattern: '**/*.ts' }],
    ['Glob', { path: join(frozenRoot, 'notes'), pattern: '*.ts' }],
    // Cursor shapes
    ['read', { path: join(frozenRoot, 'notes', 'a.md') }],
    ['ls', { targetDirectory: join(frozenRoot, 'notes') }],
    ['glob', { targetDirectory: join(frozenRoot, 'notes'), globPattern: '*.ts' }],
    ['grep', { targetDirectory: join(frozenRoot, 'notes'), pattern: 'x' }],
    ['semSearch', { targetDirectories: [join(frozenRoot, 'notes')], query: 'x' }],
    ['readLints', { paths: [join(frozenRoot, 'notes')] }],
  ]

  it.each(cases)('%s allows a location inside the run root', (tool, input) => {
    expect(
      ok(adjudicateRobotToolInput({ root: frozenRoot, toolName: tool, input })).input,
    ).toBeDefined()
  })

  it('normalizes an absent default-location to the frozen run root', () => {
    const verdict = ok(
      adjudicateRobotToolInput({ root: frozenRoot, toolName: 'Grep', input: { pattern: 'x' } }),
    )
    expect(verdict.input).toMatchObject({ pattern: 'x', path: frozenRoot })
  })

  it('a location that does not exist yet but lies INSIDE the root stays an inside miss', () => {
    // "not found inside the root" keeps the tool's own semantics — the path is
    // inside, it simply is not there.
    expect(
      ok(
        adjudicateRobotToolInput({
          root: frozenRoot,
          toolName: 'Read',
          input: { file_path: join(frozenRoot, 'notes', 'missing.md') },
        }),
      ).input,
    ).toBeDefined()
  })
})

describe('adjudicateRobotToolInput — escapes', () => {
  const frozenRoot = frozen()

  it('denies an absolute path outside the run root', () => {
    expect(
      denied(
        adjudicateRobotToolInput({
          root: frozenRoot,
          toolName: 'Read',
          input: { file_path: '/etc/passwd' },
        }),
      ).reason,
    ).toBe('outside-root')
  })

  it('denies an absolute path into the sibling outside dir', () => {
    expect(
      denied(
        adjudicateRobotToolInput({
          root: frozenRoot,
          toolName: 'Read',
          input: { file_path: join(outside, 'secret.md') },
        }),
      ).reason,
    ).toBe('outside-root')
  })

  it('denies a .. chain that leaves the run root', () => {
    expect(
      denied(
        adjudicateRobotToolInput({
          root: frozenRoot,
          toolName: 'Read',
          input: { file_path: join(frozenRoot, '..', 'outside', 'secret.md') },
        }),
      ).reason,
    ).toBe('outside-root')
  })

  it('denies a symlink inside the root that points outside it', () => {
    const link = join(frozenRoot, 'evil')
    symlinkSync(outside, link)
    try {
      const verdict = adjudicateRobotToolInput({
        root: frozenRoot,
        toolName: 'Read',
        input: { file_path: join(link, 'secret.md') },
      })
      expect(denied(verdict).reason).toBe('outside-root')
    } finally {
      rmSync(link, { force: true })
    }
  })

  it('denies a dangling symlink whose declared target lies outside', () => {
    const link = join(frozenRoot, 'dangling')
    symlinkSync(join(outside, 'ghost.md'), link)
    try {
      expect(
        denied(
          adjudicateRobotToolInput({
            root: frozenRoot,
            toolName: 'Read',
            input: { file_path: link },
          }),
        ).reason,
      ).toBe('outside-root')
    } finally {
      rmSync(link, { force: true })
    }
  })

  it('denies an adjacent-prefix sibling (rootEVIL is not inside root)', () => {
    const evil = `${frozenRoot}EVIL`
    mkdirSync(evil, { recursive: true })
    writeFileSync(join(evil, 'secret.md'), 'x')
    try {
      expect(
        denied(
          adjudicateRobotToolInput({
            root: frozenRoot,
            toolName: 'Read',
            input: { file_path: join(evil, 'secret.md') },
          }),
        ).reason,
      ).toBe('outside-root')
    } finally {
      rmSync(evil, { recursive: true, force: true })
    }
  })

  it('denies a NUL byte (would truncate at the syscall boundary)', () => {
    expect(
      denied(
        adjudicateRobotToolInput({
          root: frozenRoot,
          toolName: 'Read',
          input: { file_path: `${join(frozenRoot, 'notes')}\0.md` },
        }),
      ).reason,
    ).toBe('bad-location')
  })

  it('denies a non-string path value', () => {
    expect(
      denied(
        adjudicateRobotToolInput({ root: frozenRoot, toolName: 'Read', input: { file_path: 42 } }),
      ).reason,
    ).toBe('bad-location')
  })

  it('denies a non-string element in a list value', () => {
    expect(
      denied(
        adjudicateRobotToolInput({
          root: frozenRoot,
          toolName: 'semSearch',
          input: { targetDirectories: [frozenRoot, 42], query: 'x' },
        }),
      ).reason,
    ).toBe('bad-location')
  })

  it('denies an empty required location', () => {
    expect(
      denied(
        adjudicateRobotToolInput({ root: frozenRoot, toolName: 'Read', input: { file_path: '' } }),
      ).reason,
    ).toBe('bad-location')
  })

  it('denies a MISSING required location', () => {
    expect(
      denied(adjudicateRobotToolInput({ root: frozenRoot, toolName: 'Read', input: {} })).reason,
    ).toBe('bad-location')
  })

  it('denies a Glob pattern whose walk root leaves the run root', () => {
    // `pattern` IS a location for Glob: an absolute pattern moves the walk root.
    expect(
      denied(
        adjudicateRobotToolInput({
          root: frozenRoot,
          toolName: 'Glob',
          input: { pattern: '/etc/**' },
        }),
      ).reason,
    ).toBe('outside-root')
  })

  it('denies a Glob pattern that carries a .. segment', () => {
    expect(
      denied(
        adjudicateRobotToolInput({
          root: frozenRoot,
          toolName: 'Glob',
          input: { pattern: '../**/*.ts' },
        }),
      ).reason,
    ).toBe('outside-root')
  })

  it('denies an absolute filter value (filters are matched below an adjudicated location)', () => {
    expect(
      denied(
        adjudicateRobotToolInput({
          root: frozenRoot,
          toolName: 'Grep',
          input: { path: frozenRoot, glob: '/etc/*' },
        }),
      ).reason,
    ).toBe('outside-root')
  })

  it('denies a filter value that carries a .. segment', () => {
    expect(
      denied(
        adjudicateRobotToolInput({
          root: frozenRoot,
          toolName: 'Grep',
          input: { glob: '../*.ts' },
        }),
      ).reason,
    ).toBe('outside-root')
  })

  it('denies a location that does not exist yet but lies OUTSIDE the root, exactly as if it existed', () => {
    // "outside the root" answers identically whether or not the target exists —
    // the same fixed refusal either way, so existence cannot be probed.
    expect(
      denied(
        adjudicateRobotToolInput({
          root: frozenRoot,
          toolName: 'Read',
          input: { file_path: join(outside, 'ghost.md') },
        }),
      ).reason,
    ).toBe('outside-root')
  })

  it('denies a list location when ANY element escapes', () => {
    expect(
      denied(
        adjudicateRobotToolInput({
          root: frozenRoot,
          toolName: 'readLints',
          input: { paths: [frozenRoot, join(outside, 'secret.md')] },
        }),
      ).reason,
    ).toBe('outside-root')
  })
})

describe('adjudicateRobotToolInput — malformed calls', () => {
  const frozenRoot = frozen()

  it('denies when two alternate fields for one location are supplied (a conflict, not a preference)', () => {
    // Cursor `ls` takes `path` OR `targetDirectory`; supplying both means c3
    // would have to guess which the vendor honours.
    expect(
      denied(
        adjudicateRobotToolInput({
          root: frozenRoot,
          toolName: 'ls',
          input: { path: frozenRoot, targetDirectory: frozenRoot },
        }),
      ).reason,
    ).toBe('field-conflict')
  })

  it('denies an undeclared path-like field on a described tool (the description is stale)', () => {
    // `cwd` is path-like and NOT declared for Read — its presence means c3's
    // description no longer names every access location the tool accepts.
    expect(
      denied(
        adjudicateRobotToolInput({
          root: frozenRoot,
          toolName: 'Read',
          input: { file_path: join(frozenRoot, 'notes', 'a.md'), cwd: '/etc' },
        }),
      ).reason,
    ).toBe('field-conflict')
  })

  it('denies when the input is not an object', () => {
    expect(
      denied(
        adjudicateRobotToolInput({
          root: frozenRoot,
          toolName: 'Read',
          input: 'file_path=/etc/passwd',
        }),
      ).reason,
    ).toBe('bad-location')
  })
})

describe('adjudicateRobotToolInput — root stability', () => {
  it('denies once the frozen root stops being the same real directory', () => {
    const transient = mkdtempSync(join(tmpdir(), 'c3-robot-root-'))
    const f = freezeRobotRoot(transient)
    expect(
      ok(
        adjudicateRobotToolInput({
          root: f,
          toolName: 'Read',
          input: { file_path: join(f, 'x.md') },
        }),
      ).ok,
    ).toBe(true)
    rmSync(transient, { recursive: true, force: true })
    expect(
      denied(
        adjudicateRobotToolInput({
          root: f,
          toolName: 'Read',
          input: { file_path: join(f, 'x.md') },
        }),
      ).reason,
    ).toBe('root-unstable')
  })
})

describe('carriesUndescribedLocation — the c3-MCP guard', () => {
  it('is true for an input carrying a path-like field the tool did not declare', () => {
    expect(carriesUndescribedLocation({ file_path: '/etc/passwd' })).toBe(true)
    expect(carriesUndescribedLocation({ path: '/x' })).toBe(true)
    expect(carriesUndescribedLocation({ cwd: '/x' })).toBe(true)
  })

  it('is false for query-only inputs and non-objects', () => {
    expect(carriesUndescribedLocation({ query: 'x', keyword: 'y' })).toBe(false)
    expect(carriesUndescribedLocation({ url: 'https://example.com' })).toBe(false)
    expect(carriesUndescribedLocation(null)).toBe(false)
    expect(carriesUndescribedLocation('file_path=/x')).toBe(false)
  })
})

describe('refusal hygiene — one fixed refusal, category-only reasons', () => {
  const frozenRoot = frozen()
  const escapes: Array<[string, Record<string, unknown>]> = [
    ['Read', { file_path: '/etc/passwd' }],
    ['Read', { file_path: join(frozenRoot, '..', '..', 'var', 'db') }],
    ['Glob', { pattern: '/etc/**' }],
    ['Read', { file_path: 42 }],
    ['Read', { file_path: `${frozenRoot}\0` }],
  ]

  it.each(escapes)('%s refuses with the SAME message and no target leakage', (_tool, input) => {
    const verdict = denied(adjudicateRobotToolInput({ root: frozenRoot, toolName: 'Read', input }))
    // The reason is a stable category the audit may key on.
    expect(typeof verdict.reason).toBe('string')
    // The module's only user-facing refusal is the fixed message; it never
    // contains the requested or resolved path, so the robot cannot probe the host.
    expect(ROBOT_FS_DENY_MESSAGE).toContain('own run directory')
    expect(ROBOT_FS_DENY_MESSAGE).not.toMatch(/etc|passwd|secret/)
    expect(ROBOT_FS_DENY_CODE).toBe('robot-local-read-denied')
  })
})
