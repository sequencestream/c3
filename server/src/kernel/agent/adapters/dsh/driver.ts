import { HarnessClient } from '@deepseek-ai/dsh-sdk-client'
import type { AgentDriver, AgentRun, CanonicalMessage, DriverStartOptions } from '../types.js'
import { resolveExecutable } from '../../process/launcher.js'
import { dshCapabilities, DSH_MIN_NODE } from './capabilities.js'
import { DshApprovalBridge } from './approval.js'
import { dshSdkProcess, resolveDshLaunch, type DshSdkProcess } from './launch.js'
import { nodeMeetsDshEngine, pathNodeVersion } from './node-engine.js'
import { DshStreamTranslator } from './translate.js'

class CanonicalQueue implements AsyncIterable<CanonicalMessage> {
  private readonly items: CanonicalMessage[] = []
  private readonly waiters: Array<(r: IteratorResult<CanonicalMessage>) => void> = []
  private finished = false
  private failure: unknown = null

  push(m: CanonicalMessage): void {
    if (this.finished) return
    const waiter = this.waiters.shift()
    if (waiter) waiter({ value: m, done: false })
    else this.items.push(m)
  }

  close(): void {
    if (this.finished) return
    this.finished = true
    let waiter
    while ((waiter = this.waiters.shift())) {
      waiter({ value: undefined as unknown as CanonicalMessage, done: true })
    }
  }

  fail(err: unknown): void {
    this.failure = err
    this.close()
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<CanonicalMessage> {
    for (;;) {
      const next = this.items.shift()
      if (next) {
        yield next
        continue
      }
      if (this.finished) {
        if (this.failure) throw this.failure
        return
      }
      const result = await new Promise<IteratorResult<CanonicalMessage>>((resolveWaiter) => {
        this.waiters.push(resolveWaiter)
      })
      if (result.done) {
        if (this.failure) throw this.failure
        return
      }
      yield result.value
    }
  }
}

export interface DshDriverDeps {
  readonly approval: DshApprovalBridge
  readonly resolveBinary?: (vendor: 'dsh') => string | null
}

/**
 * SDK client whose child is {@link dshSdkProcess}, not `process.execPath`.
 * The second constructor argument is the client's process override; the
 * published type omits it because the SDK assumes it is running under Node.
 */
export function openHarnessClient(input: {
  binary: string
  cwd?: string
  env: NodeJS.ProcessEnv
  dshHome: string
}): HarnessClient {
  const runtime: DshSdkProcess = dshSdkProcess(input)
  const Client = HarnessClient as unknown as new (
    options?: ConstructorParameters<typeof HarnessClient>[0],
    runtime?: DshSdkProcess,
  ) => HarnessClient
  return new Client(
    {
      dshBin: input.binary,
      profile: 'sdk',
      dshHome: input.dshHome,
      ...(input.cwd ? { processCwd: input.cwd } : {}),
      env: input.env,
    },
    runtime,
  )
}

export class DshDriver implements AgentDriver {
  readonly vendor = 'dsh' as const
  readonly capabilities = dshCapabilities

  constructor(private readonly deps: DshDriverDeps) {}

  async start(opts: DriverStartOptions): Promise<AgentRun> {
    const launch = resolveDshLaunch(opts)
    const probe = resolveExecutable('dsh')
    const binary = this.deps.resolveBinary?.('dsh') ?? probe.path
    if (!binary) {
      throw new Error(probe.error ?? probe.installHint ?? 'DSH CLI is not installed')
    }

    const queue = new CanonicalQueue()
    const translator = new DshStreamTranslator()
    translator.setSessionId(launch.sessionId)

    const controller = new AbortController()
    if (opts.signal.aborted) controller.abort()
    else opts.signal.addEventListener('abort', () => controller.abort(), { once: true })

    const env: NodeJS.ProcessEnv = { ...process.env, ...opts.envOverrides }
    if (launch.apiKey) env.DEEPSEEK_API_KEY = launch.apiKey
    else if (!env.DEEPSEEK_API_KEY?.trim()) {
      throw new Error(
        'DeepSeek API key is required for DSH (set on the agent or DEEPSEEK_API_KEY in the server environment)',
      )
    }

    // The CLI is a `#!/usr/bin/env node` script, so the interpreter on PATH is
    // what will run it. Report that here instead of letting the child die with a
    // bare ENOENT or an engine error — this is the same gate the runtime status
    // reports, kept at the launch boundary so the two cannot disagree.
    const nodeVersion = pathNodeVersion()
    const required = `${DSH_MIN_NODE.major}.${DSH_MIN_NODE.minor}`
    if (!nodeVersion) {
      throw new Error(`DSH requires Node.js >= ${required} on PATH; node was not found`)
    }
    if (!nodeMeetsDshEngine(nodeVersion)) {
      throw new Error(`DSH requires Node.js >= ${required}; found ${nodeVersion} on PATH`)
    }

    const client = openHarnessClient({
      binary,
      cwd: opts.cwd,
      env,
      dshHome: launch.dshHome,
    })

    let sessionResolve!: (id: string) => void
    const sessionId = new Promise<string>((res) => {
      sessionResolve = res
    })

    const settled = pump(
      client,
      launch,
      opts,
      translator,
      queue,
      controller,
      this.deps.approval,
    ).finally(() => {
      queue.close()
      void client.close().catch(() => undefined)
    })

    sessionResolve(launch.sessionId)

    return {
      sessionId: () => sessionId,
      messages: () => queue,
      abort: () => controller.abort(),
      settled,
    }
  }
}

async function pump(
  client: HarnessClient,
  launch: ReturnType<typeof resolveDshLaunch>,
  opts: DriverStartOptions,
  translator: DshStreamTranslator,
  queue: CanonicalQueue,
  controller: AbortController,
  approval: DshApprovalBridge,
): Promise<void> {
  let subscription: ReturnType<HarnessClient['subscribeSessionTree']> | undefined
  try {
    client.start()
    client.onRequest(async (method, params) => {
      if (method !== 'approval/request') {
        throw new Error(`Unsupported DSH host request: ${method}`)
      }
      const toolName = typeof params.toolName === 'string' ? params.toolName : 'unknown'
      // DSH's approval payload names the tool but never carries its arguments,
      // so read them back from the `tool/call` this request belongs to. The
      // permission panel and the risk normalizer must judge the real input.
      const callId = typeof params.callId === 'string' ? params.callId : undefined
      const input = (callId ? translator.toolInput(callId) : undefined) ?? {}
      const outcome = await approval.resolveApproval(toolName, input, controller.signal)
      return { outcome }
    })

    await client.initialize({
      cwd: opts.cwd,
      provider: launch.provider,
      model: launch.model,
      approvalRequests: true,
    })

    if (opts.resume) {
      try {
        await client.resumeSession(launch.sessionId)
      } catch {
        // Fresh id if persistence store does not have this session yet.
      }
    }

    await client.setWorkingDirectory(launch.sessionId, opts.cwd)

    subscription = client.subscribeSessionTree(launch.sessionId)

    const promptBlocks = buildPromptBlocks(opts.prompt, opts.systemInstruction)
    await client.prompt(launch.sessionId, promptBlocks)

    while (!controller.signal.aborted) {
      const notification = await raceAbort(subscription.next(), controller.signal)
      if (notification.method === 'session.status' && notification.params.status === 'idle') {
        break
      }
      if (notification.method === 'session.event') {
        const sid = notification.params.sessionId
        if (typeof sid === 'string' && sid !== launch.sessionId) continue
        const event = (notification.params as { event?: unknown }).event
        const tr = translator.translateSessionEvent(event)
        for (const m of tr.messages) queue.push(m)
        if (tr.ended) {
          // A failed or aborted turn must fail the run: settling as success
          // would report a partial reply as a completed one. An abort raised by
          // c3 itself falls through to the 'Run aborted' branch below.
          if (tr.ended.isError && !controller.signal.aborted) {
            queue.fail(new Error(tr.ended.errorMessage || 'DSH run failed'))
            return
          }
          break
        }
      }
    }

    if (controller.signal.aborted) {
      queue.fail(new Error('Run aborted'))
      return
    }
  } catch (err) {
    if (!controller.signal.aborted) queue.fail(err)
    else queue.fail(new Error('Run aborted'))
    throw err
  } finally {
    try {
      subscription?.close()
    } catch {
      /* empty */
    }
  }
}

function buildPromptBlocks(
  prompt: string,
  systemInstruction?: string,
): Array<{ type: 'text'; text: string }> {
  const blocks: Array<{ type: 'text'; text: string }> = []
  if (systemInstruction?.trim()) {
    blocks.push({ type: 'text', text: systemInstruction.trim() })
  }
  blocks.push({ type: 'text', text: prompt })
  return blocks
}

async function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new Error('Run aborted')
  return await Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      signal.addEventListener('abort', () => reject(new Error('Run aborted')), { once: true })
    }),
  ])
}
