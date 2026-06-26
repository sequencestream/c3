/**
 * The default `start` command declares no positional arguments, so any operand
 * commander leaves in `command.args` is a token it could not route to a real
 * subcommand (e.g. `c3 up`). Treat the first such operand as the unsupported
 * command the user tried to run; an empty list means a plain `c3` / option-only
 * invocation that should launch normally.
 */
export function findUnknownCommand(operands: readonly string[]): { unknown: string } | null {
  return operands.length > 0 ? { unknown: operands[0] } : null
}
