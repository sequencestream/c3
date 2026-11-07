import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openHarnessClient } from './driver.js'
import { dshSdkProcess } from './launch.js'

describe('dshSdkProcess', () => {
  it('argv is the host executable plus --profile sdk', () => {
    const spec = dshSdkProcess({
      binary: '/opt/dsh',
      cwd: '/work',
      env: { PATH: '/usr/bin' },
      dshHome: '/home/dsh',
    })
    expect(spec.command).toBe('/opt/dsh')
    expect(spec.command).not.toBe(process.execPath)
    expect(spec.args).toEqual(['--profile', 'sdk'])
    expect(spec.cwd).toBe('/work')
    expect(spec.environment()).toMatchObject({ PATH: '/usr/bin', DSH_HOME: '/home/dsh' })
    expect(spec.description).toBe('dsh profile "sdk"')
    expect(spec.initializeTimeoutMs).toBe(10_000)
  })
})

describe('openHarnessClient', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('executes the dsh binary directly so a shell wrapper is not parsed as JavaScript', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'c3-dsh-launch-'))
    dirs.push(dir)
    const record = join(dir, 'argv')
    const bin = join(dir, 'dsh')
    const home = join(dir, 'home')
    writeFileSync(
      bin,
      [
        '#!/bin/sh',
        '{',
        'printf \'%s\\n\' "$0"',
        'printf \'%s\\n\' "$@"',
        'printf \'%s\\n\' "$DSH_HOME"',
        '} > "$C3_DSH_ARGV_FILE"',
        '',
      ].join('\n'),
      'utf8',
    )
    chmodSync(bin, 0o755)

    const client = openHarnessClient({
      binary: bin,
      cwd: dir,
      env: { C3_DSH_ARGV_FILE: record, PATH: process.env.PATH ?? '' },
      dshHome: home,
    })
    client.start()
    await client.close()

    expect(readFileSync(record, 'utf8').trim().split('\n')).toEqual([bin, '--profile', 'sdk', home])
  })
})
