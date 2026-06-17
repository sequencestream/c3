// native.go is the concrete [Gateway] adapter over WeChat Pay **Native**.
//
// The vendored github.com/vogo/vwechatpay wrapper exposes a JSAPI client (which
// requires a per-user openid, unsuitable for PC web) but no Native client, so
// this adapter builds a thin Native service on top of the wrapper's
// already-constructed *core.Client — the underlying wechatpay-go SDK supports
// Native. It reuses the wrapper's PlatManager for callback signature
// verification and the SDK's APIv3-key AES-GCM helper for callback decryption.
package wechatpay

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/vogo/vwechatpay"
	"github.com/wechatpay-apiv3/wechatpay-go/core"
	"github.com/wechatpay-apiv3/wechatpay-go/services/payments/native"
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

// orderExpiry bounds how long a Native QR stays payable.
const orderExpiry = 15 * time.Minute

// verifierFunc verifies a callback's signature against the platform certificate.
// It is a field on the adapter so tests can substitute a stub instead of
// reaching WeChat to download platform certificates.
type verifierFunc func(ctx context.Context, headerFetcher func(string) string, body []byte) error

// nowFunc returns the current time; a field so the expiry stamp is deterministic
// in tests.
type nowFunc func() time.Time

// nativeGateway is the concrete [Gateway] over WeChat Pay Native.
type nativeGateway struct {
	mgr      *vwechatpay.Manager
	native   *native.NativeApiService
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
		native:   &native.NativeApiService{Client: mgr.Client},
		appID:    s.AppID,
		mchID:    s.MerchantID,
		apiV3Key: s.APIv3Key,
		verify:   mgr.PlatManager.VerifyRequestMessage,
		now:      time.Now,
	}, nil
}

// Prepay places a Native unified order and returns the scan URL.
func (g *nativeGateway) Prepay(ctx context.Context, in PrepayInput) (PrepayResult, error) {
	resp, _, err := g.native.Prepay(ctx, native.PrepayRequest{
		Appid:       core.String(g.appID),
		Mchid:       core.String(g.mchID),
		Description: core.String(in.Description),
		OutTradeNo:  core.String(in.OutTradeNo),
		NotifyUrl:   core.String(in.NotifyURL),
		TimeExpire:  core.Time(g.now().Add(orderExpiry)),
		Amount: &native.Amount{
			Total:    core.Int64(int64(in.AmountCents)),
			Currency: core.String("CNY"),
		},
	})
	if err != nil {
		return PrepayResult{}, fmt.Errorf("wechatpay: native prepay: %w", err)
	}
	if resp == nil || resp.CodeUrl == nil || *resp.CodeUrl == "" {
		return PrepayResult{}, fmt.Errorf("wechatpay: native prepay returned no code_url")
	}
	return PrepayResult{CodeURL: *resp.CodeUrl}, nil
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
		// A payload that does not decrypt with our APIv3 key is forged/tampered.
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

// outTradeNoPrefix namespaces our merchant order numbers so a callback's
// out_trade_no maps unambiguously back to a c3 order id.
const outTradeNoPrefix = "c3ls"

// OutTradeNo is the merchant order number for an order id (≤32 chars, the WeChat
// limit). Deterministic so a callback maps back without persisting it.
func OutTradeNo(orderID int64) string {
	return outTradeNoPrefix + strconv.FormatInt(orderID, 10)
}

// ParseOrderID recovers the order id from a merchant order number, reporting
// whether it was one we minted.
func ParseOrderID(outTradeNo string) (int64, bool) {
	rest, ok := strings.CutPrefix(outTradeNo, outTradeNoPrefix)
	if !ok {
		return 0, false
	}
	id, err := strconv.ParseInt(rest, 10, 64)
	if err != nil || id <= 0 {
		return 0, false
	}
	return id, true
}
