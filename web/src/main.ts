import { createApp } from 'vue'
import App from './App.vue'
import i18n from './i18n'
import { applyStoredTheme } from './lib/personalized-settings'
import './standard.css'
import './style.css'

// Before the first render: the theme this browser recorded (dark when it has none),
// so the console never paints one palette and swaps to another. The account value
// from the server echo corrects it afterwards if they differ.
applyStoredTheme()

createApp(App).use(i18n).mount('#app')
