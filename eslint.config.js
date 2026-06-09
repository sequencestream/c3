import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import vue from 'eslint-plugin-vue'
import vueI18n from '@intlify/eslint-plugin-vue-i18n'
import prettier from 'eslint-config-prettier'
import globals from 'globals'

export default tseslint.config(
  {
    // Mirrors .gitignore — never lint build output or vendored code.
    ignores: ['**/dist/**', '**/node_modules/**', 'changes/**', 'web/dist/**', '.claude/worktrees/**'],
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
    // ADR-0009 R1/R2: the `kernel/` layer is pure domain. It MUST NOT import from
    // `transport/` or `features/` (R1, one-directional boundary), and MUST NOT
    // touch ws/HTTP semantics (R2 — no Hono, no raw WebSocket, no JSON.stringify
    // of wire frames). eslint is the mechanical guard; a violation fails lint/CI.
    files: ['server/src/kernel/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/transport/**', '**/features/**'],
              message:
                'ADR-0009 R1: kernel/ must not import from transport/ or features/ (one-directional boundary).',
            },
            {
              group: ['hono', 'hono/*', '@hono/*'],
              message:
                'ADR-0009 R2: kernel/ must not touch ws/HTTP transport (Hono). Broadcasts live in transport/.',
            },
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[object.name='JSON'][property.name='stringify']",
          message:
            'ADR-0009 R2: kernel/ must not serialize wire frames (JSON.stringify is a transport concern).',
        },
      ],
    },
  },

  {
    // ADR-0009 R2 carve-out (server refactor 3/3): the kernel config/infra
    // persistence sublayers serialize plain config/state to DISK — `settings.json`,
    // `state.json`, and the requirement/discussion/schedule stores via `db` — which
    // is NOT a wire frame. The `JSON.stringify` ban (no-restricted-syntax) targets
    // wire-frame serialization, a transport concern; disk persistence is a
    // legitimate kernel/infra job. The R1/R2 *import* bans (no transport/features,
    // no Hono) stay fully in force here — inherited from the kernel block above —
    // so these files still cannot reach the transport layer.
    files: ['server/src/kernel/config/**/*.ts', 'server/src/kernel/infra/**/*.ts'],
    rules: {
      'no-restricted-syntax': 'off',
    },
  },

  {
    // C-SEC (server refactor 3/3, ADR-0009): the permission gateway is the SINGLE
    // chokepoint. `transport/` (pure wire plumbing) and `features/` MUST NOT reach
    // for the Claude Agent SDK directly — running the agent goes through
    // `kernel/agent` and EVERY tool verdict through `kernel/permission` (the branded
    // PermissionDecision no feature can mint). This stops a feature from spinning up
    // its own `query` + `canUseTool` and bypassing the gateway. Tests are exempt
    // (they stub the SDK); the three established scheduled-run / MCP-tool files that
    // legitimately use the SDK carry an annotated, justified eslint-disable.
    files: ['server/src/features/**/*.ts', 'server/src/transport/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@anthropic-ai/claude-agent-sdk'],
              message:
                'C-SEC: features/transport must not import the Claude Agent SDK directly — run the agent via kernel/agent and decide every tool through kernel/permission (the single gateway). Annotate a justified exception only for an established scheduled-run / MCP-tool path.',
            },
          ],
        },
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
