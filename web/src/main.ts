import { createApp } from 'vue'
import App from './App.vue'
import i18n from './i18n'
import { applyStoredFontScale, applyStoredTheme } from './lib/personalized-settings'
import './standard.css'
import './style.css'

// Before the first render: the theme and font scale this browser recorded (dark /
// 100% when it has none), so the console never paints one and swaps to another.
// The account values from the server echo correct them afterwards if they differ.
applyStoredTheme()
applyStoredFontScale()

createApp(App).use(i18n).mount('#app')
