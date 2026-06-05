// Embedded minisign PUBLIC key (release 3/7) — the trust anchor baked into every binary.
//
// `c3 verify` checks downloaded artifacts against THIS key (offline, no network, no external
// `minisign` binary). The matching SECRET key is held offline / as the GH Secret
// `C3_MINISIGN_SECRET_KEY` and is used only by `pnpm release:publish`. A public key is safe
// to commit. To rotate: regenerate with `node scripts/release/keygen.mjs`, replace the text
// here AND in README.md, re-publish. key id: 061223695cdd6df5
export const C3_MINISIGN_PUBLIC_KEY = `untrusted comment: c3 release signing key (minisign)
RWQGEiNpXN1t9VEX2lXZab7nHaR+gfjfPYcCYN6Bxyid5NkuQK/Gme+l
`
