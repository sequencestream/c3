/**
 * The read-only spec analyzer: `analyzeSpec(markdown) → SpecWarning[]`.
 *
 * A PURE function — no file reads, no writes, no logging, no clock, no
 * randomness. It takes text and returns warnings; recording them is somebody
 * else's job. That is what lets it run at both session-launch hooks without
 * being able to affect either session: the worst it can do is return an array.
 *
 * Every warning is `warn`. There is deliberately no blocking branch here and no
 * length-shaped check: the discipline has no word, character or sentence-length
 * threshold to enforce, and a detector that could enforce one would make the
 * threshold the rule instead of the shape. The tier line budgets are authoring
 * guidance only and are never counted.
 *
 * Counting checks run against a STRIPPED view of the document — fenced code,
 * tables, HTML comments and Given/When/Then blocks describe code, data and
 * test scenarios, not the spec's prose, and counting them would misattribute a
 * shape to the author.
 */

import { SPEC_RULES, specRuleForDetection, type SpecRuleDetectionKind } from './spec-rules.js'

export interface SpecWarning {
  /** The ruleset entry this came from — the metric row key. */
  readonly ruleId: string
  readonly detection: SpecRuleDetectionKind
  /** Always `warn`: this stage has no blocking branch by construction. */
  readonly severity: 'warn'
  /** Where in the document the shape was found. */
  readonly location: {
    /** Enclosing markdown heading, or `(preamble)` before the first one. */
    readonly section: string
    /** 1-based line number in the ORIGINAL markdown. */
    readonly line: number
  }
  /** The rule's own message, so a stored warning reads without the ruleset. */
  readonly message: string
}

interface Line {
  readonly number: number
  readonly text: string
  readonly section: string
  /** True when this line is code / table / comment / GWT and must not be counted. */
  readonly stripped: boolean
}

const FENCE = /^\s*(?:```|~~~)/
const TABLE_ROW = /^\s*\|.*\|\s*$/
const HTML_COMMENT = /^\s*<!--/
const GWT_LINE = /^\s*(?:-|\*|\d+\.)?\s*(?:given|when|then|假设|当|则)\b\s*[:：]?/i

/**
 * Build the line view plus the stripped subset the counting checks read.
 * Positions always refer to the ORIGINAL document, so a warning points at the
 * line the author will see.
 */
function readLines(markdown: string): { all: Line[]; prose: Line[] } {
  const all: Line[] = []
  let section = '(preamble)'
  let inFence = false
  let inComment = false

  const lines = markdown.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const text = raw ?? ''

    if (inFence) {
      all.push({ number: i + 1, text, section, stripped: true })
      if (FENCE.test(text)) inFence = false
      continue
    }
    if (inComment) {
      all.push({ number: i + 1, text, section, stripped: true })
      if (text.includes('-->')) inComment = false
      continue
    }
    if (FENCE.test(text)) {
      inFence = !text.trimEnd().endsWith('```') && !text.trimEnd().endsWith('~~~') ? true : false
      all.push({ number: i + 1, text, section, stripped: true })
      continue
    }
    if (HTML_COMMENT.test(text)) {
      // A comment may open and close on one line, or span several.
      const closes = text.includes('-->')
      if (!closes) inComment = true
      all.push({ number: i + 1, text, section, stripped: true })
      continue
    }
    if (TABLE_ROW.test(text)) {
      // Table rows (including the |---|---| separator) are data, not prose.
      all.push({ number: i + 1, text, section, stripped: true })
      continue
    }
    if (GWT_LINE.test(text)) {
      // Given/When/Then is a test scenario template — its shape is the
      // template's, not the spec's.
      all.push({ number: i + 1, text, section, stripped: true })
      continue
    }

    const heading = text.match(/^\s{0,3}#{1,6}\s+(.*\S)\s*$/)
    if (heading) {
      section = heading[1] ?? section
      all.push({ number: i + 1, text, section, stripped: true })
      continue
    }

    all.push({ number: i + 1, text, section, stripped: false })
  }

  return { all, prose: all.filter((line) => !line.stripped) }
}

// ---- shared normalisation ----

/** Drop the markdown scaffolding so two renderings of one sentence compare equal. */
function normalize(text: string): string {
  return text
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*|__|\*|_/g, '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
    .replace(/^\s*>\s?/, '')
    .replace(/^\s*#+\s*/, '')
    .replace(/[\s]+/g, '')
    .toLowerCase()
}

/** Split a line into sentences on Chinese and Latin terminators. */
function sentences(text: string): string[] {
  return text
    .split(/(?<=[。；;!?！？])\s*/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/** Character bigrams — a cheap shape signature that ignores word order edges. */
function bigrams(value: string): Set<string> {
  const out = new Set<string>()
  for (let i = 0; i < value.length - 1; i++) out.add(value.slice(i, i + 2))
  return out
}

/** Jaccard overlap of two bigram sets. */
function similarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const gram of a) if (b.has(gram)) shared++
  return shared / (a.size + b.size - shared)
}

// ---- detections ----

/**
 * A duplicate needs enough shared shape to be a restatement rather than a
 * coincidence. This floor is a similarity threshold for the DETECTOR, not a
 * length rule about the author's prose — no warning is ever raised because a
 * sentence is too long or too short.
 */
const DUPLICATE_MIN_LENGTH = 20
const DUPLICATE_MIN_SIMILARITY = 0.72

function duplicateNormativeFacts(prose: Line[]): SpecWarning[] {
  const rule = specRuleForDetection('duplicate_normative_fact')
  if (!rule) return []
  const message = rule.statement

  const units: { line: Line; norm: string; grams: Set<string> }[] = []
  for (const line of prose) {
    for (const sentence of sentences(line.text)) {
      const norm = normalize(sentence)
      if (norm.length < DUPLICATE_MIN_LENGTH) continue
      units.push({ line, norm, grams: bigrams(norm) })
    }
  }

  const warnings: SpecWarning[] = []
  const reported = new Set<string>()
  for (let i = 0; i < units.length; i++) {
    for (let j = i + 1; j < units.length; j++) {
      const a = units[i]!
      const b = units[j]!
      // A restatement elsewhere in the document, not the same line twice.
      if (a.line.number === b.line.number) continue
      if (a.line.section === b.line.section) continue
      if (similarity(a.grams, b.grams) < DUPLICATE_MIN_SIMILARITY) continue
      const key = `${a.line.number}:${b.line.number}`
      if (reported.has(key)) continue
      reported.add(key)
      warnings.push({
        ruleId: rule.id,
        detection: 'duplicate_normative_fact',
        severity: 'warn',
        location: { section: b.line.section, line: b.line.number },
        message,
      })
    }
  }
  return warnings
}

const NAV_TOKEN =
  /(?:[\w.-]+\/)+[\w.-]+\.[a-z]{1,5}|\b[\w-]+\.(?:ts|vue|md|sql|go|mjs|cjs)\b|:\d+\b/g
const NORMATIVE_MODAL =
  /(?:必须|应当|不得|禁止|需要|要求|务必|一律|一律不得)|(?:\bmust\b|\bshall\b|\bshould\b|\bmay not\b)/i

function navigationAsConstraint(prose: Line[]): SpecWarning[] {
  const rule = specRuleForDetection('navigation_as_constraint')
  if (!rule) return []
  return prose
    .filter((line) => {
      const nav = line.text.match(NAV_TOKEN)
      // A line that is mostly navigation AND states a requirement: the
      // constraint is riding on things the source owns.
      return !!nav && nav.length >= 3 && NORMATIVE_MODAL.test(line.text)
    })
    .map((line) => ({
      ruleId: rule.id,
      detection: 'navigation_as_constraint' as const,
      severity: 'warn' as const,
      location: { section: line.section, line: line.number },
      message: rule.statement,
    }))
}

const HANDOFF_HEADING =
  /^\s{0,3}#{1,6}\s+(?:implementation\s+handoff|handoff|implementation\s+notes|实施交接|实现交接|落地交接)\s*$/i

function redundantHandoffSection(all: Line[]): SpecWarning[] {
  const rule = specRuleForDetection('redundant_handoff_section')
  if (!rule) return []
  return all
    .filter((line) => HANDOFF_HEADING.test(line.text))
    .map((line) => ({
      ruleId: rule.id,
      detection: 'redundant_handoff_section' as const,
      severity: 'warn' as const,
      location: { section: line.section, line: line.number },
      message: rule.statement,
    }))
}

function emptyHeadings(all: Line[]): SpecWarning[] {
  const rule = specRuleForDetection('empty_heading')
  if (!rule) return []
  const warnings: SpecWarning[] = []
  for (let i = 0; i < all.length; i++) {
    const line = all[i]!
    const heading = line.text.match(/^\s{0,3}#{2,6}\s+(.*\S)\s*$/)
    if (!heading) continue
    let hasBody = false
    for (let j = i + 1; j < all.length; j++) {
      const next = all[j]!
      if (/^\s{0,3}#{1,6}\s+/.test(next.text)) break
      if (next.text.trim().length > 0) {
        hasBody = true
        break
      }
    }
    if (hasBody) continue
    warnings.push({
      ruleId: rule.id,
      detection: 'empty_heading',
      severity: 'warn',
      location: { section: line.section, line: line.number },
      message: rule.statement,
    })
  }
  return warnings
}

const CONNECTIVES = [
  '因此',
  '所以',
  '然后',
  '接着',
  '同时',
  '此外',
  '另外',
  '并且',
  '而且',
  '然而',
  '因此',
  'therefore',
  'moreover',
  'furthermore',
  'however',
  'thus',
]

function repeatedConnectives(prose: Line[]): SpecWarning[] {
  const rule = specRuleForDetection('repeated_connective')
  if (!rule) return []
  const bySection = new Map<string, Line[]>()
  for (const line of prose) {
    if (line.text.trim().length === 0) continue
    const bucket = bySection.get(line.section)
    if (bucket) bucket.push(line)
    else bySection.set(line.section, [line])
  }

  const warnings: SpecWarning[] = []
  for (const lines of bySection.values()) {
    if (lines.length < 2) continue
    const body = lines.map((l) => normalize(l.text)).join('')
    for (const connective of CONNECTIVES) {
      const needle = connective.toLowerCase()
      let count = 0
      let at = body.indexOf(needle)
      while (at !== -1) {
        count++
        at = body.indexOf(needle, at + needle.length)
      }
      if (count < 2) continue
      const where = lines[0]!
      warnings.push({
        ruleId: rule.id,
        detection: 'repeated_connective',
        severity: 'warn',
        location: { section: where.section, line: where.number },
        message: rule.statement,
      })
      break
    }
  }
  return warnings
}

const PASSIVE =
  /被[^。；;]{0,20}(?:为|成|改|删|加|限制|约束|覆盖|调用|触发|拦截)|(?:由|经)[^。；;]{0,12}(?:使|让|决定|约束|覆盖|驱动|触发|保证|完成|生成|处理|所)/

function passiveVoice(prose: Line[]): SpecWarning[] {
  const rule = specRuleForDetection('passive_voice')
  if (!rule) return []
  return prose
    .filter((line) => PASSIVE.test(line.text))
    .map((line) => ({
      ruleId: rule.id,
      detection: 'passive_voice' as const,
      severity: 'warn' as const,
      location: { section: line.section, line: line.number },
      message: rule.statement,
    }))
}

/**
 * Analyze one spec document. Pure: same text in, same warnings out, no I/O.
 */
export function analyzeSpec(markdown: string): SpecWarning[] {
  const { all, prose } = readLines(markdown)
  return [
    ...duplicateNormativeFacts(prose),
    ...navigationAsConstraint(prose),
    ...redundantHandoffSection(all),
    ...emptyHeadings(all),
    ...repeatedConnectives(prose),
    ...passiveVoice(prose),
  ]
}

/** Every rule id the analyzer can report — the expected key space of the metric table. */
export const ANALYZABLE_RULE_IDS: readonly string[] = SPEC_RULES.filter((r) =>
  r.detect.some((k) => specRuleForDetection(k) !== undefined),
).map((r) => r.id)
