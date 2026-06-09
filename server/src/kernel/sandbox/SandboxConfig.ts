/**
 * SandboxConfig — Zod Schemas and Merge Logic
 *
 * Two-tier config model:
 * 1. **System def** — a sandbox "template" registered at startup in system config
 * 2. **Project config** — per-project overrides referencing a system def by name
 *
 * `mergeSandboxConfig()` combines the two into a fully-resolved
 * {@link ResolvedSandboxConfig} with all defaults filled.
 *
 * Layer: kernel/sandbox (inner domain — ADR-0009)
 * Status: Phase 1 (MVP — Docker only)
 *
 * @module
 */

import { z } from 'zod'
import type { SystemSandboxDef, ProjectSandboxConfig, ResolvedSandboxConfig } from './types.js'

// ─── Zod Schemas ─────────────────────────────────────────────────────────────

/**
 * Zod schema for a system-level sandbox definition.
 */
export const systemSandboxDefSchema = z.object({
  name: z.string().min(1, 'Sandbox def name is required'),
  type: z.enum(['docker', 'gvisor', 'kata', 'firecracker']),
  image: z.string().min(1, 'Container image is required'),
  seccomp: z.string().optional(),
  memoryLimit: z
    .string()
    .regex(/^\d+(b|k|m|g|t)?$/i, 'Invalid memory limit format')
    .optional(),
  cpuLimit: z.number().positive().optional(),
  envVars: z.record(z.string(), z.string()).optional(),
  networkDisabled: z.boolean().optional(),
  readonlyRootfs: z.boolean().optional(),
  workingDir: z.string().optional(),
  entrypoint: z.array(z.string()).optional(),
  dockerOptions: z.record(z.string(), z.unknown()).optional(),
})

/**
 * Zod schema for project-level sandbox config overrides.
 */
export const projectSandboxConfigSchema = z.object({
  sandbox: z.string().optional(),
  imageOverride: z.string().optional(),
  memoryLimitOverride: z
    .string()
    .regex(/^\d+(b|k|m|g|t)?$/i, 'Invalid memory limit format')
    .optional(),
  cpuLimitOverride: z.number().positive().optional(),
  envVarsOverride: z.record(z.string(), z.string()).optional(),
})

// ─── Default Values ──────────────────────────────────────────────────────────

/**
 * Default values applied when the system def does not specify optional fields.
 */
const DEFAULTS = {
  memoryLimit: '512m',
  cpuLimit: 1,
  networkDisabled: false,
  readonlyRootfs: false,
  envVars: {},
} as const satisfies Partial<ResolvedSandboxConfig>

// ─── Merge Function ──────────────────────────────────────────────────────────

/**
 * Merge a system sandbox definition with optional project-level overrides,
 * returning a fully resolved configuration.
 *
 * Project overrides take precedence over system def values. Fields not
 * specified in either source receive sensible defaults.
 *
 * @param systemDef   The system-level sandbox definition.
 * @param projectCfg  Optional project-level overrides.
 * @returns A fully resolved sandbox configuration.
 */
export function mergeSandboxConfig(
  systemDef: SystemSandboxDef,
  projectCfg?: ProjectSandboxConfig,
): ResolvedSandboxConfig {
  const merged: ResolvedSandboxConfig = {
    type: systemDef.type,
    image: projectCfg?.imageOverride ?? systemDef.image,
    seccomp: systemDef.seccomp,
    memoryLimit: projectCfg?.memoryLimitOverride ?? systemDef.memoryLimit ?? DEFAULTS.memoryLimit,
    cpuLimit: projectCfg?.cpuLimitOverride ?? systemDef.cpuLimit ?? DEFAULTS.cpuLimit,
    networkDisabled: systemDef.networkDisabled ?? DEFAULTS.networkDisabled,
    readonlyRootfs: systemDef.readonlyRootfs ?? DEFAULTS.readonlyRootfs,
    envVars: {
      ...DEFAULTS.envVars,
      ...systemDef.envVars,
      ...projectCfg?.envVarsOverride,
    },
    workingDir: systemDef.workingDir,
    entrypoint: systemDef.entrypoint,
    dockerOptions: systemDef.dockerOptions,
  }
  return merged
}

// ─── Compile-Time Type Pins ──────────────────────────────────────────────────

/**
 * Utility: asserts T extends U (both directions) for exact type match.
 */
type _AssertEqual<T, U> = T extends U ? (U extends T ? true : never) : never

/**
 * Pin systemSandboxDefSchema to SystemSandboxDef.
 * If this line fails, the Zod schema and the interface have drifted.
 */
type _PinSystemDefSchema = _AssertEqual<z.infer<typeof systemSandboxDefSchema>, SystemSandboxDef>

/**
 * Pin projectSandboxConfigSchema to ProjectSandboxConfig.
 */
type _PinProjectConfigSchema = _AssertEqual<
  z.infer<typeof projectSandboxConfigSchema>,
  ProjectSandboxConfig
>
