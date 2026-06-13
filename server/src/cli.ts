#!/usr/bin/env node
import { Command } from 'commander'
import { resolve } from 'node:path'
import { existsSync, statSync } from 'node:fs'
import { startServer } from './server.js'
import { setSettingsPath } from './kernel/config/index.js'
import { versionString } from './version.js'
import { runVerify } from './verify.js'

const program = new Command()

program
  .name('c3')
  .description('Code Creative Center - browser UI for Claude Code with per-tool permission prompts')
  .version(versionString())

program
  .command('start', { isDefault: true })
  .description('Start the local web server (default command)')
  .option(
    '-p, --project <path>',
    'seed workspace directory; more can be added from the UI',
    process.cwd(),
  )
  .option('--port <number>', 'HTTP port', '3000')
  .option('--dev', 'development mode (do not serve static frontend)', false)
  .option(
    '--settings <path>',
    'path to settings.json (overrides the default ~/.c3/settings.json; its directory also holds state.json)',
  )
  .option(
    '--opencode-url <url>',
    'attach to an external OpenCode server instead of c3 spawning + supervising one',
  )
  .action(
    async (opts: {
      project?: string
      port: string
      dev: boolean
      settings?: string
      opencodeUrl?: string
    }) => {
      // Relocate the config dir before anything reads settings (loadSettings is lazy).
      if (opts.settings) setSettingsPath(opts.settings)
      let projectPath: string | undefined
      if (opts.project) {
        projectPath = resolve(opts.project)
        if (!existsSync(projectPath) || !statSync(projectPath).isDirectory()) {
          console.error(`[c3] error: project path is not a directory: ${projectPath}`)
          process.exit(1)
        }
      }
      const port = Number(opts.port)
      if (!Number.isFinite(port) || port <= 0) {
        console.error(`[c3] error: invalid port: ${opts.port}`)
        process.exit(1)
      }
      await startServer({ projectPath, port, dev: opts.dev, opencodeUrl: opts.opencodeUrl })
    },
  )

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
