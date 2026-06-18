package httpapi

import (
	"net/http"

	"github.com/sequencestream/code-creative-center/license-server/internal/orders"
)

// mountAccount registers the user self-service data endpoints (JSON; the Vue
// account page is served by the SPA). Both are scoped to the signed-in user and
// never expose the alive token or the entitlement token (PL-R2).
func mountAccount(mux *http.ServeMux, d Deps) {
	mux.HandleFunc("/v1/licenses", allowGET(handleLicenses(d)))
	mux.HandleFunc("/v1/orders", allowGET(handleOrders(d)))
}

// --- GET /v1/licenses : the signed-in user's licenses + binding info --------

func handleLicenses(d Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		sess, ok := d.currentSession(r)
		if !ok {
			writeError(w, http.StatusUnauthorized, "unauthenticated", "sign-in required")
			return
		}
		if !d.Store.Available() {
			writeError(w, http.StatusServiceUnavailable, "unavailable", "license database is not configured")
			return
		}
		licenses, err := d.licenses.ListBindings(r.Context(), sess.UserID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "account_failed", "could not load your licenses")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"licenses": licenseViews(licenses)})
	}
}

// --- GET /v1/orders : the signed-in user's paid orders ----------------------

func handleOrders(d Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		sess, ok := d.currentSession(r)
		if !ok {
			writeError(w, http.StatusUnauthorized, "unauthenticated", "sign-in required")
			return
		}
		if !d.Store.Available() {
			writeError(w, http.StatusServiceUnavailable, "unavailable", "license database is not configured")
			return
		}
		paid, err := d.orders.ListPaid(r.Context(), sess.UserID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "account_failed", "could not load your orders")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"orders": orderViews(paid)})
	}
}

// orderViews projects paid orders to the JSON the account page renders.
func orderViews(os []orders.Order) []map[string]any {
	out := make([]map[string]any, len(os))
	for i, o := range os {
		out[i] = map[string]any{
			"orderId":     o.ID,
			"orderNo":     o.OrderNo,
			"planKey":     o.PlanKey,
			"amountCents": o.AmountCents,
			"currency":    o.Currency,
			"status":      o.Status,
			"paymentRef":  o.PaymentRef,
			"createdAt":   o.CreatedAt.Unix(),
		}
	}
	return out
}
