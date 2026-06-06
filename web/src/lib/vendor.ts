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
  opencode: 'OpenCode',
  codex: 'Codex',
}
