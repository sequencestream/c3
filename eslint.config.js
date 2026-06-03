import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import vue from 'eslint-plugin-vue'
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
    // Top-level page containers (pages/<page>/<Page>.vue) are route-level views,
    // single-word by convention (like App.vue). Their private components live one
    // dir deeper (components/<Name>/<Name>.vue) and keep the multi-word rule.
    files: ['web/src/pages/*/*.vue'],
    rules: { 'vue/multi-word-component-names': 'off' },
  },

  // Keep last: disables every stylistic rule that would fight Prettier.
  prettier,
)
