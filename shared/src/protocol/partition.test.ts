import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

/**
 * Structural guards for the protocol partition.
 *
 * `protocol.ts` is a barrel plus the single assembly point for the two message
 * unions; the wire contract itself lives in `protocol/*.ts`. These tests pin
 * that arrangement so the file cannot silently grow back into the monolith:
 * they check its size and statement shape, that the unions have exactly one
 * definition site, that no declaration is defined twice, that the module graph
 * stays acyclic, and that message payload types never leak onto the public
 * `@ccc/shared/protocol` surface.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BARREL = path.join(HERE, '../protocol.ts')
const barrel = readFileSync(BARREL, 'utf8')
const barrelLines = barrel.split('\n')

const moduleFiles = readdirSync(HERE)
  .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
  .sort()
const modelFiles = moduleFiles.filter((f) => !f.endsWith('-messages.ts'))
const messageFiles = moduleFiles.filter((f) => f.endsWith('-messages.ts'))

const read = (f: string) => readFileSync(path.join(HERE, f), 'utf8')

/** Top-level exported declaration names in a module (one per `export` line). */
function exportedNames(source: string): string[] {
  return source
    .split('\n')
    .map((l) => /^export (?:type|interface|const|function|class) (\w+)/.exec(l)?.[1])
    .filter((n): n is string => Boolean(n))
}

/** Relative specifiers a module imports from or re-exports. */
function specifiers(source: string): string[] {
  return [...source.matchAll(/from '(\.[^']*)'/g)].map((m) => m[1])
}

describe('protocol partition', () => {
  it('keeps protocol.ts a barrel under the 800-line budget', () => {
    expect(barrelLines.length).toBeLessThan(800)
  })

  it('lets protocol.ts hold nothing but re-exports, type imports and the two unions', () => {
    const code = barrelLines
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('//') && !l.startsWith('*') && !l.startsWith('/*'))

    const allowed = [
      /^export \* from '\.\/protocol\/[\w-]+\.js'$/,
      /^import type \* as \w+ from '\.\/protocol\/[\w-]+-messages\.js'$/,
      /^export type (?:ClientToServer|ServerToClient) =$/,
      /^\| \w+\.\w+$/,
    ]
    const offenders = code.filter((l) => !allowed.some((re) => re.test(l)))
    expect(offenders).toEqual([])
  })

  it('re-exports every model module and no message module', () => {
    const reExported = [...barrel.matchAll(/^export \* from '\.\/protocol\/([\w-]+)\.js'$/gm)].map(
      (m) => `${m[1]}.ts`,
    )
    expect(reExported.sort()).toEqual(modelFiles)
    // Message payload types are internal: re-exporting one would widen the
    // public `@ccc/shared/protocol` surface.
    expect(reExported.filter((f) => f.endsWith('-messages.ts'))).toEqual([])
  })

  it('defines the two message unions exactly once, in protocol.ts', () => {
    for (const union of ['ClientToServer', 'ServerToClient']) {
      const re = new RegExp(`^export type ${union}\\b`, 'gm')
      expect(barrel.match(re)).toHaveLength(1)
      for (const f of moduleFiles) {
        expect(read(f).match(re) ?? [], `${f} must not define ${union}`).toHaveLength(0)
      }
    }
  })

  it('declares every public symbol in exactly one module', () => {
    const owner = new Map<string, string>()
    const duplicates: string[] = []
    for (const f of moduleFiles) {
      for (const name of exportedNames(read(f))) {
        const prev = owner.get(name)
        if (prev) duplicates.push(`${name}: ${prev} + ${f}`)
        else owner.set(name, f)
      }
    }
    expect(duplicates).toEqual([])
  })

  it('assembles each message payload type into exactly one union arm', () => {
    const arms = [...barrel.matchAll(/^ {2}\| \w+\.(\w+)$/gm)].map((m) => m[1])
    const declared = messageFiles.flatMap((f) => exportedNames(read(f)))
    expect(new Set(arms).size, 'an arm is listed twice').toBe(arms.length)
    expect(arms.slice().sort()).toEqual(declared.slice().sort())
  })

  it('keeps the module graph acyclic', () => {
    const graph = new Map<string, string[]>()
    graph.set(
      'protocol.ts',
      specifiers(barrel)
        .filter((s) => s.startsWith('./protocol/'))
        .map((s) => s.replace('./protocol/', '').replace(/\.js$/, '.ts')),
    )
    for (const f of moduleFiles) {
      graph.set(
        f,
        specifiers(read(f))
          .filter((s) => s.startsWith('./'))
          .map((s) => s.replace('./', '').replace(/\.js$/, '.ts')),
      )
    }

    const state = new Map<string, 'visiting' | 'done'>()
    const cycles: string[] = []
    const visit = (node: string, trail: string[]) => {
      if (state.get(node) === 'done') return
      if (state.get(node) === 'visiting') {
        cycles.push([...trail.slice(trail.indexOf(node)), node].join(' -> '))
        return
      }
      state.set(node, 'visiting')
      for (const dep of graph.get(node) ?? []) visit(dep, [...trail, node])
      state.set(node, 'done')
    }
    for (const node of graph.keys()) visit(node, [])
    expect(cycles).toEqual([])
  })
})
