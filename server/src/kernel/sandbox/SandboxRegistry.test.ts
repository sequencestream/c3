/**
 * SandboxRegistry — Unit Tests
 *
 * Tests cover:
 * - Empty registry behavior
 * - Register and get
 * - Resolve without project overrides
 * - Resolve with partial overrides
 * - Resolve with full overrides
 * - Resolve with unknown name throws
 * - Register with empty name throws
 * - has() / names() / size behavior
 *
 * @module
 */

import { describe, it, expect } from 'vitest'
import { SandboxRegistry } from './SandboxRegistry.js'
import type { SystemSandboxDef } from './types.js'

// ─── Fixtures ────────────────────────────────────────────────────────────────

const DOCKER_DEFAULT: SystemSandboxDef = {
  name: 'default',
  type: 'docker',
  image: 'node:20-alpine',
  memoryLimit: '256m',
  cpuLimit: 1,
  envVars: { NODE_ENV: 'development' },
}

const DOCKER_PYTHON: SystemSandboxDef = {
  name: 'python',
  type: 'docker',
  image: 'python:3.12-slim',
  memoryLimit: '1g',
  cpuLimit: 2,
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('SandboxRegistry', () => {
  describe('empty registry', () => {
    it('has size 0', () => {
      const reg = new SandboxRegistry()
      expect(reg.size).toBe(0)
    })

    it('has no names', () => {
      const reg = new SandboxRegistry()
      expect(reg.names()).toEqual([])
    })

    it('returns false for has()', () => {
      const reg = new SandboxRegistry()
      expect(reg.has('default')).toBe(false)
    })

    it('returns undefined for get()', () => {
      const reg = new SandboxRegistry()
      expect(reg.get('default')).toBeUndefined()
    })

    it('throws on resolve() with unknown name', () => {
      const reg = new SandboxRegistry()
      expect(() => reg.resolve('default')).toThrow('Unknown sandbox definition: "default"')
    })
  })

  describe('register and get', () => {
    it('stores and retrieves a definition', () => {
      const reg = new SandboxRegistry()
      reg.register(DOCKER_DEFAULT)
      expect(reg.get('default')).toEqual(DOCKER_DEFAULT)
    })

    it('overwrites an existing definition', () => {
      const reg = new SandboxRegistry()
      reg.register(DOCKER_DEFAULT)
      const updated = { ...DOCKER_DEFAULT, image: 'node:22-alpine' }
      reg.register(updated)
      expect(reg.get('default')?.image).toBe('node:22-alpine')
    })

    it('rejects empty name', () => {
      const reg = new SandboxRegistry()
      expect(() => reg.register({ name: '', type: 'docker', image: 'alpine' })).toThrow(
        'Sandbox def must have a non-empty name',
      )
    })

    it('tracks size and names', () => {
      const reg = new SandboxRegistry()
      reg.register(DOCKER_DEFAULT)
      reg.register(DOCKER_PYTHON)
      expect(reg.size).toBe(2)
      expect(reg.names()).toEqual(['default', 'python'])
    })

    it('has() returns correct state', () => {
      const reg = new SandboxRegistry()
      reg.register(DOCKER_DEFAULT)
      expect(reg.has('default')).toBe(true)
      expect(reg.has('python')).toBe(false)
    })
  })

  describe('resolve — no project overrides', () => {
    it('returns system def values with defaults filled', () => {
      const reg = new SandboxRegistry()
      reg.register(DOCKER_DEFAULT)
      const resolved = reg.resolve('default')
      expect(resolved.type).toBe('docker')
      expect(resolved.image).toBe('node:20-alpine')
      expect(resolved.memoryLimit).toBe('256m')
      expect(resolved.cpuLimit).toBe(1)
      // Security policies are deny-by-default and live on the workspace config,
      // not the system def — without an override they resolve to true/true.
      expect(resolved.networkDisabled).toBe(true)
      expect(resolved.readonlyRootfs).toBe(true)
      expect(resolved.envVars).toEqual({ NODE_ENV: 'development' })
    })

    it('fills defaults for missing optional fields', () => {
      const reg = new SandboxRegistry()
      reg.register(DOCKER_PYTHON)
      const resolved = reg.resolve('python')
      expect(resolved.memoryLimit).toBe('1g')
      expect(resolved.cpuLimit).toBe(2)
      expect(resolved.networkDisabled).toBe(true)
      expect(resolved.readonlyRootfs).toBe(true)
      expect(resolved.envVars).toEqual({})
    })
  })

  describe('resolve — with project overrides', () => {
    it('overrides image', () => {
      const reg = new SandboxRegistry()
      reg.register(DOCKER_DEFAULT)
      const resolved = reg.resolve('default', { imageOverride: 'node:22-bookworm' })
      expect(resolved.image).toBe('node:22-bookworm')
    })

    it('overrides memory limit', () => {
      const reg = new SandboxRegistry()
      reg.register(DOCKER_DEFAULT)
      const resolved = reg.resolve('default', { memoryLimitOverride: '1g' })
      expect(resolved.memoryLimit).toBe('1g')
    })

    it('overrides CPU limit', () => {
      const reg = new SandboxRegistry()
      reg.register(DOCKER_DEFAULT)
      const resolved = reg.resolve('default', { cpuLimitOverride: 4 })
      expect(resolved.cpuLimit).toBe(4)
    })

    it('merges env vars on top of system def', () => {
      const reg = new SandboxRegistry()
      reg.register(DOCKER_DEFAULT)
      const resolved = reg.resolve('default', {
        envVarsOverride: { DEBUG: 'true' },
      })
      expect(resolved.envVars).toEqual({
        NODE_ENV: 'development',
        DEBUG: 'true',
      })
    })

    it('project override takes precedence over system def', () => {
      const reg = new SandboxRegistry()
      reg.register(DOCKER_DEFAULT)
      const resolved = reg.resolve('default', {
        imageOverride: 'custom:latest',
        memoryLimitOverride: '2g',
        cpuLimitOverride: 8,
        envVarsOverride: { NODE_ENV: 'production' },
      })
      expect(resolved.image).toBe('custom:latest')
      expect(resolved.memoryLimit).toBe('2g')
      expect(resolved.cpuLimit).toBe(8)
      expect(resolved.envVars).toEqual({ NODE_ENV: 'production' })
    })

    it('works with empty project config', () => {
      const reg = new SandboxRegistry()
      reg.register(DOCKER_DEFAULT)
      const resolved = reg.resolve('default', {})
      expect(resolved.image).toBe(DOCKER_DEFAULT.image)
    })

    it('applies the workspace networkDisabled / readonlyRootfs overrides', () => {
      const reg = new SandboxRegistry()
      reg.register(DOCKER_DEFAULT)
      // Loosen both deny-by-default policies from the workspace config.
      const resolved = reg.resolve('default', { networkDisabled: false, readonlyRootfs: false })
      expect(resolved.networkDisabled).toBe(false)
      expect(resolved.readonlyRootfs).toBe(false)
    })

    it('falls back to deny-by-default when the policies are unset', () => {
      const reg = new SandboxRegistry()
      reg.register(DOCKER_DEFAULT)
      const resolved = reg.resolve('default', { imageOverride: 'custom:latest' })
      expect(resolved.networkDisabled).toBe(true)
      expect(resolved.readonlyRootfs).toBe(true)
    })
  })

  describe('resolve — legacy system-def security fields are culled', () => {
    it('ignores networkDisabled / readonlyRootfs left on a system def', () => {
      const reg = new SandboxRegistry()
      // A def persisted before the fields moved to the workspace config. The
      // parse layer strips them; even if one sneaks through, merge ignores them.
      reg.register({
        name: 'legacy',
        type: 'docker',
        image: 'node:20-alpine',
        networkDisabled: false,
        readonlyRootfs: false,
      } as unknown as SystemSandboxDef)
      const resolved = reg.resolve('legacy')
      // Resolved values come from the deny-by-default merge, not the stale def.
      expect(resolved.networkDisabled).toBe(true)
      expect(resolved.readonlyRootfs).toBe(true)
    })
  })
})
