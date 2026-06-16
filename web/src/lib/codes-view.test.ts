import { describe, expect, it } from 'vitest'
import { basename, closeTab, formatFileSize, langFromPath, type CodeTab } from './codes-view'

function tab(path: string): CodeTab {
  return { path, file: null, loading: false }
}

describe('closeTab', () => {
  const tabs = [tab('a.ts'), tab('b.ts'), tab('c.ts')]

  it('closing the active tab focuses the right neighbor', () => {
    const r = closeTab(tabs, 'b.ts', 'b.ts')
    expect(r.tabs.map((t) => t.path)).toEqual(['a.ts', 'c.ts'])
    expect(r.activePath).toBe('c.ts')
  })

  it('closing the last (active) tab focuses the left neighbor', () => {
    const r = closeTab(tabs, 'c.ts', 'c.ts')
    expect(r.tabs.map((t) => t.path)).toEqual(['a.ts', 'b.ts'])
    expect(r.activePath).toBe('b.ts')
  })

  it('closing the only tab clears the active path', () => {
    const r = closeTab([tab('a.ts')], 'a.ts', 'a.ts')
    expect(r.tabs).toEqual([])
    expect(r.activePath).toBeNull()
  })

  it('closing a non-active tab keeps the active selection', () => {
    const r = closeTab(tabs, 'a.ts', 'c.ts')
    expect(r.tabs.map((t) => t.path)).toEqual(['b.ts', 'c.ts'])
    expect(r.activePath).toBe('c.ts')
  })

  it('closing an unknown tab is a no-op', () => {
    const r = closeTab(tabs, 'zzz.ts', 'b.ts')
    expect(r.tabs).toBe(tabs)
    expect(r.activePath).toBe('b.ts')
  })
})

describe('langFromPath', () => {
  it('maps common extensions to Shiki language ids', () => {
    expect(langFromPath('src/a.ts')).toBe('typescript')
    expect(langFromPath('a.vue')).toBe('vue')
    expect(langFromPath('deep/dir/style.scss')).toBe('scss')
    expect(langFromPath('README.md')).toBe('markdown')
  })

  it('recognises name-only files', () => {
    expect(langFromPath('Dockerfile')).toBe('docker')
    expect(langFromPath('.gitignore')).toBe('bash')
  })

  it('returns null for unknown / extensionless files', () => {
    expect(langFromPath('LICENSE')).toBeNull()
    expect(langFromPath('weird.xyz')).toBeNull()
  })
})

describe('basename', () => {
  it('returns the last path segment', () => {
    expect(basename('a/b/c.ts')).toBe('c.ts')
    expect(basename('top.ts')).toBe('top.ts')
  })
})

describe('formatFileSize', () => {
  it('formats bytes / KB / MB', () => {
    expect(formatFileSize(512)).toBe('512 B')
    expect(formatFileSize(2048)).toBe('2.0 KB')
    expect(formatFileSize(3 * 1024 * 1024)).toBe('3.0 MB')
  })
})
