/**
 * SandboxRegistry — Named Sandbox Definition Registry
 *
 * Stores system-level sandbox definitions and resolves them against
 * optional project-level overrides via {@link mergeSandboxConfig}.
 *
 * The registry is populated at startup from the system config sandbox
 * profiles section and remains read-only during operation.
 *
 * Layer: kernel/sandbox (inner domain — ADR-0009)
 * Status: Phase 1 (MVP — Docker only)
 *
 * @module
 */

import type { SystemSandboxDef, WorkspaceSandboxConfig, ResolvedSandboxConfig } from './types.js'
import { mergeSandboxConfig } from './SandboxConfig.js'

/**
 * In-memory registry of named sandbox definitions.
 *
 * Thread-safe for reads after construction (Map is never mutated after
 * the initial registration phase).
 */
export class SandboxRegistry {
  /** Internal name-to-definition map. */
  readonly #defs = new Map<string, SystemSandboxDef>()

  /**
   * Register a system sandbox definition.
   *
   * Overwrites any existing definition with the same name.
   *
   * @param def The system sandbox definition to register.
   * @throws {Error} If `def.name` is empty.
   */
  register(def: SystemSandboxDef): void {
    if (!def.name) {
      throw new Error('Sandbox def must have a non-empty name')
    }
    this.#defs.set(def.name, def)
  }

  /**
   * Retrieve a system sandbox definition by name, without applying project
   * overrides.
   *
   * @param name The definition name.
   * @returns The system def, or `undefined` if not found.
   */
  get(name: string): SystemSandboxDef | undefined {
    return this.#defs.get(name)
  }

  /**
   * Resolve a sandbox definition by name, applying optional project-level
   * overrides.
   *
   * @param name         The system definition name.
   * @param projectCfg   Optional project-level overrides.
   * @returns The fully resolved sandbox config.
   * @throws {Error} If no definition exists for the given name.
   */
  resolve(name: string, projectCfg?: WorkspaceSandboxConfig): ResolvedSandboxConfig {
    const def = this.#defs.get(name)
    if (!def) {
      throw new Error(`Unknown sandbox definition: "${name}"`)
    }
    return mergeSandboxConfig(def, projectCfg)
  }

  /**
   * Check whether a definition exists for the given name.
   */
  has(name: string): boolean {
    return this.#defs.has(name)
  }

  /**
   * Return the names of all registered definitions.
   */
  names(): readonly string[] {
    return Array.from(this.#defs.keys())
  }

  /**
   * Return the number of registered definitions.
   */
  get size(): number {
    return this.#defs.size
  }
}
