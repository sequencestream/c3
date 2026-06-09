/**
 * Seccomp Profiles — Load and Merge
 *
 * Utilities for loading Docker-compatible seccomp profiles from JSON files
 * and merging multiple profiles into a single configuration.
 *
 * The profile format follows Docker's --security-opt seccomp convention:
 * ```json
 * {
 *   "defaultAction": "SCMP_ACT_ALLOW",
 *   "architectures": ["SCMP_ARCH_X86_64"],
 *   "syscalls": [
 *     { "names": ["read", "write"], "action": "SCMP_ACT_ALLOW" }
 *   ]
 * }
 * ```
 *
 * Layer: kernel/sandbox (inner domain — ADR-0009)
 * Status: Phase 1 (MVP — Docker only)
 *
 * @module
 */

import fs from 'node:fs'

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * A single seccomp syscall rule.
 */
export interface SeccompSyscallRule {
  readonly names: readonly string[]
  readonly action: string
  readonly args?: readonly SeccompArgCondition[]
  readonly comment?: string
}

/**
 * A seccomp argument condition.
 */
export interface SeccompArgCondition {
  readonly index: number
  readonly value: number
  readonly valueTwo?: number
  readonly op: string
}

/**
 * A complete Docker-compatible seccomp profile.
 */
export interface SeccompProfile {
  readonly defaultAction: string
  readonly architectures?: readonly string[]
  readonly syscalls?: readonly SeccompSyscallRule[]
  readonly [key: string]: unknown
}

// ─── Constants ───────────────────────────────────────────────────────────────

/** Default seccomp profile path (relative to this file). */
const DEFAULT_PROFILE_PATH = new URL('default.json', import.meta.url).pathname

/** Cached loaded profile to avoid repeated disk reads. */
let cachedDefault: SeccompProfile | undefined

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Load the default seccomp profile.
 *
 * The default profile is loaded once and cached for subsequent calls.
 *
 * @returns The parsed seccomp profile.
 * @throws {Error} If the profile file cannot be read or parsed.
 */
export function loadDefaultProfile(): SeccompProfile {
  if (cachedDefault) return cachedDefault
  cachedDefault = loadProfile(DEFAULT_PROFILE_PATH)
  return cachedDefault
}

/**
 * Load a seccomp profile from a JSON file path.
 *
 * @param filePath Absolute or relative path to the seccomp JSON file.
 * @returns The parsed seccomp profile.
 * @throws {Error} If the file cannot be read, parsed, or validated.
 */
export function loadProfile(filePath: string): SeccompProfile {
  let raw: string
  try {
    raw = fs.readFileSync(filePath, 'utf-8')
  } catch (cause) {
    throw new Error(`Failed to read seccomp profile: ${filePath}`, { cause })
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (cause) {
    throw new Error(`Failed to parse seccomp profile (invalid JSON): ${filePath}`, { cause })
  }

  if (!isValidProfile(parsed)) {
    throw new Error(`Invalid seccomp profile format: ${filePath} — missing "defaultAction"`)
  }

  return parsed as SeccompProfile
}

/**
 * Merge two seccomp profiles into one.
 *
 * The override profile takes precedence for top-level fields. Syscall rules
 * from both profiles are concatenated (override rules are appended after base
 * rules so they take effect first in Docker's evaluation order).
 *
 * @param base     The base seccomp profile.
 * @param override The overrides to apply on top.
 * @returns A new merged SeccompProfile (base and override are not mutated).
 */
export function mergeProfiles(
  base: SeccompProfile,
  override: Partial<SeccompProfile>,
): SeccompProfile {
  return {
    ...base,
    ...override,
    architectures: override.architectures ?? base.architectures,
    syscalls: [...(base.syscalls ?? []), ...(override.syscalls ?? [])],
  }
}

// ─── Validation ──────────────────────────────────────────────────────────────

/**
 * Minimal validation: check that the parsed value is a non-null object
 * with a string `defaultAction` field.
 */
function isValidProfile(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).defaultAction === 'string'
  )
}
