package httpapi

import (
	"errors"
	"io"
	"net/http"
	"time"

	"github.com/sequencestream/code-creative-center/license-server/internal/store"
)

// maxNotifyBody bounds the callback body we read — a WeChat Pay notification is
// a few hundred bytes; a larger body is rejected rather than buffered.
const maxNotifyBody = 1 << 20

// mountPayment registers the WeChat Pay asynchronous result callback. WeChat
// POSTs the (signed, encrypted) payment outcome here; the handler verifies it,
// advances the order state machine, and acknowledges with WeChat's expected
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

// handleWechatNotify verifies a WeChat Pay callback and applies it to the order.
//
// The signature/decrypt check is the security boundary: a forged or tampered
// "payment success" never decrypts with our APIv3 key and is refused, so no
// order is advanced (PL-R12). A verified SUCCESS marks the order paid and
// extends the license; any other trade state marks it failed. Processing is
// idempotent — WeChat redelivers until it gets a 200, and a replay of an
// already-paid order acknowledges without side effects.
func handleWechatNotify(d Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if d.Pay == nil || !d.Store.Available() {
			writeNotifyAck(w, http.StatusServiceUnavailable, false, "payment is not configured")
			return
		}
		body, err := io.ReadAll(io.LimitReader(r.Body, maxNotifyBody))
		if err != nil {
			writeNotifyAck(w, http.StatusBadRequest, false, "could not read body")
			return
		}

		notif, err := d.Pay.ParseNotify(r.Header.Get, body)
		if err != nil {
			// A bad signature / undecryptable body is forged or tampered: refuse.
			writeNotifyAck(w, http.StatusUnauthorized, false, "signature verification failed")
			return
		}
		if notif.OutTradeNo == "" {
			writeNotifyAck(w, http.StatusBadRequest, false, "missing out_trade_no")
			return
		}

		// out_trade_no is the order_no. A success on an already-expired/paid order
		// is idempotently ignored by the store (it never re-extends a license, §11).
		if notif.Paid() {
			if _, _, err := d.Store.MarkOrderPaid(r.Context(), notif.OutTradeNo, notif.TransactionID, time.Now()); err != nil {
				ackStoreError(w, err)
				return
			}
		} else {
			if _, _, err := d.Store.MarkOrderFailed(r.Context(), notif.OutTradeNo, notif.TransactionID); err != nil {
				ackStoreError(w, err)
				return
			}
		}
		writeNotifyAck(w, http.StatusOK, true, "成功")
	}
}

// ackStoreError maps a store failure to a callback acknowledgement. An unknown
// order is a 4xx FAIL (an anomaly worth surfacing in WeChat's retry log); any
// other error is a 5xx FAIL so WeChat retries after the transient fault clears.
func ackStoreError(w http.ResponseWriter, err error) {
	if errors.Is(err, store.ErrNotFound) {
		writeNotifyAck(w, http.StatusNotFound, false, "order not found")
		return
	}
	writeNotifyAck(w, http.StatusInternalServerError, false, "could not record payment")
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
