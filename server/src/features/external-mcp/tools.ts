/**
 * Framing-free builder for the EXTERNAL MCP tool set — the capability an
 * independent agent, CI job or monitoring script gets when it authenticates with
 * a long-lived API key on `/mcp/v1`.
 *
 * The set is an explicit ALLOWLIST, not the internal tool universe minus a
 * denylist. That direction is the whole safety property: adding a new internal
 * tool (a write, a session launcher, a review submission) cannot leak outward by
 * omission — it has to be named here to be reachable, and the compile-time check
 * at the bottom pins the built list to the declared names.
 *
 * "Read-only" here means it never mutates the intent ledger, discussions,
 * settings or session lifecycle. `publish_event` is the one deliberate exception
 * and it is a *fact delivery*, not a state edit: it hands a normalized event to
 * the bus. Existing subscribed automations may react to it asynchronously — that
 * is the tool's own documented semantics, and administrators granting a key must
 * know it.
 *
 * The tool BEHAVIOUR is the same `run*` core the internal surfaces call, so an
 * external caller can never observe different rules from an internal one; only
 * the binding differs. The binding comes from the authenticated request
 * ({@link ExternalMcpScope}) rather than from a run closure — an external caller
 * has no run.
 */
import type { ZodRawShape } from 'zod'
import {
  findDesc,
  findSchema,
  runFind,
  runView,
  viewDesc,
  viewSchema,
  type FindArgs,
  type ViewArgs,
} from '../intents/tool-defs.js'
import {
  findDiscussionsDesc,
  findDiscussionsSchema,
  runFindDiscussions,
  runViewDiscussion,
  viewDiscussionDesc,
  viewDiscussionSchema,
  type FindDiscussionsArgs,
  type ViewDiscussionArgs,
} from '../discussions/tool-defs.js'
import {
  publishEventDesc,
  publishEventSchema,
  runPublishEvent,
  type PublishEventArgs,
} from '../events/tool-defs.js'
import type { GenericEvent, GenericEventEnvelope } from '@ccc/shared'
import type { NormalizeResult } from '../../kernel/events/generic-event.js'

/**
 * The exact tool names the external route advertises. `tools/list` must equal
 * this set — no more (a write tool would be a privilege escalation) and no fewer
 * (a silently dropped tool would look like a server bug to the caller).
 */
export const EXTERNAL_MCP_TOOL_NAMES = [
  'find_intents',
  'view_intent',
  'find_discussions',
  'view_discussion',
  'publish_event',
] as const

export type ExternalMcpToolName = (typeof EXTERNAL_MCP_TOOL_NAMES)[number]

/**
 * What one authenticated external request acts on: the canonicalized workspace
 * resolved from the URL and checked against the key's authorization set, plus the
 * key id that answered. Both are server-derived — the caller supplies a workspace
 * *request*, never the effective scope.
 */
export interface ExternalMcpScope {
  workspacePath: string
  keyId: string
}

/** Composition-root callbacks the external tool handlers need at dispatch time. */
export interface ExternalMcpToolDeps {
  /** Normalize an untrusted event core through the kernel normalizer registry. */
  normalizeEvent: (core: GenericEvent) => NormalizeResult
  /** Deliver a normalized event envelope onto the event bus. */
  publishEvent: (payload: GenericEventEnvelope) => void
}

/** The framing-free result shape every c3 tool core already returns. */
export interface ExternalToolResult {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

/** One built tool: name + description + zod input shape + a scope-bound handler. */
export interface ExternalMcpTool {
  name: ExternalMcpToolName
  description: string
  inputSchema: ZodRawShape
  handler: (args: unknown) => ExternalToolResult | Promise<ExternalToolResult>
}

/**
 * The stable source identity an external publish is attributed to. It names the
 * KEY, never a run — an external caller has no session, and letting it choose one
 * would let it forge provenance on the bus.
 */
export function externalMcpSourceId(keyId: string): string {
  return `external-mcp:${keyId}`
}

/** Build the five external tools bound to ONE authenticated request scope. */
export function buildExternalMcpTools(
  scope: ExternalMcpScope,
  deps: ExternalMcpToolDeps,
): ExternalMcpTool[] {
  return [
    {
      name: 'find_intents',
      description: findDesc,
      inputSchema: findSchema,
      handler: (args) => runFind(scope.workspacePath, args as FindArgs),
    },
    {
      name: 'view_intent',
      description: viewDesc,
      inputSchema: viewSchema,
      handler: (args) => runView(scope.workspacePath, args as ViewArgs),
    },
    {
      name: 'find_discussions',
      description: findDiscussionsDesc,
      inputSchema: findDiscussionsSchema,
      handler: (args) => runFindDiscussions(scope.workspacePath, args as FindDiscussionsArgs),
    },
    {
      name: 'view_discussion',
      description: viewDiscussionDesc,
      inputSchema: viewDiscussionSchema,
      handler: (args) => runViewDiscussion(scope.workspacePath, args as ViewDiscussionArgs),
    },
    {
      name: 'publish_event',
      description: publishEventDesc,
      inputSchema: publishEventSchema,
      // The envelope's workspace and source are taken from the authenticated
      // scope, never from the arguments: an external caller can describe an event
      // but cannot decide which workspace hears it or whom it appears to come from.
      handler: (args) =>
        runPublishEvent(args as PublishEventArgs, deps.normalizeEvent, (event) =>
          deps.publishEvent({
            workspacePath: scope.workspacePath,
            sessionId: externalMcpSourceId(scope.keyId),
            event,
          }),
        ),
    },
  ]
}

// Compile-time allowlist pin: the built set must cover every declared name and
// introduce none of its own. A new tool added to the builder without being
// declared above (or vice versa) fails typecheck rather than shipping silently.
type BuiltNames = ReturnType<typeof buildExternalMcpTools>[number]['name']
type AssertSame<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never
const _allowlistIsExact: AssertSame<BuiltNames, ExternalMcpToolName> = true
void _allowlistIsExact
