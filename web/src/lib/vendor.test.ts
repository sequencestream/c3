import { describe, it, expect } from 'vitest'
import { VENDOR_IDS } from '@ccc/shared/protocol'
import { VENDOR_COLOR, vendorRowTint } from './vendor'

describe('vendorRowTint', () => {
  it('derives every vendor tint from VENDOR_COLOR via a shared color-mix formula', () => {
    const tints = new Set<string>()
    for (const vendor of VENDOR_IDS) {
      const tint = vendorRowTint(vendor)
      expect(tint).toBe(`color-mix(in srgb, ${VENDOR_COLOR[vendor]} 12%, transparent)`)
      tints.add(tint)
    }
    expect(tints.size).toBe(VENDOR_IDS.length)
  })
})
