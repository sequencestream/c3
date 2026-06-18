package httpapi

import (
	"errors"
	"io"
	"log/slog"
	"net/http"

	"github.com/sequencestream/code-creative-center/license-server/internal/orders"
	"github.com/sequencestream/code-creative-center/license-server/internal/payments"
)

// maxNotifyBody bounds the callback body we read — a WeChat Pay notification is a
// few hundred bytes; a larger body is rejected rather than buffered.
const maxNotifyBody = 1 << 20

// mountPayment registers the WeChat Pay asynchronous result callback. WeChat POSTs
// the (signed, encrypted) payment outcome here; the handler hands it to the
// payment service to verify and settle, then acknowledges with WeChat's expected
// SUCCESS/FAIL envelope.
func mountPayment(mux *http.ServeMux, d Deps) {
	mux.HandleFunc("/v1/payment/wechat/notify", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", http.MethodPost)
			writeNotifyAck(w, http.StatusMethodNotAllowed, false, "only POST is allowed")
			return
		}
		handleWechatNotify(d)(w, r)
	})
}

// handleWechatNotify reads the callback body and delegates verification + order
// settlement to the payment service, then maps the outcome to WeChat's expected
// acknowledgement. The signature/decrypt check (in the service) is the security
// boundary: a forged or tampered "payment success" is refused and no order is
// advanced (PL-R12). Processing is idempotent — WeChat redelivers until it gets a
// 200, and a replay of an already-settled order acknowledges without side effects.
func handleWechatNotify(d Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !d.payments.Ready() {
			writeNotifyAck(w, http.StatusServiceUnavailable, false, "payment is not configured")
			return
		}
		body, err := io.ReadAll(io.LimitReader(r.Body, maxNotifyBody))
		if err != nil {
			slog.Error("wechat callback read body failed", "err", err)
			writeNotifyAck(w, http.StatusBadRequest, false, "could not read body")
			return
		}
		// Receipt log: body length only — the raw envelope carries signature material
		// and an encrypted resource that must never be logged (PL-R12).
		slog.Info("wechat callback received", "bytes", len(body))

		res, err := d.payments.ProcessNotify(r.Context(), r.Header.Get, body)
		if err != nil {
			switch {
			case errors.Is(err, payments.ErrVerify):
				// A bad signature / undecryptable body is forged or tampered: refuse.
				slog.Warn("wechat callback rejected (verify/decrypt failed)", "err", err)
				writeNotifyAck(w, http.StatusUnauthorized, false, "signature verification failed")
			case errors.Is(err, payments.ErrMissingTradeNo):
				slog.Warn("wechat callback missing out_trade_no")
				writeNotifyAck(w, http.StatusBadRequest, false, "missing out_trade_no")
			case errors.Is(err, orders.ErrNotFound):
				slog.Warn("order not found for callback")
				writeNotifyAck(w, http.StatusNotFound, false, "order not found")
			default:
				slog.Error("callback processing failed", "err", err)
				writeNotifyAck(w, http.StatusInternalServerError, false, "could not record payment")
			}
			return
		}

		slog.Info("wechat callback verified",
			"orderNo", res.OutTradeNo, "tradeState", res.TradeState, "txid", res.TransactionID, "amount", res.AmountCents)
		switch {
		case res.Paid && res.Advanced:
			slog.Info("order settled paid via callback; license extended", "orderNo", res.OutTradeNo, "txid", res.TransactionID)
		case !res.Paid && res.Advanced:
			slog.Info("order marked failed via callback", "orderNo", res.OutTradeNo, "tradeState", res.TradeState)
		default:
			slog.Info("callback ignored, already settled (idempotent)", "orderNo", res.OutTradeNo, "status", res.Order.Status)
		}
		writeNotifyAck(w, http.StatusOK, true, "成功")
	}
}

// writeNotifyAck writes WeChat Pay's expected callback acknowledgement: a JSON
// envelope with a SUCCESS/FAIL code at the matching HTTP status. WeChat treats a
// non-200 (or a FAIL code) as a failed delivery and retries.
func writeNotifyAck(w http.ResponseWriter, status int, ok bool, message string) {
	code := "FAIL"
	if ok {
		code = "SUCCESS"
	}
	writeJSON(w, status, map[string]string{"code": code, "message": message})
}
