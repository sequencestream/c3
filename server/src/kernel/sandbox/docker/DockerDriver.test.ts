/**
 * DockerDriver — Unit Tests
 *
 * Uses a mock dockerode instance injected via the constructor to avoid
 * requiring a real Docker daemon. Each test validates that:
 * 1. The correct dockerode methods are called with the expected arguments
 * 2. The driver returns the correct result shape
 * 3. Errors from dockerode are propagated correctly
 *
 * Integration/end-to-end tests with a real Docker daemon are covered
 * separately in the E2E suite.
 *
 * Layer: kernel/sandbox (inner domain — ADR-0009)
 * Status: Phase 1 (MVP — Docker only)
 *
 * @module
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Readable } from 'node:stream'
import { DockerDriver, type DockerDriverOptions } from './DockerDriver.js'
import type { ResolvedSandboxConfig, SandboxHandle } from '../types.js'

// ─── Fixtures ────────────────────────────────────────────────────────────────

const TEST_CONFIG: ResolvedSandboxConfig = {
  type: 'docker',
  image: 'node:20-alpine',
  memoryLimit: '256m',
  cpuLimit: 1,
  networkDisabled: false,
  readonlyRootfs: false,
  envVars: { NODE_ENV: 'test' },
  entrypoint: ['sleep', 'infinity'],
  workingDir: '/workspace',
}

const TEST_HANDLE: SandboxHandle = {
  sandboxId: 'test-sandbox-001',
  type: 'docker',
  containerId: 'abc123def456',
  image: 'node:20-alpine',
  createdAt: Date.now(),
  status: 'running',
}

// ─── Mock Factory ────────────────────────────────────────────────────────────

interface MockContainer {
  id: string
  start: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
  remove: ReturnType<typeof vi.fn>
  exec: ReturnType<typeof vi.fn>
  commit: ReturnType<typeof vi.fn>
  inspect: ReturnType<typeof vi.fn>
  wait: ReturnType<typeof vi.fn>
}

interface MockExec {
  start: ReturnType<typeof vi.fn>
  inspect: ReturnType<typeof vi.fn>
}

interface MockDocker {
  createContainer: ReturnType<typeof vi.fn>
  getContainer: ReturnType<typeof vi.fn>
  modem?: unknown
}

function createMocks(): {
  docker: MockDocker
  container: MockContainer
  exec: MockExec
} {
  const exec: MockExec = {
    start: vi.fn(),
    inspect: vi.fn(),
  }

  const container: MockContainer = {
    id: 'abc123def456',
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    exec: vi.fn().mockResolvedValue(exec),
    commit: vi.fn().mockResolvedValue({ Id: 'sha256:snapshot123' }),
    inspect: vi.fn(),
    wait: vi.fn().mockResolvedValue({ StatusCode: 0 }),
  }

  const docker: MockDocker = {
    createContainer: vi.fn().mockResolvedValue(container),
    getContainer: vi.fn().mockReturnValue(container),
  }

  return { docker, container, exec }
}

function createDriver(mocks: MockDocker): DockerDriver {
  return new DockerDriver({
    docker: mocks as unknown as NonNullable<DockerDriverOptions['docker']>,
  })
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeStream(output: string): Readable {
  return Readable.from([Buffer.from(output)])
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('DockerDriver', () => {
  let mocks: ReturnType<typeof createMocks>
  let driver: DockerDriver

  beforeEach(() => {
    mocks = createMocks()
    driver = createDriver(mocks.docker)
  })

  // ─── Start ─────────────────────────────────────────────────────────────

  describe('start()', () => {
    it('creates and starts a container with the resolved config', async () => {
      const handle = await driver.start(TEST_CONFIG)

      expect(mocks.docker.createContainer).toHaveBeenCalledTimes(1)
      expect(mocks.docker.createContainer).toHaveBeenCalledWith(
        expect.objectContaining({
          Image: 'node:20-alpine',
          Cmd: ['sleep', 'infinity'],
          WorkingDir: '/workspace',
          Env: ['NODE_ENV=test'],
          HostConfig: expect.objectContaining({
            Memory: 268435456, // 256m in bytes
            CpuPeriod: 100000,
            CpuQuota: 100000, // 1 CPU
            ReadonlyRootfs: false,
            NetworkMode: undefined, // not disabled
          }),
        }),
      )

      expect(mocks.container.start).toHaveBeenCalledTimes(1)
      expect(handle.sandboxId).toBeDefined()
      expect(handle.containerId).toBe('abc123def456')
      expect(handle.type).toBe('docker')
      expect(handle.image).toBe('node:20-alpine')
      expect(handle.status).toBe('running')
    })

    it('passes bind mounts to HostConfig', async () => {
      await driver.start(TEST_CONFIG, {
        binds: ['/host/path:/container/path'],
      })

      const createCall = mocks.docker.createContainer.mock.calls[0][0]
      expect(createCall.HostConfig.Binds).toEqual(['/host/path:/container/path'])
    })

    it('passes labels to container create', async () => {
      await driver.start(TEST_CONFIG, {
        labels: { 'c3.run': 'test-001' },
      })

      const createCall = mocks.docker.createContainer.mock.calls[0][0]
      expect(createCall.Labels).toEqual({ 'c3.run': 'test-001' })
    })

    it('disables network when configured', async () => {
      await driver.start({ ...TEST_CONFIG, networkDisabled: true })

      const createCall = mocks.docker.createContainer.mock.calls[0][0]
      expect(createCall.HostConfig.NetworkMode).toBe('none')
    })

    it('sets readonly rootfs when configured', async () => {
      await driver.start({ ...TEST_CONFIG, readonlyRootfs: true })

      const createCall = mocks.docker.createContainer.mock.calls[0][0]
      expect(createCall.HostConfig.ReadonlyRootfs).toBe(true)
    })

    it('propagates docker create errors', async () => {
      mocks.docker.createContainer.mockRejectedValue(new Error('connection refused'))

      await expect(driver.start(TEST_CONFIG)).rejects.toThrow('connection refused')
    })
  })

  // ─── Stop ──────────────────────────────────────────────────────────────

  describe('stop()', () => {
    it('stops the container with default timeout', async () => {
      await driver.stop(TEST_HANDLE)

      expect(mocks.docker.getContainer).toHaveBeenCalledWith('abc123def456')
      expect(mocks.container.stop).toHaveBeenCalledWith({ t: 10 })
    })

    it('stops with custom timeout', async () => {
      await driver.stop(TEST_HANDLE, { timeout: 30 })

      expect(mocks.container.stop).toHaveBeenCalledWith({ t: 30 })
    })

    it('removes container when remove option is true', async () => {
      await driver.stop(TEST_HANDLE, { remove: true })

      expect(mocks.container.remove).toHaveBeenCalledWith({ force: true })
    })

    it('does not remove container by default', async () => {
      await driver.stop(TEST_HANDLE)

      expect(mocks.container.remove).not.toHaveBeenCalled()
    })

    it('swallows stop error if container already stopped', async () => {
      mocks.container.stop.mockRejectedValue(new Error('container already stopped'))

      await expect(driver.stop(TEST_HANDLE)).resolves.toBeUndefined()
    })

    it('swallows remove error if container already removed', async () => {
      mocks.container.stop.mockResolvedValue(undefined)
      mocks.container.remove.mockRejectedValue(new Error('not found'))

      await expect(driver.stop(TEST_HANDLE, { remove: true })).resolves.toBeUndefined()
    })
  })

  // ─── Exec ──────────────────────────────────────────────────────────────

  describe('exec()', () => {
    it('runs a command and returns output', async () => {
      mocks.exec.start.mockResolvedValue(makeStream('hello world\n'))
      mocks.exec.inspect.mockResolvedValue({ ExitCode: 0 })

      const result = await driver.exec(TEST_HANDLE, ['echo', 'hello'])

      expect(mocks.container.exec).toHaveBeenCalledWith({
        Cmd: ['echo', 'hello'],
        AttachStdout: true,
        AttachStderr: true,
      })

      expect(mocks.exec.start).toHaveBeenCalledWith({ Tty: true, Detach: false })
      expect(result.stdout).toBe('hello world\n')
      expect(result.exitCode).toBe(0)
    })

    it('returns non-zero exit code', async () => {
      mocks.exec.start.mockResolvedValue(makeStream('error: not found\n'))
      mocks.exec.inspect.mockResolvedValue({ ExitCode: 1 })

      const result = await driver.exec(TEST_HANDLE, ['false'])
      expect(result.exitCode).toBe(1)
    })

    it('handles empty output', async () => {
      mocks.exec.start.mockResolvedValue(makeStream(''))
      mocks.exec.inspect.mockResolvedValue({ ExitCode: 0 })

      const result = await driver.exec(TEST_HANDLE, ['true'])
      expect(result.stdout).toBe('')
      expect(result.exitCode).toBe(0)
    })

    it('propagates exec creation errors', async () => {
      mocks.container.exec.mockRejectedValue(new Error('container not running'))

      await expect(driver.exec(TEST_HANDLE, ['ls'])).rejects.toThrow('container not running')
    })
  })

  // ─── Spawn Stream ──────────────────────────────────────────────────────

  describe('spawnStream()', () => {
    it('returns a readable stream from docker exec', async () => {
      const stream = makeStream('streaming output\n')
      mocks.exec.start.mockResolvedValue(stream)

      const result = await driver.spawnStream(TEST_HANDLE, ['tail', '-f'])

      expect(mocks.container.exec).toHaveBeenCalledWith({
        Cmd: ['tail', '-f'],
        AttachStdout: true,
        AttachStderr: true,
      })
      expect(mocks.exec.start).toHaveBeenCalledWith({ Tty: true, Detach: false })
      expect(result).toBeInstanceOf(Readable)
    })

    it('propagates errors', async () => {
      mocks.container.exec.mockRejectedValue(new Error('not found'))

      await expect(driver.spawnStream(TEST_HANDLE, ['badcmd'])).rejects.toThrow('not found')
    })
  })

  // ─── Snapshot ──────────────────────────────────────────────────────────

  describe('snapshot()', () => {
    it('commits the container with the given tag', async () => {
      const imageId = await driver.snapshot(TEST_HANDLE, 'my-snapshot:latest')

      expect(mocks.container.commit).toHaveBeenCalledWith({ repo: 'my-snapshot:latest' })
      expect(imageId).toBe('sha256:snapshot123')
    })

    it('propagates commit errors', async () => {
      mocks.container.commit.mockRejectedValue(new Error('commit failed'))

      await expect(driver.snapshot(TEST_HANDLE, 'snap')).rejects.toThrow('commit failed')
    })
  })

  // ─── Health Check ──────────────────────────────────────────────────────

  describe('healthCheck()', () => {
    it('returns running status for a running container', async () => {
      mocks.container.inspect.mockResolvedValue({
        State: {
          Running: true,
          StartedAt: '2026-06-09T00:00:00.000Z',
          ExitCode: 0,
        },
      })

      const status = await driver.healthCheck(TEST_HANDLE)

      expect(mocks.docker.getContainer).toHaveBeenCalledWith('abc123def456')
      expect(status.running).toBe(true)
      expect(status.status).toBe('running')
      expect(status.startedAt).toBeDefined()
    })

    it('returns stopped status for a stopped container', async () => {
      mocks.container.inspect.mockResolvedValue({
        State: {
          Running: false,
          StartedAt: '2026-06-09T00:00:00.000Z',
          FinishedAt: '2026-06-09T01:00:00.000Z',
          ExitCode: 0,
        },
      })

      const status = await driver.healthCheck(TEST_HANDLE)
      expect(status.running).toBe(false)
      expect(status.status).toBe('stopped')
      expect(status.finishedAt).toBeDefined()
    })

    it('returns error status on inspect failure', async () => {
      mocks.container.inspect.mockRejectedValue(new Error('container not found'))

      const status = await driver.healthCheck(TEST_HANDLE)
      expect(status.running).toBe(false)
      expect(status.status).toBe('error')
      expect(status.error).toContain('container not found')
    })
  })
})
