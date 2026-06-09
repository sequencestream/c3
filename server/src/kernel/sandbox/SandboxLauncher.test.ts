/**
 * SandboxLauncher — Unit Tests
 *
 * Tests cover:
 * - Sandbox disabled → returns null
 * - Sandbox enabled → launches container
 * - createSandboxWrapper → writes valid script
 * - Docker unavailable → error handling
 *
 * @module
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { existsSync, rmSync, mkdtempSync, readFileSync, statSync } from 'node:fs'
// import { randomUUID } from 'node:crypto'

// Mock the config module before importing SandboxLauncher
vi.mock('../../kernel/config/index.js', () => ({
  getProjectSandbox: vi.fn(),
}))

import { getProjectSandbox } from '../../kernel/config/index.js'
import { SandboxRegistry } from './SandboxRegistry.js'
import { launchSandbox, createSandboxWrapper, checkDockerAvailable } from './SandboxLauncher.js'
import type { SandboxHandle } from './types.js'

// ─── Fixtures ────────────────────────────────────────────────────────────────

const TEST_HANDLE: SandboxHandle = {
  sandboxId: 'sb-test-001',
  type: 'docker',
  containerId: 'c0ffee1234567890abc',
  image: 'node:20-alpine',
  createdAt: Date.now(),
  status: 'running',
}

const TEST_PROJECT = '/home/user/projects/my-project'
const TEST_VENDOR_BINARY = 'claude'

// ─── Mock Driver ─────────────────────────────────────────────────────────────

function createMockDriver() {
  return {
    start: vi.fn().mockResolvedValue(TEST_HANDLE),
    stop: vi.fn().mockResolvedValue(undefined),
    exec: vi.fn(),
    spawnStream: vi.fn(),
    snapshot: vi.fn(),
    copyFrom: vi.fn(),
    healthCheck: vi.fn(),
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('SandboxLauncher', () => {
  let mockDriver: ReturnType<typeof createMockDriver>
  let registry: SandboxRegistry

  beforeEach(() => {
    mockDriver = createMockDriver()
    registry = new SandboxRegistry()
    registry.register({
      name: 'default',
      type: 'docker',
      image: 'node:20-alpine',
      memoryLimit: '512m',
      cpuLimit: 1,
    })
    vi.clearAllMocks()
  })

  describe('launchSandbox', () => {
    it('returns null when sandbox config is missing', async () => {
      vi.mocked(getProjectSandbox).mockReturnValue(undefined)

      const result = await launchSandbox(mockDriver, registry, TEST_PROJECT)
      expect(result).toBeNull()
    })

    it('returns null when sandbox is not enabled', async () => {
      vi.mocked(getProjectSandbox).mockReturnValue({
        sandbox: 'default',
        enabled: false,
      })

      const result = await launchSandbox(mockDriver, registry, TEST_PROJECT)
      expect(result).toBeNull()
    })

    it('returns null when no sandbox def is referenced', async () => {
      vi.mocked(getProjectSandbox).mockReturnValue({
        enabled: true,
        // no 'sandbox' field → no def referenced
      })

      const result = await launchSandbox(mockDriver, registry, TEST_PROJECT)
      expect(result).toBeNull()
    })

    it('starts a container when sandbox is enabled', async () => {
      vi.mocked(getProjectSandbox).mockReturnValue({
        sandbox: 'default',
        enabled: true,
      })

      const result = await launchSandbox(mockDriver, registry, TEST_PROJECT)

      expect(result).not.toBeNull()
      expect(result!.handle).toBe(TEST_HANDLE)
      expect(result!.tmpDir).toBeDefined()
      // tmp dir should exist
      expect(existsSync(result!.tmpDir)).toBe(true)

      expect(mockDriver.start).toHaveBeenCalledTimes(1)
      const startCall = mockDriver.start.mock.calls[0]
      expect(startCall[0].image).toBe('node:20-alpine')
      expect(startCall[1]?.binds).toContain(`${TEST_PROJECT}:/workspace`)
    })

    it('stops container and cleans up tmp dir', async () => {
      vi.mocked(getProjectSandbox).mockReturnValue({
        sandbox: 'default',
        enabled: true,
      })

      const result = await launchSandbox(mockDriver, registry, TEST_PROJECT)
      expect(result).not.toBeNull()

      const tmpDir = result!.tmpDir
      await result!.stop()

      expect(mockDriver.stop).toHaveBeenCalledWith(TEST_HANDLE, {
        timeout: 10,
        remove: true,
      })
      // tmp dir should be cleaned up
      expect(existsSync(tmpDir)).toBe(false)
    })

    it('throws when container start fails', async () => {
      vi.mocked(getProjectSandbox).mockReturnValue({
        sandbox: 'default',
        enabled: true,
      })
      mockDriver.start.mockRejectedValue(new Error('connection refused'))

      await expect(launchSandbox(mockDriver, registry, TEST_PROJECT)).rejects.toThrow(
        'connection refused',
      )
    })
  })

  describe('createSandboxWrapper', () => {
    let tmpDir: string
    const TEST_ENV: Record<string, string> = {
      ANTHROPIC_API_KEY: 'sk-ant-xxx',
      ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
      CLAUDE_CONFIG_DIR: '/workspace/.claude',
    }

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'c3-sb-test-'))
    })

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true })
    })

    it('creates an executable wrapper script', () => {
      const scriptPath = createSandboxWrapper(TEST_HANDLE, tmpDir, TEST_VENDOR_BINARY, TEST_ENV)

      expect(existsSync(scriptPath)).toBe(true)
      // Check it's executable
      const mode = statSync(scriptPath).mode
      expect(mode & 0o111).toBeTruthy()

      // Check script content
      const content = readFileSync(scriptPath, 'utf-8')
      expect(content).toContain('docker exec')
      expect(content).toContain(TEST_HANDLE.containerId)
      expect(content).toContain(TEST_VENDOR_BINARY)
      expect(content).toContain('/workspace')
    })

    it('writes the env file alongside the wrapper', () => {
      createSandboxWrapper(TEST_HANDLE, tmpDir, TEST_VENDOR_BINARY, TEST_ENV)

      const envFilePath = join(tmpDir, 'env.txt')
      expect(existsSync(envFilePath)).toBe(true)

      const envContent = readFileSync(envFilePath, 'utf-8')
      expect(envContent).toContain('ANTHROPIC_API_KEY=sk-ant-xxx')
      expect(envContent).toContain('ANTHROPIC_BASE_URL=https://api.anthropic.com')
      expect(envContent).toContain('CLAUDE_CONFIG_DIR=/workspace/.claude')
    })

    it('handles empty env vars', () => {
      const scriptPath = createSandboxWrapper(TEST_HANDLE, tmpDir, TEST_VENDOR_BINARY, {})

      expect(existsSync(scriptPath)).toBe(true)
      const envFilePath = join(tmpDir, 'env.txt')
      // Env file should exist but be effectively empty (just newline)
      const envContent = readFileSync(envFilePath, 'utf-8')
      expect(envContent.trim()).toBe('')
    })
  })

  describe('checkDockerAvailable', () => {
    it('returns null when Docker is reachable', async () => {
      const result = await checkDockerAvailable(mockDriver)
      expect(result).toBeNull()
    })

    it('returns error message when Docker is unreachable', async () => {
      mockDriver.start.mockRejectedValue(new Error('connect ENOENT /var/run/docker.sock'))

      const result = await checkDockerAvailable(mockDriver)
      expect(result).toContain('Docker is not available')
    })
  })
})
