import { describe, expect, it } from 'vitest'
import type { IntentImpactLevel, IntentSpecMode } from './protocol.js'
import { MACHINE_SPEC_APPROVER } from './protocol.js'
import {
  isHighImpactLevel,
  isHumanSpecApprover,
  isLowImpactLevel,
  machineApprovalEligible,
  resolveEffectiveSpecMode,
  specGateBlocks,
  type SpecGateFacts,
} from './intent-spec-gate-model.js'

describe('isHighImpactLevel / isLowImpactLevel', () => {
  it('L1/L2 are high impact; L4/L5 are low impact; L3 and ungraded are neither', () => {
    expect(isHighImpactLevel('L1')).toBe(true)
    expect(isHighImpactLevel('L2')).toBe(true)
    expect(isHighImpactLevel('L3')).toBe(false)
    expect(isHighImpactLevel('L4')).toBe(false)
    expect(isHighImpactLevel('L5')).toBe(false)
    expect(isHighImpactLevel(null)).toBe(false)
    expect(isHighImpactLevel(undefined)).toBe(false)

    expect(isLowImpactLevel('L4')).toBe(true)
    expect(isLowImpactLevel('L5')).toBe(true)
    expect(isLowImpactLevel('L1')).toBe(false)
    expect(isLowImpactLevel('L3')).toBe(false)
    expect(isLowImpactLevel(null)).toBe(false)
  })
})

describe('resolveEffectiveSpecMode', () => {
  it('high impact forces `sdd` even against an explicit fast and a switched-off workspace', () => {
    expect(resolveEffectiveSpecMode('fast', true, 'L1')).toBe('sdd')
    expect(resolveEffectiveSpecMode('fast', false, 'L1')).toBe('sdd')
    expect(resolveEffectiveSpecMode(null, false, 'L2')).toBe('sdd')
    expect(resolveEffectiveSpecMode('sdd', false, 'L2')).toBe('sdd')
  })

  it('low impact with no explicit mode defaults to `fast` regardless of the workspace', () => {
    expect(resolveEffectiveSpecMode(null, true, 'L4')).toBe('fast')
    expect(resolveEffectiveSpecMode(null, false, 'L4')).toBe('fast')
    expect(resolveEffectiveSpecMode(null, true, 'L5')).toBe('fast')
    expect(resolveEffectiveSpecMode(undefined, true, 'L5')).toBe('fast')
  })

  it('low impact keeps an explicit sdd / fast override', () => {
    expect(resolveEffectiveSpecMode('sdd', true, 'L4')).toBe('sdd')
    expect(resolveEffectiveSpecMode('fast', true, 'L5')).toBe('fast')
    expect(resolveEffectiveSpecMode('sdd', false, 'L4')).toBe('sdd')
  })

  it('L3 and ungraded keep the original rule: explicit wins, else inherit the workspace', () => {
    expect(resolveEffectiveSpecMode(null, true, 'L3')).toBe('sdd')
    expect(resolveEffectiveSpecMode(null, false, 'L3')).toBe('fast')
    expect(resolveEffectiveSpecMode('fast', true, 'L3')).toBe('fast')
    expect(resolveEffectiveSpecMode('sdd', false, 'L3')).toBe('sdd')

    expect(resolveEffectiveSpecMode(null, true, null)).toBe('sdd')
    expect(resolveEffectiveSpecMode(null, false, null)).toBe('fast')
    expect(resolveEffectiveSpecMode('fast', true, null)).toBe('fast')
    expect(resolveEffectiveSpecMode('sdd', false, null)).toBe('sdd')
  })
})

describe('isHumanSpecApprover', () => {
  it('a real user counts; the machine identity and null do not', () => {
    expect(isHumanSpecApprover('alice')).toBe(true)
    expect(isHumanSpecApprover(MACHINE_SPEC_APPROVER)).toBe(false)
    expect(isHumanSpecApprover(null)).toBe(false)
    expect(isHumanSpecApprover(undefined)).toBe(false)
    expect(isHumanSpecApprover('')).toBe(false)
  })
})

describe('machineApprovalEligible', () => {
  it('high impact is never eligible, whatever the opt-in', () => {
    expect(machineApprovalEligible('L1', true)).toBe(false)
    expect(machineApprovalEligible('L2', false)).toBe(false)
  })

  it('every other grade defers entirely to the opt-in', () => {
    expect(machineApprovalEligible('L3', true)).toBe(true)
    expect(machineApprovalEligible('L3', false)).toBe(false)
    expect(machineApprovalEligible('L4', true)).toBe(true)
    expect(machineApprovalEligible('L5', true)).toBe(true)
    expect(machineApprovalEligible(null, true)).toBe(true)
    expect(machineApprovalEligible(null, false)).toBe(false)
  })
})

// ── The 20-cell matrix (specMode=null, specStatus=pending) ──────────────────

interface MatrixCell {
  level: IntentImpactLevel
  sdd: boolean
  machine: boolean
  mode: IntentSpecMode
  blocked: boolean
  eligible: boolean
}

const MATRIX: MatrixCell[] = [
  // L1 — sdd / blocked / never eligible
  { level: 'L1', sdd: false, machine: false, mode: 'sdd', blocked: true, eligible: false },
  { level: 'L1', sdd: false, machine: true, mode: 'sdd', blocked: true, eligible: false },
  { level: 'L1', sdd: true, machine: false, mode: 'sdd', blocked: true, eligible: false },
  { level: 'L1', sdd: true, machine: true, mode: 'sdd', blocked: true, eligible: false },
  // L2 — same as L1
  { level: 'L2', sdd: false, machine: false, mode: 'sdd', blocked: true, eligible: false },
  { level: 'L2', sdd: false, machine: true, mode: 'sdd', blocked: true, eligible: false },
  { level: 'L2', sdd: true, machine: false, mode: 'sdd', blocked: true, eligible: false },
  { level: 'L2', sdd: true, machine: true, mode: 'sdd', blocked: true, eligible: false },
  // L3 — inherits workspace; machine eligibility follows the opt-in
  { level: 'L3', sdd: false, machine: false, mode: 'fast', blocked: false, eligible: false },
  { level: 'L3', sdd: false, machine: true, mode: 'fast', blocked: false, eligible: true },
  { level: 'L3', sdd: true, machine: false, mode: 'sdd', blocked: true, eligible: false },
  { level: 'L3', sdd: true, machine: true, mode: 'sdd', blocked: true, eligible: true },
  // L4 — default fast; machine eligibility follows the opt-in
  { level: 'L4', sdd: false, machine: false, mode: 'fast', blocked: false, eligible: false },
  { level: 'L4', sdd: false, machine: true, mode: 'fast', blocked: false, eligible: true },
  { level: 'L4', sdd: true, machine: false, mode: 'fast', blocked: false, eligible: false },
  { level: 'L4', sdd: true, machine: true, mode: 'fast', blocked: false, eligible: true },
  // L5 — same as L4
  { level: 'L5', sdd: false, machine: false, mode: 'fast', blocked: false, eligible: false },
  { level: 'L5', sdd: false, machine: true, mode: 'fast', blocked: false, eligible: true },
  { level: 'L5', sdd: true, machine: false, mode: 'fast', blocked: false, eligible: false },
  { level: 'L5', sdd: true, machine: true, mode: 'fast', blocked: false, eligible: true },
]

describe('impact-level × spec-gate matrix (specMode=null, specStatus=pending)', () => {
  it.each(MATRIX.map((c) => [c.level, c.sdd, c.machine] as const))(
    'L%s sdd=%s machine=%s → mode=%s / blocked=%s / eligible=%s',
    (level, sdd, machine) => {
      const cell = MATRIX.find((c) => c.level === level && c.sdd === sdd && c.machine === machine)!
      const mode = resolveEffectiveSpecMode(null, sdd, level)
      expect(mode).toBe(cell.mode)

      const facts: SpecGateFacts = {
        impactLevel: level,
        effectiveSpecMode: mode,
        sddEnabled: sdd,
        specStatus: 'pending',
        specApproveUser: null,
      }
      expect(specGateBlocks(facts)).toBe(cell.blocked)
      expect(machineApprovalEligible(level, machine)).toBe(cell.eligible)
    },
  )
})

// ── Approval-state combinations ─────────────────────────────────────────────

describe('specGateBlocks across approval states', () => {
  const gate = (partial: Partial<SpecGateFacts>): boolean =>
    specGateBlocks({
      impactLevel: null,
      effectiveSpecMode: 'sdd',
      sddEnabled: true,
      specStatus: 'pending',
      specApproveUser: null,
      ...partial,
    })

  it('high impact requires an approved AND human-approved spec', () => {
    const high = { impactLevel: 'L1' as const, effectiveSpecMode: 'sdd' as const, sddEnabled: true }
    expect(gate({ ...high, specStatus: 'raw' })).toBe(true)
    expect(gate({ ...high, specStatus: 'pending' })).toBe(true)
    // machine approval is NOT enough
    expect(gate({ ...high, specStatus: 'approved', specApproveUser: MACHINE_SPEC_APPROVER })).toBe(
      true,
    )
    // missing approver identity is NOT enough
    expect(gate({ ...high, specStatus: 'approved', specApproveUser: null })).toBe(true)
    // a human approval admits
    expect(gate({ ...high, specStatus: 'approved', specApproveUser: 'alice' })).toBe(false)
  })

  it('high impact stays blocked with SDD switched off (cannot dodge the checkpoint)', () => {
    expect(
      gate({
        impactLevel: 'L2',
        effectiveSpecMode: 'sdd',
        sddEnabled: false,
        specStatus: 'pending',
      }),
    ).toBe(true)
    expect(
      gate({
        impactLevel: 'L2',
        effectiveSpecMode: 'sdd',
        sddEnabled: false,
        specStatus: 'approved',
        specApproveUser: 'alice',
      }),
    ).toBe(false)
  })

  it('non-high-impact sdd blocks until approved, only when SDD is on', () => {
    expect(gate({ impactLevel: 'L3', specStatus: 'raw' })).toBe(true)
    expect(gate({ impactLevel: 'L3', specStatus: 'pending' })).toBe(true)
    expect(gate({ impactLevel: 'L3', specStatus: 'approved', specApproveUser: 'alice' })).toBe(
      false,
    )
    expect(
      gate({ impactLevel: 'L3', specStatus: 'approved', specApproveUser: MACHINE_SPEC_APPROVER }),
    ).toBe(false)
    // explicit sdd but workspace SDD off → no spec gate
    expect(gate({ impactLevel: 'L3', sddEnabled: false, specStatus: 'pending' })).toBe(false)
  })

  it('fast never blocks, whatever the status', () => {
    expect(gate({ effectiveSpecMode: 'fast', specStatus: 'raw' })).toBe(false)
    expect(gate({ effectiveSpecMode: 'fast', specStatus: 'pending' })).toBe(false)
    expect(gate({ effectiveSpecMode: 'fast', specStatus: 'approved' })).toBe(false)
  })

  it('L4/L5 explicit sdd: blocks raw/pending under SDD on, admits once approved', () => {
    const explicitSdd = { impactLevel: 'L4' as const, effectiveSpecMode: 'sdd' as const }
    expect(gate({ ...explicitSdd, sddEnabled: true, specStatus: 'raw' })).toBe(true)
    expect(gate({ ...explicitSdd, sddEnabled: true, specStatus: 'pending' })).toBe(true)
    expect(
      gate({ ...explicitSdd, sddEnabled: true, specStatus: 'approved', specApproveUser: 'alice' }),
    ).toBe(false)
    expect(
      gate({
        ...explicitSdd,
        sddEnabled: true,
        specStatus: 'approved',
        specApproveUser: MACHINE_SPEC_APPROVER,
      }),
    ).toBe(false)
    // explicit sdd under SDD off → effective mode stays sdd, but the gate does not hold
    expect(gate({ ...explicitSdd, sddEnabled: false, specStatus: 'pending' })).toBe(false)
  })
})
