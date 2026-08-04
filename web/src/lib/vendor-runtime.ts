/**
 * 「这个 vendor 现在能不能跑」的客户端唯一判定来源。
 *
 * 服务端把每个 vendor 的运行时可用性统一说成 `VendorRuntimeStatus`(宿主 CLI 与
 * 进程内 SDK 同一套词汇),前端所有门控——agent 配置的 vendor 下拉、新建会话弹窗、
 * 自动化表单——都只读这里派生出的结果,因此没有任何一处需要写
 * `if (vendor === 'cursor')`:新增 vendor 时服务端多答一项即可,前端不动。
 */
import { VENDOR_IDS } from '@ccc/shared/protocol'
import type {
  VendorHostStatus,
  VendorId,
  VendorRuntimeOrigin,
  VendorRuntimeStatus,
  VendorUnavailableReason,
} from '@ccc/shared/protocol'
import type { LocaleKey } from '@/i18n'

/** 一个 vendor 的可用性判定结果(含用于诊断展示的运行时类型与标识)。 */
export type VendorAvailability = VendorRuntimeStatus

/**
 * 由 `settings` 回包派生出全量 vendor 的可用性。
 *
 * `vendorRuntime` 缺失意味着对端是不认识该字段的旧服务端,此时按可证实的信息降级:
 * 出现在 `hostStatus` 里的 vendor 仍按宿主 CLI 探测结果判定(语义与旧版完全一致),
 * 其余 vendor 一律判为不可用——宁可挡住一条其实可用的路径,也不放行一条必然失败的
 * 路径。这条回落规则本身也不点名任何 vendor。
 */
export function deriveVendorAvailability(
  vendorRuntime: Partial<Record<VendorId, VendorRuntimeStatus>> | undefined,
  hostStatus: readonly VendorHostStatus[],
): Record<VendorId, VendorAvailability> {
  const byVendor = new Map(hostStatus.map((h) => [h.vendor, h]))
  const out = {} as Record<VendorId, VendorAvailability>
  for (const vendor of VENDOR_IDS) {
    const fromServer = vendorRuntime?.[vendor]
    if (fromServer) {
      out[vendor] = fromServer
      continue
    }
    const host = byVendor.get(vendor)
    out[vendor] = host
      ? {
          vendor,
          available: host.present,
          runtime: 'host-cli',
          runtimeId: host.binary,
          ...(host.present ? {} : { reason: 'host-cli-missing' as const }),
        }
      : { vendor, available: false, runtime: 'embedded-sdk', reason: 'sdk-unresolved' }
  }
  return out
}

/**
 * 稳定原因码 → i18n key。服务端只发码不发文案,可行动说明由前端本地化,这样
 * 服务端内部的异常文本永远不会变成 UI 契约的一部分。
 */
export const VENDOR_UNAVAILABLE_REASON_KEY = {
  'host-cli-missing': 'common.vendor.unavailable.hostCliMissing',
  'sdk-unresolved': 'common.vendor.unavailable.sdkUnresolved',
} as const satisfies Record<VendorUnavailableReason, LocaleKey>

/** 取不可用原因的 i18n key;可用(或无原因码)时返回 null,调用方不渲染说明。 */
export function vendorUnavailableReasonKey(
  status: VendorAvailability | undefined,
): LocaleKey | null {
  if (!status || status.available || !status.reason) return null
  return VENDOR_UNAVAILABLE_REASON_KEY[status.reason]
}

/**
 * 解析来源码 → i18n key。与原因码同一套约定:服务端只说来源是哪一类,"从哪装的"
 * 这句话由前端本地化。
 */
export const VENDOR_RUNTIME_ORIGIN_KEY = {
  installed: 'common.vendor.origin.installed',
  sidecar: 'common.vendor.origin.sidecar',
  override: 'common.vendor.origin.override',
} as const satisfies Record<VendorRuntimeOrigin, LocaleKey>

/** 取解析来源的 i18n key;不可用或未给出来源时返回 null,调用方不渲染该列。 */
export function vendorRuntimeOriginKey(status: VendorAvailability | undefined): LocaleKey | null {
  if (!status || !status.available || !status.origin) return null
  return VENDOR_RUNTIME_ORIGIN_KEY[status.origin]
}
