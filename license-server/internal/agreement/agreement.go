// Package agreement is the single source of truth for the service-usage
// authorization agreement the user must explicitly accept before
// activation/login completes (PL-R9/PL-R10). The agreement copy lives in the
// embedded agreement.md and its version lives here, so the page shown to the
// user and the acceptance recorded on the activation request can never drift —
// policy and behavior are captured together (the task's explicit goal).
package agreement

import _ "embed"

// Version is the agreement revision recorded with each acceptance. Bump it
// whenever agreement.md changes so stored acceptances remain auditable.
const Version = "2026-06-17"

// Title is the heading shown above the agreement on the activation page and used
// as the browser tab title. It mirrors the top-level heading in agreement.md.
const Title = "c3 软件使用授权与服务协议"

// Markdown is the full agreement body, embedded from agreement.md so the copy is
// edited as a document (Chinese) yet shipped inside the single binary. The
// activation page renders it; specs summarize it.
//
//go:embed agreement.md
var Markdown string

// Summary is a one-line restatement for compact surfaces (e.g. the
// agreement-required error and specs).
const Summary = "本软件为虚拟数字产品，一经激活不支持退款；激活前须同意本协议。"
