import { describe, it, expect } from 'vitest'
import type { CodeGitStatus } from '@ccc/shared/protocol'
import { computeGitDirtyDirs, gitStatusKinds } from './codes-git-status'

const M: CodeGitStatus = { modified: true, untracked: false, staged: false }

describe('gitStatusKinds', () => {
  it('undefined / all-false → 空数组', () => {
    expect(gitStatusKinds(undefined)).toEqual([])
    expect(gitStatusKinds({ modified: false, untracked: false, staged: false })).toEqual([])
  })

  it('固定顺序 staged → modified → untracked', () => {
    expect(gitStatusKinds({ modified: true, untracked: false, staged: true })).toEqual([
      'staged',
      'modified',
    ])
    // untracked 单独出现(不与其它组合)
    expect(gitStatusKinds({ modified: false, untracked: true, staged: false })).toEqual([
      'untracked',
    ])
  })

  it('多状态文件保留全部标志', () => {
    expect(gitStatusKinds({ modified: true, untracked: true, staged: true })).toEqual([
      'staged',
      'modified',
      'untracked',
    ])
  })
})

describe('computeGitDirtyDirs', () => {
  it('聚合所有祖先目录,即使目录从未加载', () => {
    const dirs = computeGitDirtyDirs({ 'src/a/b/c.ts': M })
    expect(dirs.has('src')).toBe(true)
    expect(dirs.has('src/a')).toBe(true)
    expect(dirs.has('src/a/b')).toBe(true)
    // 文件本身不是目录
    expect(dirs.has('src/a/b/c.ts')).toBe(false)
    // 根不进集合(树直接渲染根条目,无根节点可装饰)
    expect(dirs.has('')).toBe(false)
  })

  it('相似前缀不串扰:src 与 src-old 独立', () => {
    const dirs = computeGitDirtyDirs({ 'src-old/x.ts': M })
    expect(dirs.has('src-old')).toBe(true)
    expect(dirs.has('src')).toBe(false)
  })

  it('根层文件不产生任何脏目录', () => {
    expect(computeGitDirtyDirs({ 'README.md': M }).size).toBe(0)
  })

  it('多文件合并各自祖先', () => {
    const dirs = computeGitDirtyDirs({ 'a/x.ts': M, 'b/c/y.ts': M })
    expect([...dirs].sort()).toEqual(['a', 'b', 'b/c'])
  })
})
