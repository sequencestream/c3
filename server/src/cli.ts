#!/usr/bin/env node
import { Command } from 'commander'
import { resolve } from 'node:path'
import { existsSync, statSync } from 'node:fs'
import { startServer } from './server.js'
import { setSettingsPath } from './kernel/config/index.js'
import { versionString } from './version.js'
import { runVerify } from './verify.js'
import { startDaemon, type DaemonStartOptions } from './daemon.js'
import { installService, UnsupportedPlatformError } from './service-install.js'
import { uninstallService } from './service-uninstall.js'

const program = new Command()

program
  .name('c3')
  .description('Code Creative Center - browser UI for Claude Code with per-tool permission prompts')
  .version(versionString())

/** Options shared by `start` and `install` (the launch surface they both bake). */
interface LaunchOpts {
  workspace?: string
  project?: string
  port: string
  dev: boolean
  settings?: string
}

/**
 * Resolve the raw launch options into validated, absolute values shared by the
 * foreground `start`, the `--daemon` respawn, and the `install` unit. Exits the
 * process with a clear message on an invalid workspace / port (same checks the
 * foreground path always used).
 */
function resolveLaunchOptions(opts: LaunchOpts): {
  workspacePath?: string
  port: number
  dev: boolean
  settingsPath?: string
} {
  // --workspace carries the cwd default; --project (no default) is a deprecated
  // alias kept for one cycle. Explicit --project wins and warns once.
  let seed = opts.workspace
  if (opts.project !== undefined) {
    console.error('[c3] warning: --project is deprecated; use --workspace instead')
    seed = opts.project
  }
  let workspacePath: string | undefined
  if (seed) {
    workspacePath = resolve(seed)
    if (!existsSync(workspacePath) || !statSync(workspacePath).isDirectory()) {
      console.error(`[c3] error: workspace path is not a directory: ${workspacePath}`)
      process.exit(1)
    }
  }
  const port = Number(opts.port)
  if (!Number.isFinite(port) || port <= 0) {
    console.error(`[c3] error: invalid port: ${opts.port}`)
    process.exit(1)
  }
  // Settings path is resolved to absolute so a daemon child / service unit reads
  // the SAME c3 home as this invocation (a relative path would re-resolve against
  // the child's cwd).
  const settingsPath = opts.settings ? resolve(opts.settings) : undefined
  return { workspacePath, port, dev: opts.dev, settingsPath }
}

program
  .command('start', { isDefault: true })
  .description('Start the local web server (default command)')
  .option(
    '-w, --workspace <path>',
    'seed workspace directory; more can be added from the UI',
    process.cwd(),
  )
  .option('-p, --project <path>', '[deprecated] alias for --workspace')
  .option('--port <number>', 'HTTP port', '3000')
  .option('--dev', 'development mode (do not serve static frontend)', false)
  .option('--daemon', 'run in the background (detach from the terminal) and exit', false)
  .option(
    '--settings <path>',
    'path to settings.json (overrides the default ~/.c3/settings.json; its directory also holds state.json)',
  )
  .action(async (opts: LaunchOpts & { daemon: boolean }) => {
    const { workspacePath, port, dev, settingsPath } = resolveLaunchOptions(opts)
    // Relocate the config dir before anything reads settings (loadSettings is lazy).
    // Done AFTER resolveLaunchOptions so the daemon child gets the absolute path too.
    if (settingsPath) setSettingsPath(settingsPath)

    if (opts.daemon) {
      // Re-spawn a detached `start` WITHOUT --daemon (never self-fork) and exit.
      const startOpts: DaemonStartOptions = { workspacePath, port, dev, settingsPath }
      const outcome = startDaemon(startOpts)
      if (outcome.kind === 'already-running') {
        console.error(
          `[c3] already running in background (pid ${outcome.pid}); pid file: ${outcome.pidPath}`,
        )
        console.error('[c3] stop it first, or remove the stale pid file, before starting again')
        process.exit(1)
      }
      console.log(`[c3] started in background (pid ${outcome.pid})`)
      console.log(`[c3] logs: ${outcome.logPath}`)
      console.log(`[c3] pid file: ${outcome.pidPath}`)
      process.exit(0)
    }

    await startServer({ workspacePath, port, dev })
  })

program
  .command('install')
  .description('Install c3 as a per-user OS service (systemd / launchd / schtasks)')
  .option(
    '-w, --workspace <path>',
    'seed workspace directory baked into the service unit',
    process.cwd(),
  )
  .option('-p, --project <path>', '[deprecated] alias for --workspace')
  .option('--port <number>', 'HTTP port baked into the service unit', '3000')
  .option('--dev', 'development mode (do not serve static frontend)', false)
  .option(
    '--settings <path>',
    'path to settings.json baked into the service unit (absolute; the service reads the same ~/.c3)',
  )
  .action((opts: LaunchOpts) => {
    const { workspacePath, port, dev, settingsPath } = resolveLaunchOptions(opts)
    try {
      const result = installService({
        platform: process.platform,
        execPath: process.execPath,
        scriptPath: process.argv[1],
        execArgv: process.execArgv,
        start: { workspacePath, port, dev, settingsPath },
      })
      if (result.kind === 'register-failed') {
        const { command, status, stderr } = result
        console.error(
          `[c3] error: service registration failed: ${command.cmd} ${command.args.join(' ')} (exit ${status})`,
        )
        if (stderr.trim()) console.error(stderr.trim())
        console.error(
          `[c3] ensure '${command.cmd}' is installed and on PATH, then re-run 'c3 install'`,
        )
        process.exit(1)
      }
      console.log(`[c3] installed ${result.plan.platform} service`)
      if (result.plan.unitPath) console.log(`[c3] unit: ${result.plan.unitPath}`)
      for (const note of result.plan.notes) console.log(`[c3] ${note}`)
      process.exit(0)
    } catch (err) {
      if (err instanceof UnsupportedPlatformError) {
        console.error(`[c3] error: ${err.message}`)
        console.error(
          '[c3] supported platforms: linux (systemd), darwin (launchd), win32 (schtasks)',
        )
        console.error('[c3] run c3 with `--daemon` for a background process without an OS service')
        process.exit(1)
      }
      throw err
    }
  })

program
  .command('uninstall')
  .description('Remove the c3 per-user OS service (keeps all c3 data)')
  .action(() => {
    try {
      const result = uninstallService({ platform: process.platform })
      if (result.kind === 'not-installed') {
        console.log(`[c3] ${result.plan.notInstalledMessage}`)
        process.exit(0)
      }
      if (result.kind === 'probe-failed' || result.kind === 'unregister-failed') {
        const { command, status, stderr } = result
        const operation = result.kind === 'probe-failed' ? 'service check' : 'service removal'
        console.error(
          `[c3] error: ${operation} failed: ${command.cmd} ${command.args.join(' ')} (exit ${status})`,
        )
        if (stderr.trim()) console.error(stderr.trim())
        console.error(
          `[c3] ensure '${command.cmd}' is installed and on PATH, then re-run 'c3 uninstall'`,
        )
        process.exit(1)
      }
      console.log(`[c3] uninstalled ${result.plan.platform} service; c3 data was kept`)
      process.exit(0)
    } catch (err) {
      if (err instanceof UnsupportedPlatformError) {
        console.error(`[c3] error: ${err.message.replace("'c3 install'", "'c3 uninstall'")}`)
        console.error(
          '[c3] supported platforms: linux (systemd), darwin (launchd), win32 (schtasks)',
        )
        process.exit(1)
      }
      throw err
    }
  })

program
  .command('verify <file>')
  .description('Verify a downloaded c3 artifact against the embedded minisign public key')
  .action((file: string) => {
    process.exit(runVerify(resolve(file)))
  })

program.parseAsync(process.argv).catch((err) => {
  console.error('[c3] fatal:', err)
  process.exit(1)
})
