/**
 * Deterministic paths derived from an owning workspace identity.
 */
import { join } from 'node:path'
import { c3HomeDir } from './index.js'

/**
 * Convert an absolute project path to a safe filesystem segment under c3 home.
 */
export function projectDirName(workspacePath: string): string {
  return workspacePath.replace(/^\/+/, '').replace(/[/:]/g, '-')
}

/**
 * The fixed centralized SDD spec root for an owning workspace.
 */
export function getSpecsBase(workspacePath: string): string {
  return join(c3HomeDir(), 'specs', projectDirName(workspacePath))
}
