/**
 * Cursor tool inventory classification: the neutral category table, the
 * read/write answer it produces, and the adapter's static tool manifest.
 */
import { describe, expect, it } from 'vitest'
import { createCursorAdapter } from './index.js'
import { cursorToolCategory, cursorToolIsWrite } from './tools.js'

describe('askQuestion classification', () => {
  it('classifies askQuestion as meta — read-only, no risk layer involvement', () => {
    expect(cursorToolCategory('askQuestion')).toBe('meta')
    expect(cursorToolIsWrite('askQuestion')).toBe(false)
  })

  it('exposes askQuestion as a read-only entry in the static tool manifest', () => {
    const tools = createCursorAdapter().listTools('', undefined)
    expect(tools).toContainEqual({ name: 'askQuestion', isWrite: false })
  })

  it('keeps every manifest entry consistent with the category table', () => {
    const write = new Set(['edit', 'execute', 'network'])
    for (const entry of createCursorAdapter().listTools('', undefined)) {
      const category = cursorToolCategory(entry.name)
      expect(entry.isWrite).toBe(category === undefined || write.has(category))
    }
  })
})
