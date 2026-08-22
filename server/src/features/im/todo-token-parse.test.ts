import { describe, expect, it } from 'vitest'
import { parseTodoInbound } from './todo-token-parse.js'
import { TODO_TOKEN_PREFIX } from '@ccc/shared/protocol'

describe('parseTodoInbound', () => {
  it('returns null for non-todo text', () => {
    expect(parseTodoInbound('hello')).toBeNull()
    expect(parseTodoInbound('AbCdEfGhIjKlMnOpQrStUvWxYz0123456789')).toBeNull()
  })

  it('classifies token-only private chat', () => {
    const token = `${TODO_TOKEN_PREFIX}${'A'.repeat(24)}`
    expect(parseTodoInbound(token)).toEqual({ kind: 'token_only', token })
  })

  it('classifies full command', () => {
    const token = `${TODO_TOKEN_PREFIX}${'B'.repeat(24)}`
    expect(parseTodoInbound(`${token} approve`)).toEqual({
      kind: 'full_command',
      token,
      answerId: 'approve',
    })
  })

  it('rejects extra text or invalid answer ids', () => {
    const token = `${TODO_TOKEN_PREFIX}${'C'.repeat(24)}`
    expect(parseTodoInbound(`${token} approve extra`)).toEqual({ kind: 'malformed' })
    expect(parseTodoInbound(`${token} Bad-ID`)).toEqual({ kind: 'malformed' })
  })
})
