package httpapi

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	qrcode "github.com/skip2/go-qrcode"

	"github.com/sequencestream/code-creative-center/license-server/internal/agreement"
	"github.com/sequencestream/code-creative-center/license-server/internal/orders"
)

// mountCheckout registers the user-facing renewal checkout (JSON; the Vue checkout
// page is served by the SPA). The agreement endpoint feeds that page the no-refund
// agreement to display before payment (§4, PL-R9).
func mountCheckout(mux *http.ServeMux, d Deps) {
	mux.HandleFunc("/v1/checkout", allowPOST(handleCheckoutCreate(d)))
	mux.HandleFunc("/v1/checkout/status", allowGET(handleCheckoutStatus(d)))
	mux.HandleFunc("/v1/agreement", allowGET(handleAgreement()))
}

// --- GET /v1/checkout/status : poll a pending order's payment state ----------

// handleCheckoutStatus lets the checkout page poll its own order after rendering
// the QR: it returns the order's current status (pending/paid/expired/failed),
// scoped to the signed-in user. The status flips to paid via the async WeChat
// callback or the reconcile job, so the page can detect payment and stop showing
// the QR without a manual refresh.
func handleCheckoutStatus(d Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		sess, ok := d.currentSession(r)
		if !ok {
			writeError(w, http.StatusUnauthorized, "unauthenticated", "sign-in required")
			return
		}
		if !d.orders.Available() {
			writeError(w, http.StatusServiceUnavailable, "unavailable", "checkout is not configured")
			return
		}
		orderNo := strings.TrimSpace(r.URL.Query().Get("orderNo"))
		if orderNo == "" {
			writeError(w, http.StatusBadRequest, "invalid_request", "orderNo is required")
			return
		}
		status, found, err := d.orders.Status(r.Context(), sess.UserID, orderNo)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "status_failed", "could not load order status")
			return
		}
		if !found {
			writeError(w, http.StatusNotFound, "not_found", "no such order")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"orderNo": orderNo, "status": status})
	}
}

// --- GET /v1/agreement : the no-refund agreement (shown at checkout) ---------

func handleAgreement() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{
			"title":    agreement.Title,
			"version":  agreement.Version,
			"markdown": agreement.Markdown,
		})
	}
}

// --- POST /v1/checkout : create a pending renewal order ----------------------

type checkoutRequest struct {
	PlanKey   string `json:"planKey"`
	LicenseID int64  `json:"licenseId"`
	Accept    bool   `json:"accept"`
}

func handleCheckoutCreate(d Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		sess, ok := d.currentSession(r)
		if !ok {
			writeError(w, http.StatusUnauthorized, "unauthenticated", "sign-in required")
			return
		}
		var body checkoutRequest
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16)).Decode(&body); err != nil {
			writeError(w, http.StatusBadRequest, "invalid_request", "malformed JSON body")
			return
		}
		// The agreement must be accepted before any charge; it is recorded on the
		// order (PL-R9). Gated before any store access so an unaccepted checkout is
		// refused outright.
		if !body.Accept {
			writeError(w, http.StatusBadRequest, "agreement_required",
				"You must accept the service agreement to continue. "+agreement.Summary)
			return
		}
		if body.PlanKey == "" {
			writeError(w, http.StatusBadRequest, "invalid_request", "planKey is required")
			return
		}
		if d.Signer == nil || !d.orders.Available() {
			writeError(w, http.StatusServiceUnavailable, "unavailable", "checkout is not configured")
			return
		}

		order, err := d.orders.CreateRenewal(r.Context(), orders.RenewalInput{
			UserID:           sess.UserID,
			LicenseID:        body.LicenseID,
			PlanKey:          body.PlanKey,
			AgreementVersion: agreement.Version,
		}, time.Now())
		if err != nil {
			switch {
			case errors.Is(err, orders.ErrLicenseNotChosen):
				writeError(w, http.StatusBadRequest, "invalid_request", "choose which license to renew")
			case errors.Is(err, orders.ErrTermCapExceeded):
				writeError(w, http.StatusBadRequest, "term_cap_exceeded",
					"this license already extends beyond one year; renew it later")
			case errors.Is(err, orders.ErrTierDowngradeBlocked):
				writeError(w, http.StatusBadRequest, "tier_downgrade_blocked",
					"your enterprise license is still active; paid plans become available after it expires")
			case errors.Is(err, orders.ErrAgreementRequired):
				writeError(w, http.StatusBadRequest, "agreement_required", agreement.Summary)
			case errors.Is(err, orders.ErrPlanUnavailable):
				writeError(w, http.StatusBadRequest, "invalid_request", "that plan is not available")
			default:
				writeError(w, http.StatusInternalServerError, "checkout_failed", "could not create your order")
			}
			return
		}

		slog.Info("checkout order created",
			"orderNo", order.OrderNo, "user", sess.UserID, "license", order.LicenseID,
			"plan", order.PlanKey, "amount", order.AmountCents, "currency", order.Currency)

		out := map[string]any{
			"orderId": order.ID,
			"orderNo": order.OrderNo,
			"status":  order.Status,
		}
		// With WeChat Pay configured, place a Native unified order and return the
		// scan-to-pay code_url for the SPA to render.
		if d.payments.Enabled() {
			codeURL, perr := d.payments.Prepay(r.Context(), order)
			if perr != nil {
				slog.Error("prepay failed", "orderNo", order.OrderNo, "err", perr)
				writeError(w, http.StatusBadGateway, "payment_unavailable",
					"your order was created but the payment QR could not be generated; please retry")
				return
			}
			slog.Info("prepay ok",
				"orderNo", order.OrderNo, "amount", order.AmountCents, "currency", order.Currency,
				"notifyURL", d.payments.NotifyURL())
			out["codeUrl"] = codeURL
			// Render the scan code to a PNG data URI server-side so the SPA needs no
			// QR dependency; the weixin:// code_url never leaves to a third-party renderer.
			if png, qerr := qrcode.Encode(codeURL, qrcode.Medium, 256); qerr == nil {
				out["qrDataUri"] = "data:image/png;base64," + base64.StdEncoding.EncodeToString(png)
			}
		}
		writeJSON(w, http.StatusOK, out)
	}
}
