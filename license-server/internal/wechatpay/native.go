// native.go is the concrete [Gateway] adapter over WeChat Pay **Native**.
//
// It delegates prepay to the vendored vwechatpay library's NativeClient
// (vwxpayments/vwxnative) — the library now provides first-class Native support.
// For callback parsing it keeps its own verify seam (see parseNotify) so the
// signature check is injectable and the full path is exercisable offline without
// reaching WeChat's platform-certificate download endpoint.
package wechatpay

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	vwechatpay "github.com/vogo/vwechatpay"
	"github.com/vogo/vwechatpay/vwxpayments/vwxnative"
	"github.com/wechatpay-apiv3/wechatpay-go/services/payments"
	"github.com/wechatpay-apiv3/wechatpay-go/utils"
)

// Settings are the resolved WeChat Pay APIv3 credentials. PrivateKeyB64 / CertB64
// are base64-encoded PEM so a multi-line key/cert survives an environment
// variable. All values live only in this layer (PL-R12).
type Settings struct {
	MerchantID    string
	AppID         string
	CertSerialNo  string
	APIv3Key      string
	PrivateKeyB64 string
	CertB64       string
}

// configured reports whether every credential needed to build a client is set.
func (s Settings) configured() bool {
	return strings.TrimSpace(s.MerchantID) != "" &&
		strings.TrimSpace(s.AppID) != "" &&
		strings.TrimSpace(s.CertSerialNo) != "" &&
		strings.TrimSpace(s.APIv3Key) != "" &&
		strings.TrimSpace(s.PrivateKeyB64) != "" &&
		strings.TrimSpace(s.CertB64) != ""
}

// prepayExpiry bounds how long a Native QR stays payable.
const prepayExpiry = 15 * time.Minute

// verifierFunc verifies a callback's signature against the platform certificate.
// It is a field on the adapter so tests can substitute a stub instead of
// reaching WeChat to download platform certificates.
type verifierFunc func(ctx context.Context, headerFetcher func(string) string, body []byte) error

// nowFunc returns the current time; a field so the expiry stamp is deterministic
// in tests.
type nowFunc func() time.Time

// nativeGateway is the concrete [Gateway] over WeChat Pay Native, backed by the
// vendored library's NativeClient.
type nativeGateway struct {
	mgr      *vwechatpay.Manager
	native   *vwxnative.NativeClient
	appID    string
	mchID    string
	apiV3Key string
	verify   verifierFunc
	now      nowFunc
}

// New builds a Native gateway, or (nil, nil) when WeChat Pay is not configured —
// the renewal checkout then degrades to "payment unavailable" rather than
// failing. A present-but-invalid credential set is a hard error.
func New(s Settings) (Gateway, error) {
	if !s.configured() {
		return nil, nil
	}
	privPEM, err := base64.StdEncoding.DecodeString(s.PrivateKeyB64)
	if err != nil {
		return nil, fmt.Errorf("wechatpay: decode private key: %w", err)
	}
	certPEM, err := base64.StdEncoding.DecodeString(s.CertB64)
	if err != nil {
		return nil, fmt.Errorf("wechatpay: decode cert: %w", err)
	}
	// vwechatpay.Config base64-decodes PrivateKeyContent/CertContent itself before
	// parsing, so hand it the re-encoded PEM bytes.
	mgr, err := vwechatpay.NewManager(&vwechatpay.Config{
		MerchantID:           s.MerchantID,
		MerchantCertSerialNO: s.CertSerialNo,
		MerchantAPIv3Key:     s.APIv3Key,
		PrivateKeyContent:    base64.StdEncoding.EncodeToString(privPEM),
		CertContent:          base64.StdEncoding.EncodeToString(certPEM),
		AppID:                s.AppID,
	})
	if err != nil {
		return nil, fmt.Errorf("wechatpay: build manager: %w", err)
	}
	return &nativeGateway{
		mgr:      mgr,
		native:   vwxnative.NewNativeClient(mgr),
		appID:    s.AppID,
		mchID:    s.MerchantID,
		apiV3Key: s.APIv3Key,
		verify:   mgr.PlatManager.VerifyRequestMessage,
		now:      time.Now,
	}, nil
}

// Prepay places a Native unified order and returns the scan URL. Delegates to
// the vendored library's NativeClient.
func (g *nativeGateway) Prepay(ctx context.Context, in PrepayInput) (PrepayResult, error) {
	res, err := g.native.Prepay(
		ctx,
		g.appID,
		int64(in.AmountCents),
		in.OutTradeNo,
		in.Description,
		"", // attach — unused in MVP
		in.NotifyURL,
		g.now().Add(prepayExpiry),
	)
	if err != nil {
		return PrepayResult{}, fmt.Errorf("wechatpay: native prepay: %w", err)
	}
	if res == nil || res.CodeURL == nil || *res.CodeURL == "" {
		return PrepayResult{}, fmt.Errorf("wechatpay: native prepay returned no code_url")
	}
	return PrepayResult{CodeURL: *res.CodeURL}, nil
}

// ParseNotify verifies the callback signature against the WeChat platform
// certificate, decrypts the APIv3-encrypted resource, and returns the payment
// result. A bad signature, an expired timestamp, or a payload that does not
// decrypt with our APIv3 key yields [ErrSignatureInvalid] — a forged "payment
// success" can never pass (the security boundary for renewal, PL-R12).
func (g *nativeGateway) ParseNotify(headerFetcher func(string) string, body []byte) (NotifyResult, error) {
	if err := g.verify(context.Background(), headerFetcher, body); err != nil {
		return NotifyResult{}, fmt.Errorf("%w: %v", ErrSignatureInvalid, err)
	}
	var envelope struct {
		Resource struct {
			Ciphertext     string `json:"ciphertext"`
			Nonce          string `json:"nonce"`
			AssociatedData string `json:"associated_data"`
		} `json:"resource"`
	}
	if err := json.Unmarshal(body, &envelope); err != nil {
		return NotifyResult{}, fmt.Errorf("%w: decode envelope: %v", ErrSignatureInvalid, err)
	}
	plaintext, err := utils.DecryptAES256GCM(
		g.apiV3Key,
		envelope.Resource.AssociatedData,
		envelope.Resource.Nonce,
		envelope.Resource.Ciphertext,
	)
	if err != nil {
		return NotifyResult{}, fmt.Errorf("%w: decrypt resource: %v", ErrSignatureInvalid, err)
	}
	var tx struct {
		OutTradeNo    string `json:"out_trade_no"`
		TransactionID string `json:"transaction_id"`
		TradeState    string `json:"trade_state"`
		Amount        struct {
			Total int `json:"total"`
		} `json:"amount"`
	}
	if err := json.Unmarshal([]byte(plaintext), &tx); err != nil {
		return NotifyResult{}, fmt.Errorf("%w: decode resource: %v", ErrSignatureInvalid, err)
	}
	if tx.OutTradeNo == "" {
		return NotifyResult{}, fmt.Errorf("%w: resource carries no out_trade_no", ErrSignatureInvalid)
	}
	return NotifyResult{
		OutTradeNo:    tx.OutTradeNo,
		TransactionID: tx.TransactionID,
		TradeState:    tx.TradeState,
		AmountCents:   tx.Amount.Total,
	}, nil
}

// QueryByOutTradeNo asks WeChat for the authoritative state of an order by its
// merchant order number (our order_no). Used by the reconcile job to settle
// pending orders whose async callback was missed (§11).
func (g *nativeGateway) QueryByOutTradeNo(ctx context.Context, outTradeNo string) (NotifyResult, error) {
	tx, err := g.native.QueryOrderByOutTradeNo(ctx, outTradeNo)
	if err != nil {
		return NotifyResult{}, fmt.Errorf("wechatpay: query order %s: %w", outTradeNo, err)
	}
	if tx == nil {
		return NotifyResult{}, fmt.Errorf("wechatpay: query order %s returned no transaction", outTradeNo)
	}
	return transactionToNotify(tx), nil
}

// transactionToNotify projects a WeChat payments.Transaction (query response)
// onto the vendor-neutral NotifyResult the order state machine consumes.
func transactionToNotify(tx *payments.Transaction) NotifyResult {
	out := NotifyResult{}
	if tx.OutTradeNo != nil {
		out.OutTradeNo = *tx.OutTradeNo
	}
	if tx.TransactionId != nil {
		out.TransactionID = *tx.TransactionId
	}
	if tx.TradeState != nil {
		out.TradeState = *tx.TradeState
	}
	if tx.Amount != nil && tx.Amount.Total != nil {
		out.AmountCents = int(*tx.Amount.Total)
	}
	return out
}
