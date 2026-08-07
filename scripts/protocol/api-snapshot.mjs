#!/usr/bin/env node
/**
 * Generates a structural API snapshot for the shared protocol entry points.
 *
 * The snapshot answers one question: does `@ccc/shared` / `@ccc/shared/protocol`
 * still expose exactly the same public surface? It records, per exported symbol,
 * whether it lives in the value space, the type space, or both, plus a
 * *structural* fingerprint of its type.
 *
 * The fingerprint recursively expands named aliases and interfaces into their
 * members, so it is invariant to how a type is spelled (inline object vs. named
 * alias) and sensitive only to the shape that actually travels on the wire.
 * That is what makes it a valid before/after comparison for a pure partition.
 *
 * The committed baseline lives at `shared/api-snapshot.json`. Regenerate it in a
 * change that touches the shared protocol, and land that regeneration as its OWN
 * commit: the surface delta is then readable on its own terms, instead of being
 * buried in the feature diff that caused it.
 *
 * Usage:
 *   node scripts/protocol/api-snapshot.mjs shared/api-snapshot.json
 *   node scripts/protocol/api-snapshot.mjs <outFile> [srcRoot]
 *
 * `srcRoot` defaults to the repo; pass a pristine checkout (e.g. a detached
 * `git worktree`) to snapshot a different revision with this same script, which
 * is how a before/after comparison is produced.
 */
import ts from 'typescript'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const outFile = process.argv[2]
const repoRoot = process.argv[3]
  ? path.resolve(process.argv[3])
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
if (!outFile) {
  console.error('usage: api-snapshot.mjs <outFile> [srcRoot]')
  process.exit(1)
}

const entries = [
  ['@ccc/shared/protocol', path.join(repoRoot, 'shared/src/protocol.ts')],
  ['@ccc/shared', path.join(repoRoot, 'shared/src/index.ts')],
]

const program = ts.createProgram({
  rootNames: entries.map(([, file]) => file),
  options: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    skipLibCheck: true,
    noEmit: true,
  },
})
const checker = program.getTypeChecker()

/** Depth cap: deep enough to reach every wire payload, shallow enough to end. */
const MAX_DEPTH = 12

/**
 * Canonical structural rendering of a type.
 *
 * Union members and object members are both sorted: neither carries meaning in
 * TypeScript's type identity, and the checker's own union ordering (by internal
 * type id) shifts whenever the program's file order changes — sorting is what
 * makes two runs comparable. Source-level arm order is asserted separately.
 */
function fingerprint(type, depth, stack) {
  if (depth > MAX_DEPTH) return '…'
  const id = type.id
  if (id !== undefined && stack.has(id)) return '#circular'

  const flags = type.flags
  if (flags & ts.TypeFlags.Any) return 'any'
  if (flags & ts.TypeFlags.Unknown) return 'unknown'
  if (flags & ts.TypeFlags.Never) return 'never'
  if (flags & ts.TypeFlags.Void) return 'void'
  if (flags & ts.TypeFlags.Undefined) return 'undefined'
  if (flags & ts.TypeFlags.Null) return 'null'
  if (flags & ts.TypeFlags.StringLiteral) return JSON.stringify(type.value)
  if (flags & ts.TypeFlags.NumberLiteral) return String(type.value)
  if (flags & ts.TypeFlags.BigIntLiteral) return `${type.value.base10Value}n`
  if (flags & ts.TypeFlags.BooleanLiteral) return checker.typeToString(type)
  if (flags & ts.TypeFlags.String) return 'string'
  if (flags & ts.TypeFlags.Number) return 'number'
  if (flags & ts.TypeFlags.Boolean) return 'boolean'
  if (flags & ts.TypeFlags.BigInt) return 'bigint'
  if (flags & ts.TypeFlags.ESSymbolLike) return 'symbol'
  if (flags & ts.TypeFlags.TypeParameter) return `<${checker.typeToString(type)}>`
  if (flags & ts.TypeFlags.Index) return `keyof ${fingerprint(type.type, depth + 1, stack)}`

  const next = id === undefined ? stack : new Set(stack).add(id)

  if (type.isUnion()) {
    return `(${type.types
      .map((t) => fingerprint(t, depth + 1, next))
      .sort()
      .join(' | ')})`
  }
  if (type.isIntersection()) {
    return `(${type.types
      .map((t) => fingerprint(t, depth + 1, next))
      .sort()
      .join(' & ')})`
  }
  if (checker.isArrayType?.(type)) {
    const [elem] = checker.getTypeArguments(type)
    return `${fingerprint(elem, depth + 1, next)}[]`
  }
  if (checker.isTupleType?.(type)) {
    const args = checker.getTypeArguments(type)
    return `[${args.map((t) => fingerprint(t, depth + 1, next)).join(', ')}]`
  }

  if (flags & ts.TypeFlags.Object) {
    const parts = []
    for (const sig of checker.getSignaturesOfType(type, ts.SignatureKind.Call)) {
      parts.push(`(): ${fingerprint(checker.getReturnTypeOfSignature(sig), depth + 1, next)}`)
    }
    for (const info of checker.getIndexInfosOfType(type)) {
      parts.push(
        `[${fingerprint(info.keyType, depth + 1, next)}]: ${fingerprint(info.type, depth + 1, next)}`,
      )
    }
    const props = checker
      .getPropertiesOfType(type)
      .slice()
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const prop of props) {
      const optional = prop.flags & ts.SymbolFlags.Optional ? '?' : ''
      const readonly = isReadonly(prop) ? 'readonly ' : ''
      const propType = checker.getTypeOfSymbolAtLocation(
        prop,
        prop.valueDeclaration ?? prop.declarations?.[0] ?? entryNode,
      )
      parts.push(`${readonly}${prop.name}${optional}: ${fingerprint(propType, depth + 1, next)}`)
    }
    return `{ ${parts.join('; ')} }`
  }

  return checker.typeToString(type)
}

function isReadonly(symbol) {
  return (symbol.declarations ?? []).some(
    (d) => (ts.getCombinedModifierFlags(d) & ts.ModifierFlags.Readonly) !== 0,
  )
}

let entryNode
const snapshot = {}

for (const [label, file] of entries) {
  const source = program.getSourceFile(file)
  if (!source) throw new Error(`source not found: ${file}`)
  entryNode = source
  const moduleSymbol = checker.getSymbolAtLocation(source)
  if (!moduleSymbol) throw new Error(`no module symbol: ${file}`)

  const exports = {}
  for (const symbol of checker.getExportsOfModule(moduleSymbol)) {
    const resolved = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol
    const space = []
    if (resolved.flags & ts.SymbolFlags.Value) space.push('value')
    if (resolved.flags & ts.SymbolFlags.Type) space.push('type')

    const decl = resolved.declarations?.[0]
    let shape
    if (resolved.flags & ts.SymbolFlags.Value) {
      shape = fingerprint(checker.getTypeOfSymbolAtLocation(resolved, decl ?? source), 0, new Set())
    } else {
      shape = fingerprint(checker.getDeclaredTypeOfSymbol(resolved), 0, new Set())
    }
    exports[symbol.name] = { space: space.join('+'), shape }
  }

  snapshot[label] = Object.fromEntries(
    Object.keys(exports)
      .sort()
      .map((k) => [k, exports[k]]),
  )
}

writeFileSync(outFile, JSON.stringify(snapshot, null, 2) + '\n')
const counts = entries.map(([label]) => `${label}: ${Object.keys(snapshot[label]).length}`)
console.log(`wrote ${outFile} (${counts.join(', ')})`)
