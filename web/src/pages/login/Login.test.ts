import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import type { ClientToServer } from '@ccc/shared/protocol'
import Login from './Login.vue'
import { useAuth } from '@/composables/useAuth'

const auth = useAuth()

describe('Login.vue — 登录门', () => {
  let sent: ClientToServer[]

  beforeEach(() => {
    sent = []
    auth.bindSender((m) => sent.push(m))
    // Reset to a clean unauthenticated form state.
    auth.handleUnauthenticated('missing')
  })

  it('渲染账号/密码表单与提交按钮', () => {
    const w = mount(Login)
    expect(w.find('[data-testid="login-username"]').exists()).toBe(true)
    expect(w.find('[data-testid="login-password"]').exists()).toBe(true)
    expect(w.find('[data-testid="login-submit"]').exists()).toBe(true)
  })

  it('填入凭证并提交 → 发 login 消息', async () => {
    const w = mount(Login)
    await w.find('[data-testid="login-username"]').setValue('alice')
    await w.find('[data-testid="login-password"]').setValue('secret')
    await w.find('[data-testid="login-form"]').trigger('submit')
    expect(sent).toContainEqual({
      type: 'login',
      request: { username: 'alice', password: 'secret' },
    })
  })

  it('凭证为空时提交被禁用,不发消息', async () => {
    const w = mount(Login)
    expect(w.find('[data-testid="login-submit"]').attributes('disabled')).toBeDefined()
    await w.find('[data-testid="login-form"]').trigger('submit')
    expect(sent).toEqual([])
  })

  it('登录失败码 → 渲染错误提示', async () => {
    const w = mount(Login)
    auth.handleLoginResult({ ok: false, code: 'invalid_credentials' })
    await w.vm.$nextTick()
    expect(w.find('[data-testid="login-error"]').exists()).toBe(true)
  })
})
