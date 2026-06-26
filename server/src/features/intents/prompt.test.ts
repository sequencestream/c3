import { describe, expect, it } from 'vitest'
import type { UiLang } from '@ccc/shared/protocol'
import { UI_LANG_NAMES } from '../../kernel/config/index.js'
import { buildIntentAgentPrompt } from './prompt.js'

const SID = 'pending:sess-123'

describe('buildIntentAgentPrompt', () => {
  it('keeps the fixed English skeleton (role + read-only lock)', () => {
    const prompt = buildIntentAgentPrompt('en', SID)
    expect(prompt).toContain('You are the "Intent Analyst"')
    expect(prompt).toContain('only read')
  })

  it('injects the matching language name in the closing instruction per uiLang', () => {
    const langs: UiLang[] = ['en', 'zh', 'ja', 'ko', 'ru']
    for (const lang of langs) {
      const prompt = buildIntentAgentPrompt(lang, SID)
      expect(prompt).toContain(`Communicate with the user in ${UI_LANG_NAMES[lang]}`)
    }
  })

  it('no longer hard-codes Chinese for a non-Chinese language', () => {
    const prompt = buildIntentAgentPrompt('en', SID)
    expect(prompt).toContain('Communicate with the user in English')
    expect(prompt).not.toContain('Communicate with the user in Chinese')
  })

  it('injects the current session id with a single-intent back-link instruction', () => {
    const prompt = buildIntentAgentPrompt('en', SID)
    // The model is told to copy THIS id into a single intent's intentSessionId.
    expect(prompt).toContain(SID)
    expect(prompt).toContain('intentSessionId')
    expect(prompt).toContain('exactly ONE')
  })
})
