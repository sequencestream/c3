import type { LicensePlan, LicenseStatus } from '@ccc/shared/protocol'
import type { UiError } from '@ccc/shared/ui-codes'

export const FREE_PLAN_LIMITS = {
  workspaces: 5,
  activeWorktrees: 2,
  discussionParticipants: 2,
  enabledSchedules: 5,
  sandboxEnabled: false,
} as const

export interface PlanLimits {
  workspaces: number | null
  activeWorktrees: number | null
  discussionParticipants: number | null
  enabledSchedules: number | null
  sandboxEnabled: boolean
}

function normalizePlan(plan: LicensePlan | string | undefined): LicensePlan {
  return plan === 'free' || plan === 'enterprise' || plan === 'paid' ? plan : 'paid'
}

export function limitsForPlan(plan: LicensePlan | string | undefined): PlanLimits {
  return normalizePlan(plan) === 'free'
    ? {
        workspaces: FREE_PLAN_LIMITS.workspaces,
        activeWorktrees: FREE_PLAN_LIMITS.activeWorktrees,
        discussionParticipants: FREE_PLAN_LIMITS.discussionParticipants,
        enabledSchedules: FREE_PLAN_LIMITS.enabledSchedules,
        sandboxEnabled: false,
      }
    : {
        workspaces: null,
        activeWorktrees: null,
        discussionParticipants: null,
        enabledSchedules: null,
        sandboxEnabled: true,
      }
}

export function currentPlanLimits(license: LicenseStatus): PlanLimits {
  return license.entitled ? limitsForPlan(license.plan) : limitsForPlan('paid')
}

export function limitError(code: UiError['code'], limit?: number): UiError {
  return limit === undefined ? { code } : { code, params: { limit } }
}
