import { describe, it, expect } from 'vitest'
import { findUnknownCommand } from './cli-args.js'

describe('findUnknownCommand', () => {
  it('flags the first excess operand as an unknown command', () => {
    expect(findUnknownCommand(['up'])).toEqual({ unknown: 'up' })
    expect(findUnknownCommand(['foo'])).toEqual({ unknown: 'foo' })
    // `c3 start up` leaves `up` as an excess operand on the explicit start command.
    expect(findUnknownCommand(['up', 'extra'])).toEqual({ unknown: 'up' })
  })

  it('returns null when there are no operands (plain `c3` / option-only launch)', () => {
    expect(findUnknownCommand([])).toBeNull()
  })
})
