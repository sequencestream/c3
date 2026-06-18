// Package orders is the LS purchase domain: the renewal order record (c3_ls_order)
// and its state machine. It owns every read/write of the order table (the Repo)
// and the checkout/renewal business rules (the Service). Order settlement extends
// the funded license — a cross-table transaction the Repo coordinates by calling
// the plans and licenses repositories within its own tx, so the order transition
// and the license extension commit atomically (§5).
package orders

import (
	"crypto/rand"
	"errors"
	"fmt"
	"strings"
	"time"
)

// ErrNotFound is returned when an order lookup matches no row.
var ErrNotFound = errors.New("orders: not found")

// ErrAgreementRequired is returned by Create when the service-usage agreement
// acceptance (version + accepted-at) is absent. An order can never be recorded
// without its acceptance (PL-R9).
var ErrAgreementRequired = errors.New("orders: service agreement not accepted")

// ErrPlanUnavailable is returned when checkout names a plan that is not in the
// catalog.
var ErrPlanUnavailable = errors.New("orders: plan not available")

// ErrLicenseNotChosen is returned when checkout names no license the signed-in
// user owns as the renewal target.
var ErrLicenseNotChosen = errors.New("orders: renewal license not chosen")

// ErrTermCapExceeded is returned when the renewal target's term already extends
// beyond the one-year cap (§11).
var ErrTermCapExceeded = errors.New("orders: license term cap exceeded")

// Order is a persisted purchase record: a renewal that, once paid, extends the
// linked license's term and status (PL-R9). LicenseID is the renewal target (0
// when none is linked yet). AmountCents/Currency are server-derived from the plan,
// never trusted from the client.
type Order struct {
	ID                  int64
	OrderNo             string // business order number (C3+YYYYMMDDHHmmssSSS+random4); the WeChat out_trade_no
	UserID              int64
	LicenseID           int64
	PlanKey             string
	AmountCents         int
	Currency            string
	AgreementVersion    string
	AgreementAcceptedAt time.Time
	Status              string
	// PaymentRef is the external payment provider reference (the WeChat Pay
	// transaction id) recorded when the order is paid; empty until then.
	PaymentRef string
	CreatedAt  time.Time
}

// CreateOrderInput is the checkout request. It deliberately carries no amount: the
// amount is derived server-side from the plan so a client can never dictate what it
// is charged (PL-R9). AgreementVersion and AgreementAcceptedAt record the
// service-usage agreement acceptance taken before payment.
type CreateOrderInput struct {
	UserID              int64
	LicenseID           int64 // renewal target; 0 stores NULL
	PlanKey             string
	AgreementVersion    string
	AgreementAcceptedAt time.Time
}

// PendingOrder is the minimal projection the reconcile job needs: enough to call
// WeChat order-query (OrderNo) and to apply the payment window (CreatedAt).
type PendingOrder struct {
	OrderNo   string
	CreatedAt time.Time
}

// NewOrderNo builds a business order number: "C3" + YYYYMMDDHHmmssSSS (to the
// millisecond) + 4 random digits (23 chars, ≤32 WeChat out_trade_no limit). It is
// the payment-association handle; a rare collision is retried by Create.
func NewOrderNo(now time.Time) string {
	stamp := now.Format("20060102150405") + fmt.Sprintf("%03d", now.Nanosecond()/1_000_000)
	return "C3" + stamp + randomDigits(4)
}

// randomDigits returns n cryptographically-random decimal digits. A crypto/rand
// failure is fatal-by-panic since a non-random order number must never be issued.
func randomDigits(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic("orders: crypto/rand failed: " + err.Error())
	}
	var sb strings.Builder
	for _, x := range b {
		sb.WriteByte('0' + x%10)
	}
	return sb.String()
}
