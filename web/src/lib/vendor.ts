import type { VendorId } from '@ccc/shared/protocol'

/**
 * Vendor brand labels shown verbatim wherever a vendor is surfaced — a discussion
 * speaker's vendor tag, the consensus vendor-scope note, the degradation
 * cross-vendor-skip note. Brand names are do-not-translate (i18n-terms), so they
 * live as a const map (which also keeps `no-raw-text` from flagging them as
 * hard-coded copy) rather than in the i18n catalog.
 */
export const VENDOR_LABEL: Record<VendorId, string> = {
  claude: 'Claude',
  codex: 'Codex',
  cursor: 'Cursor',
}

/**
 * A small brand-ish colour per vendor, used for the vendor "dot" beside a session
 * title and in the new-session agent picker. Not part of the design-token palette
 * (vendor identity is orthogonal to theme), so it lives here next to
 * {@link VENDOR_LABEL} rather than in the CSS variables.
 */
export const VENDOR_COLOR: Record<VendorId, string> = {
  claude: '#d97757',
  codex: '#a855f7',
  cursor: '#3b82f6',
}

/** Share of {@link VENDOR_COLOR} in the settings agent-row background tint. */
const VENDOR_ROW_TINT_PCT = 12

/**
 * Light row background derived from {@link VENDOR_COLOR} for the settings Agent
 * config list. Same formula for every vendor — only the brand colour changes —
 * so rows stay readable while remaining scannable by vendor.
 */
export function vendorRowTint(vendor: VendorId): string {
  return `color-mix(in srgb, ${VENDOR_COLOR[vendor]} ${VENDOR_ROW_TINT_PCT}%, transparent)`
}
