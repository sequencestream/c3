<script setup lang="ts">
import { query } from '../lib/api'

// The sign-in button is a full-page form POST to /v1/auth/login (it 303-redirects
// to GitHub OAuth — a fetch could not follow that navigation). The binding round
// rides through as hidden fields so the callback returns here to activate.
const installId = query('installId')
const requestId = query('requestId')
const error = query('error')
</script>

<template>
  <main class="ls-card">
    <h1>登录 / Sign in</h1>
    <p class="note">使用 GitHub 账号登录以管理你的 license。</p>
    <p v-if="error" class="error">{{ error }}</p>
    <form method="post" action="/v1/auth/login">
      <input type="hidden" name="installId" :value="installId" />
      <input type="hidden" name="requestId" :value="requestId" />
      <button type="submit">使用 GitHub 登录</button>
    </form>
  </main>
</template>
