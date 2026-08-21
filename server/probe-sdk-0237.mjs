/**
 * 临时实跑探针（不提交）：在 SDK 0.3.237 下，按 c3 `runClaude` 的同款 options 起一次
 * 新会话并 resume 一次，记录 system/init 关键字段、默认工具面与 canUseTool 裁决链。
 * 两条 CLI 路径分别跑：宿主 claude（c3 实际走的）与 SDK 内置 CLI（parity 变更所在）。
 */
import { query } from '@anthropic-ai/claude-agent-sdk'

const HOST_CLI = '/opt/homebrew/bin/claude'
const BUNDLED_CLI =
  '../node_modules/.pnpm/@anthropic-ai+claude-agent-sdk-darwin-arm64@0.3.237/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude'

function makeOptions({ cliPath, resume, onAsk }) {
  return {
    cwd: process.cwd(),
    settingSources: ['user', 'project'],
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    permissionMode: 'default',
    allowDangerouslySkipPermissions: true,
    ...(cliPath ? { pathToClaudeCodeExecutable: cliPath } : {}),
    ...(resume ? { resume } : {}),
    canUseTool: async (toolName, input) => {
      onAsk({ toolName, input })
      // 一律拒绝：只验证「询问是否到达 c3 的咽喉」，不真的执行任何命令
      return { behavior: 'deny', message: 'probe: denied by canUseTool chokepoint' }
    },
  }
}

async function runOnce(label, { cliPath, resume, prompt }) {
  const asks = []
  const record = {
    label,
    initSeen: false,
    sessionId: null,
    tools: null,
    initKeys: [],
    init: {},
    asks,
    types: new Set(),
    unknownTypes: [],
  }
  const q = query({ prompt, options: makeOptions({ cliPath, resume, onAsk: (a) => asks.push(a) }) })
  try {
    for await (const m of q) {
      record.types.add(`${m.type}${m.subtype ? '/' + m.subtype : ''}`)
      if (!['assistant', 'user', 'result'].includes(m.type))
        record.unknownTypes.push(`${m.type}/${m.subtype ?? ''}`)
      if (m.type === 'system' && m.subtype === 'init') {
        record.initSeen = true
        record.sessionId = m.session_id
        record.tools = m.tools
        record.initKeys = Object.keys(m).sort()
        for (const k of [
          'apiKeySource',
          'model',
          'permissionMode',
          'effort',
          'slash_commands',
          'output_style',
          'agents',
        ])
          if (k in m)
            record.init[k] =
              k === 'slash_commands' || k === 'agents' ? `<${(m[k] ?? []).length} 项>` : m[k]
      }
      if (m.type === 'result') {
        record.sessionId ??= m.session_id
        record.resultSubtype = m.subtype
      }
    }
  } catch (e) {
    record.error = String(e?.message ?? e)
  }
  record.types = [...record.types]
  return record
}

const out = []
for (const [name, cliPath] of [
  ['宿主 CLI 2.1.227', HOST_CLI],
  ['SDK 内置 CLI 2.1.237', BUNDLED_CLI],
]) {
  const first = await runOnce(`${name} · 新会话`, {
    cliPath,
    prompt: '请用 Bash 工具执行 `echo hello-from-probe`，不要做别的事。',
  })
  out.push(first)
  if (first.sessionId) {
    out.push(
      await runOnce(`${name} · resume`, {
        cliPath,
        resume: first.sessionId,
        prompt: '再次用 Bash 工具执行 `echo hello-again`。',
      }),
    )
  }
}
console.log(JSON.stringify(out, null, 2))
