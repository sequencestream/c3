import { createApp, defineAsyncComponent } from 'vue'
import App from './App.vue'
import i18n from './i18n'
import { isLogsRoute } from './lib/logs-route'
import { applyStoredFontScale, applyStoredTheme } from './lib/personalized-settings'
import './standard.css'
import './style.css'

// Before the first render: the theme and font scale this browser recorded (dark /
// 100% when it has none), so the console never paints one and swaps to another.
// The account values from the server echo correct them afterwards if they differ.
applyStoredTheme()
applyStoredFontScale()

// The runtime-log viewer is its own route, opened in its own browser tab: it
// mounts alone, with its own socket and poll loop, and never boots the console.
// Lazy, like every other page — the console's first load must not carry it.
const root = isLogsRoute(location.hash)
  ? defineAsyncComponent(() => import('./pages/logs/LogsPage.vue'))
  : App

createApp(root).use(i18n).mount('#app')
