/**
 * Which IM platforms this build can talk to.
 *
 * Shaped after the vendor adapter registry (ADR-0011): a factory table keyed by
 * platform, so adding a platform is one entry plus one directory. Nothing else
 * in the codebase branches on which platform a robot uses — the neutral layer
 * asks the provider for its capabilities and adapts to those.
 */
import type { ImPlatform } from '@ccc/shared/protocol'
import { createFeishuProvider } from './providers/feishu/index.js'
import { runFeishuAppRegistration } from './providers/feishu/register.js'
import type { AppRegistrationRunner, ImProvider } from './types.js'

type ImProviderFactory = () => ImProvider

/** Partial by design: a platform named in the protocol may have no implementation yet. */
export const IM_PROVIDER_FACTORIES: Partial<Record<ImPlatform, ImProviderFactory>> = {
  feishu: createFeishuProvider,
}

/**
 * The provider for a platform, or null when this build cannot serve it. A null
 * is a normal product state (an unimplemented platform), not an error — the
 * caller reports it as "this robot cannot connect" rather than throwing.
 */
export function resolveImProvider(platform: ImPlatform): ImProvider | null {
  const factory = IM_PROVIDER_FACTORIES[platform]
  return factory ? factory() : null
}

/**
 * One-click app registration runners, keyed by platform — the same shape as the
 * provider factories above. A platform with no implementation is simply absent:
 * the client gates the entry off it, and a request that somehow arrives gets an
 * explicit unsupported result rather than a branch in the neutral layer.
 */
export const IM_APP_REGISTRATION_FACTORIES: Partial<Record<ImPlatform, AppRegistrationRunner>> = {
  feishu: runFeishuAppRegistration,
}

/** The registration runner for a platform, or null when this build cannot serve it. */
export function resolveAppRegistration(platform: ImPlatform): AppRegistrationRunner | null {
  const runner = IM_APP_REGISTRATION_FACTORIES[platform]
  return runner ?? null
}
