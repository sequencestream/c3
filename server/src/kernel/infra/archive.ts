import { spawnSync } from 'node:child_process'
import { basename, dirname, win32 } from 'node:path'

export interface TarExtractInvocation {
  readonly command: 'tar'
  readonly args: string[]
  readonly cwd: string
}

/** Keep Windows drive letters out of tar's archive operand. */
export function tarExtractInvocation(
  archivePath: string,
  destDir: string,
  gzip: boolean,
): TarExtractInvocation {
  const windowsPath = /^[A-Za-z]:[\\/]/.test(archivePath)
  return {
    command: 'tar',
    args: [
      gzip ? '-xzf' : '-xf',
      windowsPath ? win32.basename(archivePath) : basename(archivePath),
      '-C',
      destDir,
    ],
    cwd: windowsPath ? win32.dirname(archivePath) : dirname(archivePath),
  }
}

export function extractWithTar(archivePath: string, destDir: string, gzip = false): void {
  const invocation = tarExtractInvocation(archivePath, destDir, gzip)
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: invocation.cwd,
    encoding: 'utf-8',
  })
  if (result.error || result.status !== 0) {
    throw new Error((result.stderr || result.error?.message || 'tar failed').trim())
  }
}
