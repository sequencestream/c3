// Package agreement is the single source of truth for the no-refund service
// agreement the buyer must explicitly accept before activation/login completes
// (PL-R9/PL-R10). The agreement copy and its version live here so the page shown
// to the user and the acceptance recorded on the activation request can never
// drift — policy and behavior are captured together (the task's explicit goal).
package agreement

// Version is the agreement revision recorded with each acceptance. Bump it
// whenever the Paragraphs below change so stored acceptances remain auditable.
const Version = "2026-06-16"

// Title is the heading shown above the agreement on the activation page.
const Title = "Service Agreement"

// Paragraphs is the agreement body. It states plainly that c3 is sold as a
// virtual/digital product and that the service does not support refunds
// (PL-R10). Rendered verbatim on the activation page and summarized in specs.
var Paragraphs = []string{
	"c3 is a virtual / digital product. Activation grants you a time-limited, " +
		"revocable entitlement to run the software; it is not a sale of goods and " +
		"transfers no physical item.",
	"This product does NOT support refunds. By accepting, you acknowledge that " +
		"all activations and purchases are final and that no refund — full or " +
		"partial, automated or manual — is offered for this digital product.",
	"Your entitlement may be revoked for abuse, chargeback, or violation of these " +
		"terms. Revocation stops new sessions; work already in progress is not " +
		"interrupted.",
	"You must accept this agreement to continue with GitHub sign-in and activation. " +
		"Declining cancels activation and grants no entitlement.",
}

// Summary is a one-line restatement for compact surfaces (e.g. logs, specs).
const Summary = "Virtual/digital product; no refunds supported (acceptance required before activation)."
