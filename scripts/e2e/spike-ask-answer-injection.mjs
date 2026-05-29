#!/usr/bin/env node
/**
 * SPIKE (P0): can we feed AskUserQuestion answers back to the model in c3's
 * headless architecture, where the ONLY channel to the CLI subprocess is the
 * `canUseTool` callback?
 *
 * We induce the model to call AskUserQuestion, then in `canUseTool` we test, in
 * order:
 *
 *   PATH A — allow + updatedInput injecting an `answers` map (and `annotations`).
 *            If the SDK's AskUserQuestion picks pre-supplied answers up and
 *            echoes them as the tool result, the next assistant turn will
 *            reflect OUR injected choice. This is the clean path.
 *
 *   PATH B — (fallback, tested by --deny) deny + message carrying the answer as
 *            text. The model reads the message as the tool result and proceeds.
 *            Always works, but semantically "denied + here's the answer".
 *
 * The script prints the AskUserQuestion input it intercepted, what it injected,
 * and the model's FOLLOW-UP text so we can judge whether the injected answer was
 * actually consumed.
 *
 * Usage:
 *   node scripts/e2e/spike-ask-answer-injection.mjs            # tests PATH A
 *   node scripts/e2e/spike-ask-answer-injection.mjs --deny     # tests PATH B
 *
 * Auth/model come from the ambient `claude` CLI (same as the system agent).
 */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

// The SDK is a dependency of the `server` package, not the repo root, so resolve
// it from there (this script lives under scripts/e2e/ which has no node_modules).
const require = createRequire(new URL('../../server/package.json', import.meta.url))
const { query } = await import(require.resolve('@anthropic-ai/claude-agent-sdk'))

const PATH_B = process.argv.includes('--deny')

function findClaude() {
  if (process.env.CLAUDE_PATH) return process.env.CLAUDE_PATH
  const r = spawnSync('sh', ['-c', 'command -v claude'], { encoding: 'utf-8' })
  return r.status === 0 ? r.stdout.trim() : undefined
}

// A prompt that strongly induces a single AskUserQuestion call with a known,
// checkable option set, then asks the model to STATE the chosen option back.
const PROMPT = [
  'Use the AskUserQuestion tool exactly once to ask me a single question:',
  '"What is my favorite color?" with header "Color" and these options:',
  '- label "Crimson", description "a deep red"',
  '- label "Azure", description "a bright blue"',
  '- label "Emerald", description "a vivid green"',
  'Do not ask anything else. After I answer, reply with ONE sentence of the exact',
  'form: "You picked: <label>." and nothing else. Do not use any other tools.',
].join(' ')

// The answer we will inject. If the model echoes "Emerald", the injection worked.
const INJECTED_LABEL = 'Emerald'

const claudePath = findClaude()
console.log(
  `[spike] mode=${PATH_B ? 'B (deny+message)' : 'A (updatedInput)'} claude=${claudePath ?? '(sdk default)'}`,
)

let intercepted = false
let injectedDescription = ''
const assistantTexts = []

const q = query({
  prompt: PROMPT,
  options: {
    ...(claudePath ? { pathToClaudeCodeExecutable: claudePath } : {}),
    permissionMode: 'default',
    canUseTool: async (toolName, input) => {
      if (toolName !== 'AskUserQuestion') {
        console.log(`[spike] denying unexpected tool: ${toolName}`)
        return { behavior: 'deny', message: 'spike: only AskUserQuestion allowed' }
      }
      intercepted = true
      console.log('[spike] intercepted AskUserQuestion input:')
      console.log(JSON.stringify(input, null, 2))

      const questions = (input && input.questions) || []
      const q0 = questions[0] || {}
      const qText = q0.question || ''

      if (PATH_B) {
        // PATH B: deny with the answer encoded in the message.
        injectedDescription = `deny.message = "User selected: ${INJECTED_LABEL}"`
        console.log(`[spike] PATH B → ${injectedDescription}`)
        return {
          behavior: 'deny',
          message: `The user answered the question "${qText}" by selecting: ${INJECTED_LABEL}.`,
        }
      }

      // PATH A: allow, injecting an answers map keyed by question text.
      const answers = { [qText]: INJECTED_LABEL }
      const updatedInput = { ...input, answers, annotations: {} }
      injectedDescription = `updatedInput.answers = ${JSON.stringify(answers)}`
      console.log(`[spike] PATH A → ${injectedDescription}`)
      return { behavior: 'allow', updatedInput }
    },
  },
})

try {
  for await (const m of q) {
    if (m.type === 'assistant') {
      const content = m.message?.content
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text' && typeof block.text === 'string') {
            assistantTexts.push(block.text)
            console.log(`[spike] assistant: ${block.text.trim().slice(0, 200)}`)
          } else if (block.type === 'tool_use') {
            console.log(`[spike] (model tool_use: ${block.name})`)
          }
        }
      }
    } else if (m.type === 'user') {
      // The tool_result the model receives lands as a user message — print it so
      // we can see whether AskUserQuestion's output carried our injected answer.
      const content = m.message?.content
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'tool_result') {
            const c =
              typeof block.content === 'string' ? block.content : JSON.stringify(block.content)
            console.log(`[spike] tool_result: ${c.slice(0, 500)}`)
          }
        }
      }
    } else if (m.type === 'result') {
      break
    }
  }
} catch (err) {
  console.error('[spike] query error:', err?.message ?? err)
}

const followup = assistantTexts.join(' ')
const echoed = followup.includes(INJECTED_LABEL)
console.log('\n========== SPIKE REPORT ==========')
console.log(`path: ${PATH_B ? 'B (deny+message)' : 'A (updatedInput injection)'}`)
console.log(`intercepted AskUserQuestion: ${intercepted}`)
console.log(`injected: ${injectedDescription}`)
console.log(`model echoed injected label "${INJECTED_LABEL}": ${echoed}`)
console.log(
  echoed
    ? 'RESULT: PASS — answer feedback works on this path'
    : 'RESULT: INCONCLUSIVE/FAIL — answer not reflected',
)
console.log('==================================\n')
process.exit(echoed ? 0 : 1)
