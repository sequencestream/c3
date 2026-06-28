<script setup lang="ts">
import { query } from '../lib/api'
import { useTypedI18n } from '../i18n'

const { t } = useTypedI18n()

// The sign-in button is a full-page form POST to /v1/auth/login (it 303-redirects
// to GitHub OAuth — a fetch could not follow that navigation). The binding round
// rides through as hidden fields so the callback returns here to activate.
const installId = query('installId')
const requestId = query('requestId')
const error = query('error')
</script>

<template>
  <main class="ls-login">
    <div class="ls-card login-card">
      <h1>{{ t('login.title') }}</h1>
      <p class="note">{{ t('login.subtitle') }}</p>
      <p v-if="error" class="error">{{ error }}</p>
      <form method="post" action="/v1/auth/login">
        <input type="hidden" name="installId" :value="installId" />
        <input type="hidden" name="requestId" :value="requestId" />
        <button type="submit">{{ t('login.signInWithGithub') }}</button>
      </form>
    </div>
  </main>
</template>
