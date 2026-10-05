/**
 * The analyzer is the only automated reader of a spec, and it is warn-only by
 * construction. These tests therefore cover two things equally: that each
 * machine-checkable shape FIRES on a real defect, and — just as important — that
 * it STAYS QUIET on text that merely looks similar, because a detector that
 * cries wolf is what gets users to ignore it.
 */

import { describe, expect, it } from 'vitest'
import { analyzeSpec, ANALYZABLE_RULE_IDS, type SpecWarning } from './spec-analyzer.js'
import { SPEC_RULES, specRulesWithDetection } from './spec-rules.js'

const kinds = (warnings: SpecWarning[]): string[] => warnings.map((w) => w.detection)

describe('analyzeSpec is pure', () => {
  it('returns the same warnings for the same text', () => {
    const doc = '# T\n\n## A\n\n必须保持状态机不变量不被绕过。\n\n## B\n\n状态机不变量不被绕过。\n'
    expect(analyzeSpec(doc)).toEqual(analyzeSpec(doc))
  })

  it('never mutates its input', () => {
    const doc = '# T\n\n## A\n\n内容。\n'
    const copy = structuredClone(doc)
    analyzeSpec(doc)
    expect(doc).toBe(copy)
  })
})

describe('every warning is warn, and says which rule and where', () => {
  it('reports severity warn with rule id, location and message', () => {
    const doc = '# 规格\n\n## 方案\n\n本表由源码生成。\n\n## 实施交接\n\n要点。\n'
    const warnings = analyzeSpec(doc)
    expect(warnings.length).toBeGreaterThan(0)
    for (const warning of warnings) {
      expect(warning.severity).toBe('warn')
      expect(warning.ruleId).toBeTruthy()
      expect(warning.message.length).toBeGreaterThan(0)
      expect(warning.location.section).toBeTruthy()
      expect(warning.location.line).toBeGreaterThan(0)
    }
  })

  it('only ever reports rule ids that exist in the ruleset', () => {
    const doc =
      '# 规格\n\n## 方案\n\n必须保持状态机不变量不被绕过。\n\n## 边界\n\n状态机不变量不被绕过。\n'
    const known = new Set(SPEC_RULES.map((r) => r.id))
    for (const warning of analyzeSpec(doc)) {
      expect(known.has(warning.ruleId)).toBe(true)
    }
  })
})

describe('the analyzer never counts length', () => {
  it('emits no length-shaped warning, however long the line is', () => {
    // One enormous sentence. Under a length rule this would fire; under a shape
    // discipline it must not, because no threshold exists to be over.
    const huge =
      '必须保持状态机不变量不被绕过并且在任何异常路径下都不得被绕过，同时还要保证并发写入的可见性。'
    const doc = `# 规格\n\n## 方案\n\n${huge.repeat(12)}\n`
    expect(kinds(analyzeSpec(doc))).not.toContain('repeated_connective')
    const longLine = `# 规格\n\n## 方案\n\n${'词'.repeat(4000)}\n`
    expect(analyzeSpec(longLine).length).toBeLessThanOrEqual(
      analyzeSpec(`# 规格\n\n## 方案\n\n${'词'.repeat(20)}\n`).length,
    )
  })

  it('has no detector keyed on words, characters or line count', () => {
    for (const rule of specRulesWithDetection()) {
      for (const detection of rule.detect) {
        expect(detection).not.toMatch(/length|count|words|chars|lines/)
      }
    }
  })
})

describe('stripping: code, tables, comments and Given/When/Then are not the author prose', () => {
  it('does not read a duplicate out of two code blocks', () => {
    const block = '必须保持状态机不变量不被绕过并覆盖所有异常路径。'
    const doc = `# 规格\n\n## A\n\n\`\`\`ts\n${block}\n\`\`\`\n\n## B\n\n\`\`\`ts\n${block}\n\`\`\`\n`
    expect(kinds(analyzeSpec(doc))).not.toContain('duplicate_normative_fact')
  })

  it('does not read a passive out of code', () => {
    const doc = '# 规格\n\n## 方案\n\n```ts\nconst x = 由配置决定的值\n```\n'
    expect(kinds(analyzeSpec(doc))).not.toContain('passive_voice')
  })

  it('does not read a passive out of a bare ``` fence with no info string', () => {
    const doc = '# 规格\n\n## 方案\n\n```\n状态机由配置覆盖\n```\n'
    expect(kinds(analyzeSpec(doc))).not.toContain('passive_voice')
  })

  it('does not read a duplicate out of two bare ``` fences', () => {
    const block = '必须保持状态机不变量不被绕过并覆盖所有异常路径。'
    const doc = `# 规格\n\n## A\n\n\`\`\`\n${block}\n\`\`\`\n\n## B\n\n\`\`\`\n${block}\n\`\`\`\n`
    expect(kinds(analyzeSpec(doc))).not.toContain('duplicate_normative_fact')
  })

  it('does not read a navigation-as-constraint out of a table row', () => {
    const row = '| 必须 | server/src/a.ts | server/src/b.ts | server/src/c.ts | :12 |'
    const doc = `# 规格\n\n## 边界\n\n| x | y | z | w | v |\n| --- | --- | --- | --- | --- |\n${row}\n`
    expect(kinds(analyzeSpec(doc))).not.toContain('navigation_as_constraint')
  })

  it('does not read anything out of an HTML comment', () => {
    const body = '必须保持状态机不变量不被绕过并覆盖所有异常路径。'
    const doc = `# 规格\n\n## A\n\n<!--\n${body}\n-->\n\n## B\n\n<!--\n${body}\n-->\n`
    expect(kinds(analyzeSpec(doc))).not.toContain('duplicate_normative_fact')
  })

  it('does not read a duplicate out of Given/When/Then', () => {
    const step = '必须保持状态机不变量不被绕过并覆盖所有异常路径。'
    const doc = `# 规格\n\n## 场景\n\nGiven: 系统已就绪\nWhen: ${step}\nThen: 结果成立\n\n## 另一场景\n\nGiven: 系统重启\nWhen: ${step}\nThen: 结果成立\n`
    expect(kinds(analyzeSpec(doc))).not.toContain('duplicate_normative_fact')
  })

  it('keeps a line starting with 「当前」 in the prose the checks read', () => {
    // 「当前」 opens with 「当」, the Chinese Given/When/Then keyword. Matching the
    // bare character would strip the commonest word in a Chinese spec.
    const fact = '当前状态机必须覆盖所有异常路径并且不得被任何入口绕过。'
    const doc = `# 规格\n\n## 方案\n\n${fact}\n\n## 边界\n\n${fact}\n`
    expect(kinds(analyzeSpec(doc))).toContain('duplicate_normative_fact')
  })

  it('keeps a line starting with 「则」 in the prose the checks read', () => {
    const fact = '则必须先处理冲突再落库否则结论不成立并且不得覆盖旧结论。'
    const doc = `# 规格\n\n## 方案\n\n${fact}\n\n## 边界\n\n${fact}\n`
    expect(kinds(analyzeSpec(doc))).toContain('duplicate_normative_fact')
  })

  it('still strips a Chinese Given/When/Then step that opens with 「当」 and no space', () => {
    // 「当:」 and 「当 」 both keep their boundary; the strip does not need the
    // keyword to be the whole line.
    const doc =
      '# 规格\n\n## 场景\n\n- 当: 状态机由配置覆盖\n\n## 另一场景\n\n- 当：状态机由配置覆盖\n'
    expect(kinds(analyzeSpec(doc))).not.toContain('passive_voice')
  })

  it('does not read anything out of Chinese Given/When/Then steps', () => {
    const doc =
      '# 规格\n\n## 场景\n\n- 假设 系统已就绪\n- 当 状态机由配置覆盖\n- 则 结论成立\n\n## 另一场景\n\n- 假设 系统重启\n- 当 状态机由配置覆盖\n- 则 结论成立\n'
    expect(kinds(analyzeSpec(doc))).not.toContain('passive_voice')
    expect(kinds(analyzeSpec(doc))).not.toContain('duplicate_normative_fact')
  })
})

describe('duplicate_normative_fact', () => {
  it('fires when one normative fact is restated in another section', () => {
    const doc =
      '# 规格\n\n## 方案\n\n返工轮次达到上限后队列必须停止重启作者会话并转人工处理。\n\n## 边界\n\n返工轮次达到上限后队列必须停止重启作者会话并转人工处理。\n'
    const hits = analyzeSpec(doc).filter((w) => w.detection === 'duplicate_normative_fact')
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]!.location.section).toBe('边界')
  })

  it('stays quiet when two sections say genuinely different things', () => {
    const doc =
      '# 规格\n\n## 方案\n\n返工轮次达到上限后队列停止重启作者会话并转人工处理。\n\n## 边界\n\n指纹语义保持不变，新规则只影响未批准前的撰写行为。\n'
    expect(kinds(analyzeSpec(doc))).not.toContain('duplicate_normative_fact')
  })

  it('stays quiet on a restatement inside ONE section (a paragraph, not a document defect)', () => {
    const fact = '返工轮次达到上限后队列停止重启作者会话并转人工处理。'
    const doc = `# 规格\n\n## 方案\n\n${fact}\n\n${fact}\n`
    expect(kinds(analyzeSpec(doc))).not.toContain('duplicate_normative_fact')
  })
})

describe('navigation_as_constraint', () => {
  it('fires when a requirement is carried mostly by paths and line numbers', () => {
    const doc =
      '# 规格\n\n## 边界\n\n必须修改 server/src/a.ts 与 server/src/b.ts，并同步 server/src/c.ts（见 :120）。\n'
    expect(kinds(analyzeSpec(doc))).toContain('navigation_as_constraint')
  })

  it('stays quiet when a path only locates a decision', () => {
    const doc =
      '# 规格\n\n## 方案\n\n核心逻辑由 server/src/a.ts 承载；本节只说明决策，不列实施顺序。\n'
    expect(kinds(analyzeSpec(doc))).not.toContain('navigation_as_constraint')
  })

  it('stays quiet on a normative statement with no navigation at all', () => {
    const doc = '# 规格\n\n## 边界\n\n队列必须停止重启作者会话并转人工处理。\n'
    expect(kinds(analyzeSpec(doc))).not.toContain('navigation_as_constraint')
  })
})

describe('redundant_handoff_section', () => {
  it('fires on an Implementation handoff heading', () => {
    expect(kinds(analyzeSpec('# 规格\n\n## Implementation handoff\n\n要点。\n'))).toContain(
      'redundant_handoff_section',
    )
  })

  it('fires on the Chinese spelling too', () => {
    expect(kinds(analyzeSpec('# 规格\n\n## 实施交接\n\n要点。\n'))).toContain(
      'redundant_handoff_section',
    )
  })

  it('stays quiet when the approach lives inline, which is the new shape', () => {
    expect(kinds(analyzeSpec('# 规格\n\n## 方案\n\n做法与取舍写在本节。\n'))).not.toContain(
      'redundant_handoff_section',
    )
  })
})

describe('empty_heading', () => {
  it('fires on a heading with nothing under it', () => {
    const doc = '# 规格\n\n## 方案\n\n有内容。\n\n## 风险\n\n## 验证\n\n有内容。\n'
    const hits = analyzeSpec(doc).filter((w) => w.detection === 'empty_heading')
    expect(hits).toHaveLength(1)
  })

  it('stays quiet on a heading with a body', () => {
    expect(kinds(analyzeSpec('# 规格\n\n## 方案\n\n有内容。\n'))).not.toContain('empty_heading')
  })
})

describe('repeated_connective', () => {
  it('fires when one connective is used twice in a section', () => {
    const doc = '# 规格\n\n## 方案\n\n因此第一点成立。\n\n因此第二点也成立。\n'
    expect(kinds(analyzeSpec(doc))).toContain('repeated_connective')
  })

  it('stays quiet when each connective appears once', () => {
    const doc = '# 规格\n\n## 方案\n\n因此第一点成立。\n\n同时第二点也成立。\n'
    expect(kinds(analyzeSpec(doc))).not.toContain('repeated_connective')
  })

  it('stays quiet when the repeats fall in different sections', () => {
    const doc = '# 规格\n\n## 甲\n\n因此第一点成立。\n\n## 乙\n\n因此第二点也成立。\n'
    expect(kinds(analyzeSpec(doc))).not.toContain('repeated_connective')
  })
})

describe('passive_voice', () => {
  it('fires on a 被 passive that hides the actor', () => {
    expect(kinds(analyzeSpec('# 规格\n\n## 方案\n\n状态机被配置覆盖。\n'))).toContain(
      'passive_voice',
    )
  })

  it('stays quiet on an active sentence that merely mentions 由', () => {
    expect(
      kinds(analyzeSpec('# 规格\n\n## 方案\n\n审核者由独立只读会话担任，结论绑定内容指纹。\n')),
    ).not.toContain('passive_voice')
  })
})

describe('the analysable surface is derived from the ruleset, not restated', () => {
  it('reports exactly the rules that carry a detection', () => {
    expect([...ANALYZABLE_RULE_IDS].sort()).toEqual(
      specRulesWithDetection()
        .map((r) => r.id)
        .sort(),
    )
  })
})
