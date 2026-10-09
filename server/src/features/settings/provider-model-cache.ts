/**
 * What models one provider's upstream actually serves — fetched from the provider's own
 * endpoint, cached per provider, shipped directory as the last resort.
 *
 * The directory in `@ccc/shared` is release-maintained data, so it can only be as current as
 * the last release: an operator either cannot pick a model that shipped since (and must type
 * its id by hand) or picks one that has been retired and gets a 404. Self-hosted and
 * aggregating gateways have no directory entry at all. So the answer to "which models does
 * this provider offer" is resolved at runtime, in ONE order:
 *
 *   1. the per-provider cache, when it is younger than {@link MODEL_CACHE_TTL_MS};
 *   2. fetched from the provider's own list endpoint (openai slot: `<base>/models`,
 *      anthropic slot: `<base>/v1/models`), with the stored key in that dialect's headers;
 *   3. the cache anyway when the fetch fails — an old list beats no list, and a failed fetch
 *      never clears it;
 *   4. the shipped directory, only when nothing has ever been cached.
 *
 * Reads never wait for the network. Step 2 is started in the BACKGROUND and the caller is
 * answered from step 1/3/4 immediately, so a dead endpoint costs a settings page nothing; a
 * later read picks up what the background refresh stored. What this buys is a list that is at
 * most one TTL behind (24h), which is the whole consistency model — no invalidation protocol,
 * no strong reads.
 *
 * Only the provider's own configured address is ever dialled, with the key that belongs to it
 * — the same trust boundary as the probe and the inference path. A provider without a URL or
 * without a key is not fetched from at all: there is no endpoint to ask and no credential to
 * ask with, so the shipped directory answers instead.
 *
 * The upstream list is all this module knows about: the provider's OWN entries are not merged
 * here (they are a property of the settings document, not of the upstream), and capability
 * metadata is never guessed from a fetched id.
 */
import type { ModelProvider, ModelProviderModel, ProtocolType } from '@ccc/shared/protocol'
import { checkProviderBaseUrl, modelVendorModels } from '@ccc/shared'
import { getDb, isDbAvailable, type Db } from '../../kernel/infra/db.js'

/** How long a fetched list stays fresh. Past it, the next read refreshes in the background. */
export const MODEL_CACHE_TTL_MS = 86_400_000
/**
 * How long a failed (or impossible) fetch suppresses the next attempt. Without it, every
 * console open would dial a broken endpoint again — a settings page must not be a retry loop.
 */
export const NEGATIVE_CACHE_TTL_MS = 300_000
/** Fetch budget. Injectable per call so tests never wait on real time. */
export const MODEL_FETCH_TIMEOUT_MS = 6_000

// ---- Schema ----

const TABLES = `
CREATE TABLE IF NOT EXISTS provider_model_caches (
  provider_id       TEXT    PRIMARY KEY,
  models_json       TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  cached_at         INTEGER,
  last_fetched_at   INTEGER,
  last_fetch_result TEXT    NOT NULL CHECK(last_fetch_result IN ('ok','failed','skipped')),
  last_fetch_error  TEXT
);
`

/** Keyed on the connection: `resetDbForTests` hands out a new one to a new file. */
let schemaReadyFor: Db | null = null

function db(): Db | null {
  if (!isDbAvailable()) return null
  const d = getDb()
  if (!d) return null
  if (schemaReadyFor !== d) {
    try {
      d.exec(TABLES)
    } catch {
      return null
    }
    schemaReadyFor = d
  }
  return d
}

/** Test hook: forget the "schema ensured" connection (pair with `resetDbForTests`). */
export function resetProviderModelCacheForTests(): void {
  schemaReadyFor = null
  inFlight.clear()
}

// ---- Rows ----

/**
 * One provider's cache row. `models` is absent until a fetch has ever succeeded.
 *
 * `createdAt` is the row's birth and never moves; `updatedAt` moves on every attempt;
 * `cachedAt` moves only on a SUCCESSFUL fetch — which is what makes the TTL a property of the
 * data, not of the last thing that happened to touch the row. A failed attempt must not make
 * a day-old list look fresh again.
 */
export interface ProviderModelCacheRow {
  providerId: string
  models: ModelProviderModel[] | null
  createdAt: number
  updatedAt: number
  cachedAt: number | null
  lastFetchedAt: number | null
  lastFetchResult: 'ok' | 'failed' | 'skipped'
  lastFetchError: string | null
}

interface RowShape {
  provider_id: string
  models_json: string | null
  created_at: number
  updated_at: number
  cached_at: number | null
  last_fetched_at: number | null
  last_fetch_result: string
  last_fetch_error: string | null
}

function toRow(row: RowShape): ProviderModelCacheRow {
  return {
    providerId: row.provider_id,
    models: parseModelsJson(row.models_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    cachedAt: row.cached_at,
    lastFetchedAt: row.last_fetched_at,
    lastFetchResult:
      row.last_fetch_result === 'ok' || row.last_fetch_result === 'failed'
        ? row.last_fetch_result
        : 'skipped',
    lastFetchError: row.last_fetch_error,
  }
}

/** A malformed stored list reads as "nothing cached" rather than taking the read down. */
function parseModelsJson(raw: string | null): ModelProviderModel[] | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return null
    const models: ModelProviderModel[] = []
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue
      const id = (item as { id?: unknown }).id
      if (typeof id !== 'string' || !id.trim()) continue
      const model: ModelProviderModel = { id: id.trim() }
      const { contextWindow, maxOutputTokens } = item as Partial<ModelProviderModel>
      if (typeof contextWindow === 'number') model.contextWindow = contextWindow
      if (typeof maxOutputTokens === 'number') model.maxOutputTokens = maxOutputTokens
      models.push(model)
    }
    return models
  } catch {
    return null
  }
}

/** One provider's cache row, or null when nothing was ever stored for it. */
export function readProviderModelCache(providerId: string): ProviderModelCacheRow | null {
  const d = db()
  if (!d) return null
  try {
    const row = d.get<RowShape>(
      'SELECT * FROM provider_model_caches WHERE provider_id=?',
      providerId,
    )
    return row ? toRow(row) : null
  } catch {
    return null
  }
}

/**
 * Upsert one provider's cache row. A successful fetch carries the list and moves `cached_at`
 * along with the attempt stamps; a failed one carries no list at all, which is what makes
 * "failure never clears the old list" a property of the write as well as of the read.
 *
 * `created_at` survives every later write — it is the row's birth, and a re-fetch must not
 * move it.
 */
export function writeProviderModelCache(row: {
  providerId: string
  models?: ModelProviderModel[] | null
  now: number
  result: 'ok' | 'failed' | 'skipped'
  error?: string | null
}): void {
  const d = db()
  if (!d) return
  const succeeded = row.result === 'ok'
  const modelsJson = succeeded ? JSON.stringify(row.models ?? []) : null
  try {
    d.run(
      `INSERT INTO provider_model_caches
         (provider_id, models_json, created_at, updated_at, cached_at, last_fetched_at,
          last_fetch_result, last_fetch_error)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(provider_id) DO UPDATE SET
         models_json       = COALESCE(excluded.models_json, provider_model_caches.models_json),
         updated_at        = excluded.updated_at,
         cached_at         = COALESCE(excluded.cached_at, provider_model_caches.cached_at),
         last_fetched_at   = excluded.last_fetched_at,
         last_fetch_result = excluded.last_fetch_result,
         last_fetch_error  = excluded.last_fetch_error`,
      row.providerId,
      modelsJson,
      row.now,
      row.now,
      succeeded ? row.now : null,
      row.now,
      row.result,
      row.error ?? null,
    )
  } catch {
    // Cache writes are an optimization, never a fact the caller depends on: a failed write
    // must not take a list read down. The next read simply fetches again.
  }
}

// ---- Path derivation ----

/**
 * The dialect to ask for this provider's list: the first slot it actually fills, in the
 * console's own display order. One provider may speak both dialects; its OpenAI-compatible
 * endpoint is asked first because that is the endpoint most gateways expose a complete
 * `/models` on, and an Anthropic-only upstream (the first-party one) has only the other slot
 * to fall back on. Returns null when neither slot has a URL.
 */
export function providerModelProtocol(
  urls: Partial<Record<ProtocolType, string>>,
): ProtocolType | null {
  for (const protocol of ['openai', 'anthropic'] as const) {
    if (urls[protocol]?.trim()) return protocol
  }
  return null
}

/** The path `protocol` serves its model list on, appended to a base URL. */
const MODEL_LIST_PATH: Record<ProtocolType, string> = {
  openai: '/models',
  // Anthropic's list endpoint is versioned under `/v1`, unlike the bare `<base>` its
  // Messages API is called on (the relay appends `/v1/messages` itself).
  anthropic: '/v1/models',
}

/** The path's final segment, used to keep a `/v1` from being appended twice. */
function lastSegment(url: string): string {
  const withoutTrailing = url.replace(/\/+$/, '')
  const cut = withoutTrailing.lastIndexOf('/')
  return cut === -1 ? '' : withoutTrailing.slice(cut + 1)
}

/**
 * Derive a provider's model-list URL from its base URL for one dialect: strip trailing
 * slashes, then append the dialect's path — WITHOUT appending a version segment the base URL
 * already carries, so `https://gateway.example/v1` never becomes `/v1/v1/models`.
 *
 * Null when there is no usable base URL (it fails the same structural check the console and
 * the probe apply). This is the only place the rule lives, so the console and the fetch
 * cannot disagree about what is being asked.
 */
export function providerModelListUrl(
  baseUrl: string | undefined,
  protocolType: ProtocolType,
): string | null {
  const trimmed = (baseUrl ?? '').trim()
  if (!trimmed) return null
  if (checkProviderBaseUrl(trimmed).severity === 'error') return null
  const base = trimmed.replace(/\/+$/, '')
  let path = MODEL_LIST_PATH[protocolType]
  if (lastSegment(base).toLowerCase() === 'v1') {
    path = path.replace(/^\/v1(?=\/)/, '')
  }
  return `${base}${path}`
}

/** The headers that dialect authorizes with. An empty key sends no auth header at all. */
function modelListHeaders(protocolType: ProtocolType, apiKey: string): Record<string, string> {
  const headers: Record<string, string> = { accept: 'application/json' }
  if (!apiKey) return headers
  if (protocolType === 'anthropic') {
    // Anthropic authorizes on `x-api-key` and requires a version header on `/v1/models`.
    headers['x-api-key'] = apiKey
    headers['anthropic-version'] = '2023-06-01'
  } else {
    headers.authorization = `Bearer ${apiKey}`
  }
  return headers
}

/**
 * Read the model ids out of a list response: the standard `data[].id` shape both dialects
 * share (`{ data: [{ id, … }] }`). Null means "this is not a list answer" — an unparseable or
 * foreign body is a failed fetch, never an empty catalog.
 *
 * Capability metadata is deliberately NOT read from here: whatever an upstream says about a
 * context window is not c3's to trust, and the operator declares it.
 */
export function parseModelListResponse(payload: unknown): ModelProviderModel[] | null {
  if (!payload || typeof payload !== 'object') return null
  const data = (payload as { data?: unknown }).data
  if (!Array.isArray(data)) return null
  const models: ModelProviderModel[] = []
  const seen = new Set<string>()
  for (const item of data) {
    if (!item || typeof item !== 'object') continue
    const id = (item as { id?: unknown }).id
    if (typeof id !== 'string') continue
    const trimmed = id.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    models.push({ id: trimmed })
  }
  return models
}

// ---- Resolution ----

/** Injectable edges: the network, the clock, and the fetch budget. */
export interface ProviderModelDeps {
  fetchImpl?: typeof fetch
  now?: () => number
  timeoutMs?: number
}

/** One provider's upstream list plus how much it can be trusted. */
export interface ProviderModelsResolution {
  /** The upstream half alone; the caller merges the provider's own entries. */
  models: ModelProviderModel[]
  /** Served from the cache (any age) rather than resolved from the shipped directory. */
  fromCache: boolean
  /** Older than the TTL / the shipped fallback: a background refresh has been started. */
  stale: boolean
  /**
   * The background refresh this read started, or null. The read path NEVER awaits it — this
   * is how a test (or a manual refresh) observes one without the read blocking on it. It
   * always settles, so an unhandled rejection is not a possibility.
   */
  refresh: Promise<void> | null
}

/** One in-flight refresh per provider, so two reads cannot fetch twice. */
const inFlight = new Map<string, Promise<void>>()

/** Whether a cache row's stored list is young enough to answer a read as-is. */
function isFresh(row: ProviderModelCacheRow | null, now: number): boolean {
  if (!row?.models || row.cachedAt === null) return false
  return now - row.cachedAt < MODEL_CACHE_TTL_MS
}

/**
 * Whether the last attempt at this provider is still "recent enough" that a fresh one would
 * be hammering a dead endpoint. Failed AND skipped attempts count: both mean the last read
 * could not resolve anything, and neither is worth repeating on every console open.
 */
function withinBackoff(row: ProviderModelCacheRow | null, now: number): boolean {
  if (!row || row.lastFetchedAt === null) return false
  if (row.lastFetchResult === 'ok') return false
  return now - row.lastFetchedAt < NEGATIVE_CACHE_TTL_MS
}

/** The shipped directory for a provider's declared vendor — the last resort. */
function shippedModels(provider: ModelProvider): ModelProviderModel[] {
  return [...modelVendorModels(provider.vendor)]
}

async function fetchAndStore(
  provider: ModelProvider,
  protocolType: ProtocolType,
  baseUrl: string,
  apiKey: string,
  deps: ProviderModelDeps,
): Promise<void> {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch
  const now = deps.now ?? Date.now
  const timeoutMs = deps.timeoutMs ?? MODEL_FETCH_TIMEOUT_MS
  const url = providerModelListUrl(baseUrl, protocolType)

  if (!url) {
    writeProviderModelCache({
      providerId: provider.id,
      now: now(),
      result: 'skipped',
      error: `base URL is not usable: ${baseUrl}`,
    })
    return
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    // 'manual': a misconfigured or hostile base URL's 30x must not carry the account key on
    // to a redirect target the operator never typed. Same rule as the probe.
    const resp = await fetchImpl(url, {
      method: 'GET',
      headers: modelListHeaders(protocolType, apiKey),
      signal: controller.signal,
      redirect: 'manual',
    })
    if (!resp.ok) {
      writeProviderModelCache({
        providerId: provider.id,
        now: now(),
        result: 'failed',
        error: `HTTP ${resp.status}`,
      })
      return
    }
    const models = parseModelListResponse(await resp.json())
    if (!models || models.length === 0) {
      // A 2xx that is not a list, or an empty one: stored as a failure so a good list is
      // never replaced by nothing (and the shipped directory keeps answering if it is all
      // we ever had).
      writeProviderModelCache({
        providerId: provider.id,
        now: now(),
        result: 'failed',
        error: models ? 'empty model list' : 'unrecognized list response',
      })
      return
    }
    writeProviderModelCache({ providerId: provider.id, models, now: now(), result: 'ok' })
  } catch (err) {
    // The message may quote the URL but never the headers, so no key can leak here.
    const error = err instanceof Error ? err.message : String(err)
    writeProviderModelCache({
      providerId: provider.id,
      now: now(),
      result: 'failed',
      error: controller.signal.aborted ? `timeout after ${timeoutMs}ms` : error,
    })
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Start (or join) the background refresh for one provider. Returns null when fetching is not
 * possible at all — no URL for either slot, or no stored key: there is nothing to dial, so
 * the shipped directory answers and nothing is written (a provider the operator has not
 * finished configuring must not accumulate failure rows).
 */
function startRefresh(provider: ModelProvider, deps: ProviderModelDeps): Promise<void> | null {
  const protocolType = providerModelProtocol(provider.urls ?? {})
  const baseUrl = protocolType ? provider.urls?.[protocolType]?.trim() : undefined
  const apiKey = (provider.apiKey ?? '').trim()
  if (!protocolType || !baseUrl || !apiKey) return null
  const running = inFlight.get(provider.id)
  if (running) return running
  const refresh = fetchAndStore(provider, protocolType, baseUrl, apiKey, deps).finally(() => {
    inFlight.delete(provider.id)
  })
  inFlight.set(provider.id, refresh)
  return refresh
}

/**
 * Resolve one provider's upstream model list. Never awaits the network: a read answers from
 * the cache, and from the shipped directory when there is none, while a stale/missing list
 * starts a background refresh (at most one per provider, suppressed for a short back-off
 * after a failure).
 *
 * `fromCache`/`stale` describe the ANSWER, not the refresh: a cache hit that is past its TTL
 * is still served from the cache, and reports itself stale.
 */
export function resolveProviderModels(
  provider: ModelProvider,
  deps: ProviderModelDeps = {},
): ProviderModelsResolution {
  const now = (deps.now ?? Date.now)()
  const row = readProviderModelCache(provider.id)
  const cached = row?.models ?? null

  if (isFresh(row, now)) {
    return { models: cached ?? [], fromCache: true, stale: false, refresh: null }
  }

  const refresh = withinBackoff(row, now) ? null : startRefresh(provider, deps)
  const models = cached ?? shippedModels(provider)
  return { models, fromCache: !!cached, stale: true, refresh }
}

/** Test hook: is a background refresh currently running for this provider? */
export function isProviderModelRefreshRunningForTests(providerId: string): boolean {
  return inFlight.has(providerId)
}
