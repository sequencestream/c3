#!/usr/bin/env node
import { Command } from 'commander'
import { resolve } from 'node:path'
import { existsSync, statSync } from 'node:fs'
import { startServer } from './server.js'

const program = new Command()

program
  .name('c3')
  .description('Claude Code Center - browser UI for Claude Code with per-tool permission prompts')
  .version('0.1.0')

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
  .action(async (opts: { project?: string; port: string; dev: boolean }) => {
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
    await startServer({ projectPath, port, dev: opts.dev })
  })

program.parseAsync(process.argv).catch((err) => {
  console.error('[c3] fatal:', err)
  process.exit(1)
})
