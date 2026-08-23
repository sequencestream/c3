import { beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ImRobot, ImRobotTurnLog } from '@ccc/shared/protocol'
import { applyLocale } from '@/i18n'
import RobotIdentityAdmin from './RobotIdentityAdmin.vue'
import RobotWriteGrants from './RobotWriteGrants.vue'
import RobotDetail from './RobotDetail.vue'

function robot(over: Partial<ImRobot> = {}): ImRobot {
  return {
    id: 'r1',
    name: 'helper',
    platform: 'feishu',
    appId: 'cli_app',
    hasSecret: true,
    vendor: 'claude',
    agentId: 'agent-1',
    mode: 'robot',
    toolAllowlist: ['Read', 'Grep'],
    requireMention: true,
    chatAllowlist: [],
    dmMode: 'open',
    dmAllowlist: [],
    maxTurnMs: null,
    enabled: true,
    outboundAckAt: 1,
    outboundAckHash: 'out',
    broadcastEventTypes: [],
    broadcastToBoundUsers: false,
    broadcastGroupChatIds: [],
    locale: null,
    configRevision: 0,
    writeGrants: [],
    createdAt: 0,
    updatedAt: 0,
    ...over,
  }
}

function turn(over: Partial<ImRobotTurnLog> = {}): ImRobotTurnLog {
  return {
    id: 't1',
    robotId: 'r1',
    threadKey: 'thread-1',
    chatId: 'chat-1',
    senderId: 'sender-1',
    sessionId: 'session-1',
    startedAt: 1_700_000_000_000,
    finishedAt: 1_700_000_001_000,
    outcome: 'complete',
    rejectReason: null,
    outboundChars: 42,
    error: null,
    ...over,
  }
}

function mountDetail(
  over: Partial<{
    robot: ImRobot | null
    turns: ImRobotTurnLog[]
    isAdmin: boolean
  }> = {},
) {
  return mount(RobotDetail, {
    props: {
      robot: robot(),
      turns: [turn(), turn({ id: 't2', outcome: 'scope_changed', outboundChars: 0 })],
      isAdmin: true,
      workspaces: [],
      imIdentityBindings: [],
      imGroupWorkspaceScopes: [],
      ...over,
    },
  })
}

beforeEach(() => applyLocale('en'))

describe('RobotDetail tabs', () => {
  it('renders exactly Basic info / Recent turns below the title and opens on Basic info', () => {
    const w = mountDetail()
    const tabs = w.findAll('[role="tab"]')

    expect(tabs.map((tab) => tab.text())).toEqual(['Basic info', 'Recent turns'])
    expect(tabs.map((tab) => tab.attributes('aria-selected'))).toEqual(['true', 'false'])
    expect(w.find('[data-testid="robot-detail-panel-basic"]').exists()).toBe(true)
    expect(w.find('[data-testid="robot-detail-panel-recent"]').exists()).toBe(false)

    const children = [...w.get('.rb-detail').element.children]
    expect(children[0].classList.contains('rb-head')).toBe(true)
    expect(children[1].getAttribute('data-testid')).toBe('robot-detail-tabs')
  })

  it('moves the complete admin configuration into Basic info and keeps its events', async () => {
    const w = mountDetail()
    const basic = w.get('[data-testid="robot-detail-panel-basic"]')

    expect(basic.text()).toContain('claude · agent-1')
    expect(basic.get('[data-testid="robot-permission"]').text()).toBe('Read, Grep')
    expect(basic.text()).toContain('Group messages that mention it')
    expect(basic.text()).toContain('~/.c3/robots/helper')
    expect(basic.findComponent(RobotWriteGrants).exists()).toBe(true)
    expect(basic.findComponent(RobotIdentityAdmin).exists()).toBe(true)
    expect(w.find('[data-testid="robot-detail-panel-recent"]').exists()).toBe(false)

    await w.get('[data-testid="robot-edit"]').trigger('click')
    basic.findComponent(RobotWriteGrants).vm.$emit('acknowledge', 'queue_respond')
    basic.findComponent(RobotIdentityAdmin).vm.$emit('loadGroupScopes', 'chat-2')
    expect(w.emitted('edit')).toEqual([['r1']])
    expect(w.emitted('acknowledgeWriteGrant')).toEqual([['queue_respond']])
    expect(w.emitted('loadImGroupScopes')).toEqual([['chat-2']])
  })

  it('keeps non-admin configuration readable without rendering management controls', () => {
    const w = mountDetail({ isAdmin: false })
    const basic = w.get('[data-testid="robot-detail-panel-basic"]')

    expect(basic.text()).toContain('claude · agent-1')
    expect(basic.get('[data-testid="robot-permission"]').text()).toBe('Read, Grep')
    expect(basic.findComponent(RobotWriteGrants).exists()).toBe(false)
    expect(basic.findComponent(RobotIdentityAdmin).exists()).toBe(false)
    expect(w.find('.rb-actions').exists()).toBe(false)
  })

  it('switches both ways without emitting events and shows recent audit fields only there', async () => {
    const w = mountDetail()
    expect(w.emitted()).toEqual({})

    await w.get('[data-testid="robot-detail-tab-recent"]').trigger('click')
    const recent = w.get('[data-testid="robot-detail-panel-recent"]')
    expect(w.find('[data-testid="robot-detail-panel-basic"]').exists()).toBe(false)
    expect(recent.findAll('tbody tr')).toHaveLength(2)
    expect(recent.text()).toContain('Answered')
    expect(recent.text()).toContain('Scope changed')
    expect(recent.text()).toContain('42')
    expect(w.findAll('[role="tab"]').map((tab) => tab.attributes('aria-selected'))).toEqual([
      'false',
      'true',
    ])

    await w.get('[data-testid="robot-detail-tab-basic"]').trigger('click')
    expect(w.find('[data-testid="robot-detail-panel-basic"]').exists()).toBe(true)
    expect(w.find('[data-testid="robot-detail-panel-recent"]').exists()).toBe(false)
    expect(w.emitted()).toEqual({})
  })

  it('shows the existing empty state in Recent turns', async () => {
    const w = mountDetail({ turns: [] })
    await w.get('[data-testid="robot-detail-tab-recent"]').trigger('click')

    const recent = w.get('[data-testid="robot-detail-panel-recent"]')
    expect(recent.text()).toContain('No turns yet.')
    expect(recent.find('table').exists()).toBe(false)
  })

  it('returns to Basic info when a different robot is selected', async () => {
    const w = mountDetail()
    await w.get('[data-testid="robot-detail-tab-recent"]').trigger('click')
    await w.setProps({ robot: robot({ id: 'r2', name: 'reviewer' }) })

    expect(w.find('[data-testid="robot-detail-panel-basic"]').exists()).toBe(true)
    expect(w.find('[data-testid="robot-detail-panel-recent"]').exists()).toBe(false)
    expect(w.findAll('[role="tab"]').map((tab) => tab.attributes('aria-selected'))).toEqual([
      'true',
      'false',
    ])
  })
})

describe('RobotDetail tab copy', () => {
  it('ships the approved English and Chinese labels with key coverage in every locale', () => {
    const locales = ['en', 'zh', 'ja', 'ko', 'ru'] as const
    const labels = Object.fromEntries(
      locales.map((locale) => {
        const messages = JSON.parse(
          readFileSync(resolve(__dirname, `../../../../locales/${locale}.json`), 'utf8'),
        ) as { robot: { detail: { tabs: { label: string; basic: string; recent: string } } } }
        return [locale, messages.robot.detail.tabs]
      }),
    )

    expect(labels.en).toEqual({
      label: 'Robot detail sections',
      basic: 'Basic info',
      recent: 'Recent turns',
    })
    expect(labels.zh).toEqual({
      label: '机器人详情分区',
      basic: '基础信息',
      recent: '最近回合',
    })
    for (const locale of locales) {
      expect(labels[locale].label).not.toBe('')
      expect(labels[locale].basic).not.toBe('')
      expect(labels[locale].recent).not.toBe('')
    }
  })
})
