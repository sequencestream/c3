import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import vue from 'eslint-plugin-vue'
import vueI18n from '@intlify/eslint-plugin-vue-i18n'
import prettier from 'eslint-config-prettier'
import globals from 'globals'

export default tseslint.config(
  {
    // Mirrors .gitignore — never lint build output or vendored code.
    ignores: ['**/dist/**', '**/node_modules/**', 'changes/**', 'web/dist/**'],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  // Vue SFCs: parse <script lang="ts"> via vue-eslint-parser + ts as sub-parser.
  ...vue.configs['flat/recommended'],
  {
    files: ['**/*.vue'],
    languageOptions: {
      parserOptions: {
        parser: tseslint.parser,
      },
    },
  },

  // Runtime globals per package.
  {
    files: ['server/**/*.ts', 'shared/**/*.ts'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    files: ['web/**/*.{ts,vue}'],
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    // Build scripts, configs, tests — all run under Node.
    files: ['**/*.test.ts', '**/*.{js,mjs,cjs}'],
    languageOptions: { globals: { ...globals.node } },
  },

  {
    rules: {
      // Allow intentionally-unused args prefixed with _ (e.g. discriminated-union narrowing).
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },

  {
    // i18n gate: forbid hard-coded UI text in web templates. M1 extraction is
    // complete (all web/src/*.vue copy goes through t()), so this is `error` —
    // any new hard-coded copy fails lint/CI. See specs/style/i18n-spec.md §5.2.
    files: ['web/src/**/*.vue'],
    plugins: { '@intlify/vue-i18n': vueI18n },
    settings: {
      'vue-i18n': {
        localeDir: './web/src/locales/*.json',
        messageSyntaxVersion: '^11.0.0',
      },
    },
    rules: {
      '@intlify/vue-i18n/no-raw-text': [
        'error',
        {
          // Ignore text that is purely symbols / digits / punctuation (not translatable copy).
          ignorePattern: '^[\\s\\d\\p{P}\\p{S}]+$',
        },
      ],
    },
  },

  {
    // Top-level page containers (pages/<page>/<Page>.vue) are route-level views,
    // single-word by convention (like App.vue). Their private components live one
    // dir deeper (components/<Name>/<Name>.vue) and keep the multi-word rule.
    files: ['web/src/pages/*/*.vue'],
    rules: { 'vue/multi-word-component-names': 'off' },
  },

  // Keep last: disables every stylistic rule that would fight Prettier.
  prettier,
)
