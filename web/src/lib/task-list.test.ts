import { describe, it, expect } from 'vitest'
import type { TaskListModel, TaskStatus, TaskToolResult } from './task-list'
import { applyTaskTool, emptyTaskModel, isTaskTool, taskPanelView } from './task-list'

/** 构造一个 tool_result(默认非错误)。 */
const ok = (value: unknown): TaskToolResult => ({ content: JSON.stringify(value), isError: false })

/** 便捷:对空模型连续应用工具调用。 */
const apply = (
  model: TaskListModel,
  name: string,
  input: unknown,
  result?: TaskToolResult,
): TaskListModel => applyTaskTool(model, name, input, result)

describe('emptyTaskModel', () => {
  it('初始为空列表', () => {
    expect(emptyTaskModel()).toEqual({ tasks: [] })
  })
})

describe('TaskCreate — 新增', () => {
  it('从 result 取 id 新增任务', () => {
    const m = apply(
      emptyTaskModel(),
      'TaskCreate',
      { subject: '写解析器', description: '在 lib 下' },
      ok({ id: '1', subject: '写解析器', description: '在 lib 下', status: 'pending' }),
    )
    expect(m.tasks).toEqual([
      { id: '1', subject: '写解析器', description: '在 lib 下', status: 'pending', order: 0 },
    ])
  })

  it('连续新增按到达顺序累积 order', () => {
    let m = emptyTaskModel()
    m = apply(m, 'TaskCreate', {}, ok({ id: '1', subject: 'A', status: 'pending' }))
    m = apply(m, 'TaskCreate', {}, ok({ id: '2', subject: 'B', status: 'pending' }))
    expect(m.tasks.map((t) => [t.id, t.order])).toEqual([
      ['1', 0],
      ['2', 1],
    ])
  })

  it('result 取不到 id 时容错跳过(不崩溃、不污染)', () => {
    const m = apply(emptyTaskModel(), 'TaskCreate', { subject: '无 id' }, ok({ subject: '无 id' }))
    expect(m.tasks).toEqual([])
  })

  it('数字 id 归一为字符串', () => {
    const m = apply(emptyTaskModel(), 'TaskCreate', {}, ok({ id: 7, subject: 'A' }))
    expect(m.tasks[0].id).toBe('7')
  })

  it('保留 SDK 返回的依赖关系', () => {
    const m = apply(
      emptyTaskModel(),
      'TaskCreate',
      {},
      ok({
        id: '2',
        subject: 'B',
        status: 'pending',
        blockedBy: ['1'],
        blocks: ['3'],
        owner: 'dev',
      }),
    )
    expect(m.tasks[0]).toMatchObject({ blockedBy: ['1'], blocks: ['3'], owner: 'dev' })
  })
})

describe('TaskUpdate — 增量改状态', () => {
  const seeded = (): TaskListModel =>
    apply(
      emptyTaskModel(),
      'TaskList',
      undefined,
      ok([
        { id: '1', subject: 'A', status: 'pending' },
        { id: '2', subject: 'B', status: 'pending' },
      ]),
    )

  it('result 为准:按 id 改状态,保留 order', () => {
    const m = apply(
      seeded(),
      'TaskUpdate',
      { taskId: '1' },
      ok({ id: '1', subject: 'A', status: 'in_progress' }),
    )
    expect(m.tasks.find((t) => t.id === '1')).toMatchObject({ status: 'in_progress', order: 0 })
    expect(m.tasks.find((t) => t.id === '2')).toMatchObject({ status: 'pending' })
  })

  it('无 result 时退回按 input.taskId 增量改', () => {
    const m = applyTaskTool(seeded(), 'TaskUpdate', { taskId: '2', status: 'completed' })
    expect(m.tasks.find((t) => t.id === '2')).toMatchObject({ status: 'completed', order: 1 })
  })

  it('更新不存在的 id 时安全忽略', () => {
    const before = seeded()
    const after = applyTaskTool(before, 'TaskUpdate', { taskId: '99', status: 'completed' })
    expect(after.tasks).toEqual(before.tasks)
  })
})

describe('TaskList / TaskGet — 全量快照与替换', () => {
  it('TaskList 整列表替换,旧列表不堆叠', () => {
    let m = apply(
      emptyTaskModel(),
      'TaskList',
      undefined,
      ok([
        { id: '1', subject: 'A', status: 'pending' },
        { id: '2', subject: 'B', status: 'pending' },
      ]),
    )
    // 后续全量快照(只剩 1 项 + 状态变化)完全覆盖旧列表。
    m = apply(m, 'TaskList', undefined, ok([{ id: '1', subject: 'A', status: 'completed' }]))
    expect(m.tasks).toEqual([{ id: '1', subject: 'A', status: 'completed', order: 0 }])
  })

  it('TaskList 兼容 { tasks: [...] } 包装', () => {
    const m = apply(
      emptyTaskModel(),
      'TaskList',
      undefined,
      ok({ tasks: [{ id: '1', subject: 'A' }] }),
    )
    expect(m.tasks.map((t) => t.id)).toEqual(['1'])
  })

  it('TaskList 快照不可解析时保持现状(不误清空)', () => {
    const seeded = apply(emptyTaskModel(), 'TaskList', undefined, ok([{ id: '1', subject: 'A' }]))
    const after = applyTaskTool(seeded, 'TaskList', undefined, {
      content: 'not json',
      isError: false,
    })
    expect(after.tasks.map((t) => t.id)).toEqual(['1'])
  })

  it('TaskGet upsert:更新既有任务保留 order,新增任务追加', () => {
    let m = apply(
      emptyTaskModel(),
      'TaskList',
      undefined,
      ok([{ id: '1', subject: 'A', status: 'pending' }]),
    )
    m = apply(m, 'TaskGet', { taskId: '1' }, ok({ id: '1', subject: 'A', status: 'in_progress' }))
    m = apply(m, 'TaskGet', { taskId: '2' }, ok({ id: '2', subject: 'B', status: 'pending' }))
    expect(m.tasks).toEqual([
      { id: '1', subject: 'A', status: 'in_progress', order: 0 },
      { id: '2', subject: 'B', status: 'pending', order: 1 },
    ])
  })
})

describe('乱序到达', () => {
  it('先 Update 后被全量快照覆盖(快照为最新真相)', () => {
    let m = applyTaskTool(emptyTaskModel(), 'TaskUpdate', { taskId: '1', status: 'completed' })
    // Update 早到、列表里没有该任务 → 被忽略,列表仍空。
    expect(m.tasks).toEqual([])
    // 随后全量快照到达,建立真相。
    m = apply(m, 'TaskList', undefined, ok([{ id: '1', subject: 'A', status: 'in_progress' }]))
    expect(m.tasks).toEqual([{ id: '1', subject: 'A', status: 'in_progress', order: 0 }])
  })

  it('Create 与 Update 顺序无关,最终状态收敛', () => {
    let m = apply(
      emptyTaskModel(),
      'TaskCreate',
      {},
      ok({ id: '1', subject: 'A', status: 'pending' }),
    )
    m = apply(m, 'TaskUpdate', { taskId: '1' }, ok({ id: '1', subject: 'A', status: 'completed' }))
    expect(m.tasks).toEqual([{ id: '1', subject: 'A', status: 'completed', order: 0 }])
  })
})

describe('脏数据容错', () => {
  it('content 非 JSON 不崩溃', () => {
    expect(() =>
      applyTaskTool(emptyTaskModel(), 'TaskList', undefined, {
        content: '<<garbage',
        isError: false,
      }),
    ).not.toThrow()
  })

  it('isError 的 result 被忽略', () => {
    const m = applyTaskTool(
      emptyTaskModel(),
      'TaskCreate',
      {},
      {
        content: JSON.stringify({ id: '1', subject: 'A' }),
        isError: true,
      },
    )
    expect(m.tasks).toEqual([])
  })

  it('非法 status 回退 pending', () => {
    const m = apply(
      emptyTaskModel(),
      'TaskCreate',
      {},
      ok({ id: '1', subject: 'A', status: 'weird' }),
    )
    expect(m.tasks[0].status).toBe('pending')
  })

  it('快照里混入非对象 / 缺 id 的脏项被剔除,合法项保留', () => {
    const m = apply(
      emptyTaskModel(),
      'TaskList',
      undefined,
      ok([null, 42, { subject: '无 id' }, { id: '1', subject: 'A', status: 'pending' }]),
    )
    expect(m.tasks.map((t) => t.id)).toEqual(['1'])
  })

  it('subject 缺失时退化为 title / 截断 description / 空串', () => {
    const m = apply(
      emptyTaskModel(),
      'TaskList',
      undefined,
      ok([{ id: '1', title: '用标题' }, { id: '2', content: 'x'.repeat(200) }, { id: '3' }]),
    )
    expect(m.tasks[0].subject).toBe('用标题')
    expect(m.tasks[1].subject).toHaveLength(80)
    expect(m.tasks[2].subject).toBe('')
  })

  it('未知 toolName / 缺 result 原样返回', () => {
    const before = apply(emptyTaskModel(), 'TaskList', undefined, ok([{ id: '1', subject: 'A' }]))
    expect(applyTaskTool(before, 'Bash', { command: 'ls' })).toBe(before)
    expect(applyTaskTool(before, 'TaskCreate', {})).toBe(before)
  })
})

describe('isTaskTool — task 工具名判定', () => {
  it('四个 task 工具名为真', () => {
    for (const n of ['TaskCreate', 'TaskList', 'TaskUpdate', 'TaskGet']) {
      expect(isTaskTool(n)).toBe(true)
    }
  })
  it('其它工具名为假', () => {
    for (const n of ['Bash', 'Read', 'Task', 'taskcreate', '']) {
      expect(isTaskTool(n)).toBe(false)
    }
  })
})

describe('taskPanelView — 面板展示视图', () => {
  /** 用一份 TaskList 快照构造模型(order 即数组下标)。 */
  const model = (...defs: [id: string, status: TaskStatus][]): TaskListModel =>
    apply(
      emptyTaskModel(),
      'TaskList',
      undefined,
      ok(defs.map(([id, status]) => ({ id, subject: id, status }))),
    )

  it('分组并按 order 升序:in_progress / pending / completed 三组', () => {
    const v = taskPanelView(
      model(['1', 'pending'], ['2', 'in_progress'], ['3', 'completed'], ['4', 'pending']),
    )
    expect(v.inProgress.map((t) => t.id)).toEqual(['2'])
    expect(v.pending.map((t) => t.id)).toEqual(['1', '4'])
    expect(v.completed.map((t) => t.id)).toEqual(['3'])
  })

  it('completed 只保留最近(order 最大)2 笔,其余计入 hiddenCompleted', () => {
    const v = taskPanelView(
      model(
        ['1', 'completed'],
        ['2', 'completed'],
        ['3', 'completed'],
        ['4', 'completed'],
        ['5', 'in_progress'],
      ),
    )
    // order 最大的两笔已完成(3、4),仍按升序展示;另有一笔进行中保证面板可见。
    expect(v.completed.map((t) => t.id)).toEqual(['3', '4'])
    expect(v.hiddenCompleted).toBe(2)
  })

  it('全部完成 → 面板隐藏(visible=false)', () => {
    const v = taskPanelView(model(['1', 'completed'], ['2', 'completed']))
    expect(v.visible).toBe(false)
  })

  it('空列表 → 面板隐藏', () => {
    const v = taskPanelView(emptyTaskModel())
    expect(v.visible).toBe(false)
    expect(v).toMatchObject({ inProgress: [], pending: [], completed: [], hiddenCompleted: 0 })
  })

  it('存在任一 in_progress 或 pending → 面板可见', () => {
    expect(taskPanelView(model(['1', 'in_progress'])).visible).toBe(true)
    expect(taskPanelView(model(['1', 'pending'], ['2', 'completed'])).visible).toBe(true)
  })

  it('TaskUpdate 后视图实时切换(归并 + selector 组合)', () => {
    let m = model(['1', 'in_progress'], ['2', 'pending'])
    let v = taskPanelView(m)
    expect(v.visible).toBe(true)
    expect(v.inProgress.map((t) => t.id)).toEqual(['1'])
    // 任务 1 完成、任务 2 转进行中 → 面板仍可见,分组随之切换。
    m = applyTaskTool(m, 'TaskUpdate', { taskId: '1', status: 'completed' })
    m = applyTaskTool(m, 'TaskUpdate', { taskId: '2', status: 'in_progress' })
    v = taskPanelView(m)
    expect(v.inProgress.map((t) => t.id)).toEqual(['2'])
    expect(v.completed.map((t) => t.id)).toEqual(['1'])
    // 全部完成后面板隐藏。
    m = applyTaskTool(m, 'TaskUpdate', { taskId: '2', status: 'completed' })
    expect(taskPanelView(m).visible).toBe(false)
  })
})
