package wechatpay

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"encoding/base64"
	"encoding/json"
	"errors"
	"testing"
)

// testAPIv3Key is a 32-byte AES-256 key (the APIv3 key length).
const testAPIv3Key = "0123456789abcdef0123456789abcdef"

// okVerify / failVerify are stub signature verifiers: the real one downloads
// WeChat's platform certificate over the network, so injecting the seam keeps
// ParseNotify exercisable offline.
func okVerify(context.Context, func(string) string, []byte) error   { return nil }
func failVerify(context.Context, func(string) string, []byte) error { return errors.New("bad sig") }

// encryptedNotifyBody seals a transaction resource the way WeChat does — AES-256-GCM
// under the APIv3 key — and wraps it in a callback envelope.
func encryptedNotifyBody(t *testing.T, key, outTradeNo, tradeState string, total int) []byte {
	t.Helper()
	plain, err := json.Marshal(map[string]any{
		"out_trade_no":   outTradeNo,
		"transaction_id": "wx-tx-1",
		"trade_state":    tradeState,
		"amount":         map[string]any{"total": total},
	})
	if err != nil {
		t.Fatalf("marshal resource: %v", err)
	}
	block, err := aes.NewCipher([]byte(key))
	if err != nil {
		t.Fatalf("aes cipher: %v", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		t.Fatalf("gcm: %v", err)
	}
	nonce := "123456789012" // 12-byte GCM standard nonce
	aad := "transaction"
	sealed := gcm.Seal(nil, []byte(nonce), plain, []byte(aad))
	body, err := json.Marshal(map[string]any{
		"id":         "evt-1",
		"event_type": "TRANSACTION.SUCCESS",
		"resource": map[string]any{
			"algorithm":       "AEAD_AES_256_GCM",
			"ciphertext":      base64.StdEncoding.EncodeToString(sealed),
			"associated_data": aad,
			"nonce":           nonce,
		},
	})
	if err != nil {
		t.Fatalf("marshal envelope: %v", err)
	}
	return body
}

func TestParseNotifyAcceptsValidCallback(t *testing.T) {
	g := &nativeGateway{apiV3Key: testAPIv3Key, verify: okVerify}
	body := encryptedNotifyBody(t, testAPIv3Key, "c3ls42", TradeStateSuccess, 590)
	res, err := g.ParseNotify(func(string) string { return "x" }, body)
	if err != nil {
		t.Fatalf("valid callback rejected: %v", err)
	}
	if res.OutTradeNo != "c3ls42" || res.AmountCents != 590 || !res.Paid() {
		t.Errorf("result = %+v, want out_trade_no c3ls42, 590, paid", res)
	}
}

func TestParseNotifyRejectsForgedSignature(t *testing.T) {
	// A body sealed with the right key but whose signature does not verify must be
	// rejected — a forged "payment success" can never advance an order (PL-R12).
	g := &nativeGateway{apiV3Key: testAPIv3Key, verify: failVerify}
	body := encryptedNotifyBody(t, testAPIv3Key, "c3ls42", TradeStateSuccess, 590)
	_, err := g.ParseNotify(func(string) string { return "x" }, body)
	if !errors.Is(err, ErrSignatureInvalid) {
		t.Fatalf("forged signature err = %v, want ErrSignatureInvalid", err)
	}
}

func TestParseNotifyRejectsTamperedCiphertext(t *testing.T) {
	// Signature stubbed valid, but the resource was sealed under a different key:
	// decryption with our APIv3 key must fail and the callback is refused.
	g := &nativeGateway{apiV3Key: testAPIv3Key, verify: okVerify}
	body := encryptedNotifyBody(t, "ffffffffffffffffffffffffffffffff", "c3ls42", TradeStateSuccess, 590)
	_, err := g.ParseNotify(func(string) string { return "x" }, body)
	if !errors.Is(err, ErrSignatureInvalid) {
		t.Fatalf("undecryptable resource err = %v, want ErrSignatureInvalid", err)
	}
}

func TestOutTradeNoRoundTrip(t *testing.T) {
	no := OutTradeNo(42)
	id, ok := ParseOrderID(no)
	if !ok || id != 42 {
		t.Fatalf("round trip %q = (%d,%v), want (42,true)", no, id, ok)
	}
	if _, ok := ParseOrderID("not-ours-123"); ok {
		t.Error("foreign out_trade_no must not parse")
	}
	if _, ok := ParseOrderID("c3lsx"); ok {
		t.Error("non-numeric suffix must not parse")
	}
}
