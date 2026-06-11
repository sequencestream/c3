<script setup lang="ts">
/*
 * Login.vue — 全屏登录门 (ADR-0023, auth-overview Roadmap step 3)。
 * 仅在 useAuth().status === 'login-required' 时由 App.vue 渲染:账号+密码表单,
 * 提交走 WS `login` 消息,结果经 useAuth 回流为 status / loginError。
 */
import { ref, computed } from 'vue'
import type { AuthFailureCode } from '@ccc/shared/protocol'
import { useTypedI18n, type LocaleKey } from '@/i18n'
import { useAuth } from '@/composables/useAuth'

const { t } = useTypedI18n()
const auth = useAuth()

const username = ref('')
const password = ref('')

const canSubmit = computed(
  () => username.value.trim().length > 0 && password.value.length > 0 && !auth.pending.value,
)

const errorKey = computed<LocaleKey | null>(() => {
  const code = auth.loginError.value
  if (!code) return null
  const map: Record<AuthFailureCode, LocaleKey> = {
    invalid_credentials: 'auth.login.error.invalid_credentials',
    auth_disabled: 'auth.login.error.auth_disabled',
    rate_limited: 'auth.login.error.rate_limited',
  }
  return map[code] ?? 'auth.login.error.unknown'
})

function onSubmit(): void {
  if (!canSubmit.value) return
  auth.submitLogin(username.value.trim(), password.value)
}
</script>

<template>
  <div class="login-gate">
    <form class="login-card" data-testid="login-form" @submit.prevent="onSubmit">
      <h1 class="login-title">{{ t('auth.login.title') }}</h1>
      <p class="login-subtitle">{{ t('auth.login.subtitle') }}</p>

      <label class="field">
        <span class="field-label">{{ t('auth.login.username.label') }}</span>
        <input
          v-model="username"
          type="text"
          name="username"
          autocomplete="username"
          autofocus
          :placeholder="t('auth.login.username.placeholder')"
          :disabled="auth.pending.value"
          data-testid="login-username"
        />
      </label>

      <label class="field">
        <span class="field-label">{{ t('auth.login.password.label') }}</span>
        <input
          v-model="password"
          type="password"
          name="password"
          autocomplete="current-password"
          :placeholder="t('auth.login.password.placeholder')"
          :disabled="auth.pending.value"
          data-testid="login-password"
        />
      </label>

      <p v-if="errorKey" class="login-error" role="alert" data-testid="login-error">
        {{ t(errorKey) }}
      </p>

      <button type="submit" class="login-submit" :disabled="!canSubmit" data-testid="login-submit">
        {{ auth.pending.value ? t('auth.login.submitting') : t('auth.login.submit') }}
      </button>
    </form>
  </div>
</template>

<style scoped>
.login-gate {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: var(--c-bg, #1a1a1a);
  z-index: 2000;
}
.login-card {
  width: 100%;
  max-width: 340px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 28px 26px;
  border: 1px solid var(--c-border);
  border-radius: var(--radius-md, 10px);
  background: var(--c-card);
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
}
.login-title {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
  color: var(--c-text);
}
.login-subtitle {
  margin: 0 0 4px;
  font-size: 13px;
  color: var(--c-text-muted);
}
.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.field-label {
  font-size: 12px;
  color: var(--c-text-muted);
}
.field input {
  padding: 8px 10px;
  font-size: 14px;
  color: var(--c-text);
  background: var(--c-bg, #111);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
  outline: none;
}
.field input:focus {
  border-color: var(--c-accent, #4a90d9);
}
.login-error {
  margin: 0;
  font-size: 12px;
  color: #ff6b6b;
}
.login-submit {
  margin-top: 4px;
  padding: 9px 12px;
  font-size: 14px;
  font-weight: 600;
  color: #fff;
  background: var(--c-accent, #4a90d9);
  border: none;
  border-radius: var(--radius-sm);
  cursor: pointer;
}
.login-submit:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
</style>
