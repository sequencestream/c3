package httpapi

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	qrcode "github.com/skip2/go-qrcode"

	"github.com/sequencestream/code-creative-center/license-server/internal/agreement"
	"github.com/sequencestream/code-creative-center/license-server/internal/config"
	"github.com/sequencestream/code-creative-center/license-server/internal/store"
	"github.com/sequencestream/code-creative-center/license-server/internal/wechatpay"
)

// mountCheckout registers the user-facing renewal checkout (JSON; the Vue
// checkout page is served by the SPA). The agreement endpoint feeds that page
// the no-refund agreement to display before payment (§4, PL-R9).
func mountCheckout(mux *http.ServeMux, d Deps) {
	mux.HandleFunc("/v1/checkout", allowPOST(handleCheckoutCreate(d)))
	mux.HandleFunc("/v1/agreement", allowGET(handleAgreement()))
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
		if d.Signer == nil || !d.Store.Available() {
			writeError(w, http.StatusServiceUnavailable, "unavailable", "checkout is not configured")
			return
		}

		// The renewal target must be a license the signed-in user owns, and its
		// term must not already extend beyond the 1-year cap (§11).
		licenses, err := d.Store.LicenseBindingsByUser(r.Context(), sess.UserID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "checkout_failed", "could not load your licenses")
			return
		}
		target, ok := findLicense(licenses, body.LicenseID)
		if !ok {
			writeError(w, http.StatusBadRequest, "invalid_request", "choose which license to renew")
			return
		}
		now := time.Now()
		if target.TermEnd.After(now.AddDate(0, config.MaxLicenseTermAheadMonths, 0)) {
			writeError(w, http.StatusBadRequest, "term_cap_exceeded",
				"this license already extends beyond one year; renew it later")
			return
		}

		order, err := d.Store.CreateOrder(r.Context(), store.CreateOrderInput{
			UserID:              sess.UserID,
			LicenseID:           body.LicenseID,
			PlanKey:             body.PlanKey,
			AgreementVersion:    agreement.Version,
			AgreementAcceptedAt: now,
		}, func() string { return store.NewOrderNo(time.Now()) })
		if err != nil {
			switch {
			case errors.Is(err, store.ErrAgreementRequired):
				writeError(w, http.StatusBadRequest, "agreement_required", agreement.Summary)
			case errors.Is(err, store.ErrNotFound):
				writeError(w, http.StatusBadRequest, "invalid_request", "that plan is not available")
			default:
				writeError(w, http.StatusInternalServerError, "checkout_failed", "could not create your order")
			}
			return
		}

		out := map[string]any{
			"orderId": order.ID,
			"orderNo": order.OrderNo,
			"status":  order.Status,
		}
		// With WeChat Pay configured, place a Native unified order (out_trade_no =
		// order_no) and return the scan-to-pay code_url for the SPA to render.
		if d.Pay != nil {
			res, perr := d.Pay.Prepay(r.Context(), wechatpay.PrepayInput{
				OutTradeNo:  order.OrderNo,
				AmountCents: order.AmountCents,
				Description: "c3 license renewal · " + order.PlanKey,
				NotifyURL:   strings.TrimRight(d.Config.ExternalBaseURL(), "/") + "/v1/payment/wechat/notify",
			})
			if perr != nil {
				writeError(w, http.StatusBadGateway, "payment_unavailable",
					"your order was created but the payment QR could not be generated; please retry")
				return
			}
			out["codeUrl"] = res.CodeURL
			// Render the scan code to a PNG data URI server-side so the SPA needs no
			// QR dependency; the weixin:// code_url never leaves to a third-party renderer.
			if png, qerr := qrcode.Encode(res.CodeURL, qrcode.Medium, 256); qerr == nil {
				out["qrDataUri"] = "data:image/png;base64," + base64.StdEncoding.EncodeToString(png)
			}
		}
		writeJSON(w, http.StatusOK, out)
	}
}

// findLicense returns the user's license with licenseID, if present.
func findLicense(ls []store.LicenseBinding, licenseID int64) (store.LicenseBinding, bool) {
	for _, l := range ls {
		if l.ID == licenseID {
			return l, true
		}
	}
	return store.LicenseBinding{}, false
}
