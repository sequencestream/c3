import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import TaskPanel from './TaskPanel.vue'
import type { TaskListModel, TaskStatus } from '../../lib/task-list'

/** 直接构造一份任务模型;`order` 取数组下标(与快照推断一致)。 */
const model = (...defs: [id: string, status: TaskStatus][]): TaskListModel => ({
  tasks: defs.map(([id, status], order) => ({ id, subject: id, status, order })),
})

describe('TaskPanel.vue — 挂载渲染', () => {
  it('空列表 → 整个面板不渲染', () => {
    const w = mount(TaskPanel, { props: { model: model() } })
    expect(w.find('.task-panel').exists()).toBe(false)
  })

  it('全部完成 → 整个面板不渲染', () => {
    const w = mount(TaskPanel, { props: { model: model(['1', 'completed'], ['2', 'completed']) } })
    expect(w.find('.task-panel').exists()).toBe(false)
  })

  it('存在 in_progress / pending → 面板渲染', () => {
    const w = mount(TaskPanel, { props: { model: model(['1', 'in_progress']) } })
    expect(w.find('.task-panel').exists()).toBe(true)
  })

  it('排序:in_progress 置顶 → pending → completed,各组按 order', () => {
    const w = mount(TaskPanel, {
      props: {
        model: model(
          ['p1', 'pending'],
          ['done', 'completed'],
          ['run', 'in_progress'],
          ['p2', 'pending'],
        ),
      },
    })
    // 按 DOM 出现顺序取每行的 subject。
    const subjects = w.findAll('.task-row').map((r) => r.find('.task-subject').text())
    expect(subjects).toEqual(['run', 'p1', 'p2', 'done'])
  })

  it('三种状态各有清晰视觉标识(class + 标记符)', () => {
    const w = mount(TaskPanel, {
      props: { model: model(['a', 'in_progress'], ['b', 'pending'], ['c', 'completed']) },
    })
    const active = w.find('.task-row.task-active')
    const pending = w.find('.task-row.task-pending')
    const done = w.find('.task-row.task-done')
    expect(active.exists()).toBe(true)
    expect(pending.exists()).toBe(true)
    expect(done.exists()).toBe(true)
    expect(active.find('.task-mark').text()).toBe('▶')
    expect(pending.find('.task-mark').text()).toBe('○')
    expect(done.find('.task-mark').text()).toBe('✓')
  })

  it('已完成只展示最近 2 笔,其余折叠为 “+N 已完成”', () => {
    const w = mount(TaskPanel, {
      props: {
        model: model(
          ['c1', 'completed'],
          ['c2', 'completed'],
          ['c3', 'completed'],
          ['c4', 'completed'],
          ['run', 'in_progress'],
        ),
      },
    })
    // order 最大的两笔(c3、c4)按升序展示。
    const doneSubjects = w.findAll('.task-row.task-done').map((r) => r.find('.task-subject').text())
    expect(doneSubjects).toEqual(['c3', 'c4'])
    expect(w.find('[data-testid="task-more-completed"]').exists()).toBe(true)
  })

  it('恰好 2 笔已完成时不显示折叠提示', () => {
    const w = mount(TaskPanel, {
      props: { model: model(['c1', 'completed'], ['c2', 'completed'], ['run', 'in_progress']) },
    })
    expect(w.find('[data-testid="task-more-completed"]').exists()).toBe(false)
  })

  it('TaskUpdate(props 变更)时实时切换分组与显隐', async () => {
    const w = mount(TaskPanel, {
      props: { model: model(['1', 'in_progress'], ['2', 'pending']) },
    })
    expect(w.find('.task-row.task-active .task-subject').text()).toBe('1')

    // 1 完成、2 转进行中。
    await w.setProps({ model: model(['1', 'completed'], ['2', 'in_progress']) })
    expect(w.find('.task-row.task-active .task-subject').text()).toBe('2')
    expect(w.find('.task-row.task-done .task-subject').text()).toBe('1')

    // 全部完成 → 面板消失。
    await w.setProps({ model: model(['1', 'completed'], ['2', 'completed']) })
    expect(w.find('.task-panel').exists()).toBe(false)
  })
})
