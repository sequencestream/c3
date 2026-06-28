package orders

import (
	"context"
	"errors"
	"fmt"
	"math"
	"strings"
	"time"

	"github.com/sequencestream/code-creative-center/license-server/internal/licenses"
	"github.com/sequencestream/code-creative-center/license-server/internal/plans"
	"github.com/sequencestream/code-creative-center/license-server/internal/store"
	"gorm.io/gorm"
)

// Repo is the c3_ls_order data access. It owns every read/write of the order
// table. Order settlement (MarkPaid) extends the funded license, a cross-table
// write the Repo coordinates by calling the plans and licenses repositories inside
// its own transaction.
type Repo struct {
	st       *store.Store
	plans    *plans.Repo
	licenses *licenses.Repo
}

// NewRepo builds the order repository. plans and licenses back the settlement
// transaction (plan duration lookup + license term extension); they may be nil
// when settlement is never exercised, but the standard wiring supplies them.
func NewRepo(st *store.Store, plansRepo *plans.Repo, licensesRepo *licenses.Repo) *Repo {
	return &Repo{st: st, plans: plansRepo, licenses: licensesRepo}
}

// Available reports whether a database is configured.
func (r *Repo) Available() bool { return r.st.Available() }

// orderSelectCols is the column list shared by every order read, kept in one place
// so a SELECT and a RETURNING stay in lockstep with orderRow.
const orderSelectCols = `id, order_no, user_id, license_id, plan_key, amount_cents, currency,
	agreement_version, agreement_accepted_at, status, payment_ref, created_at`

// orderRow is the raw select shape; license_id, payment_ref and order_no are
// nullable so they map to pointers and are normalized to 0/"" when absent.
type orderRow struct {
	ID                  int64
	OrderNo             *string
	UserID              int64
	LicenseID           *int64
	PlanKey             string
	AmountCents         int
	Currency            string
	AgreementVersion    string
	AgreementAcceptedAt time.Time
	Status              string
	PaymentRef          *string
	CreatedAt           time.Time
}

func (r orderRow) toOrder() Order {
	var lic int64
	if r.LicenseID != nil {
		lic = *r.LicenseID
	}
	var ref string
	if r.PaymentRef != nil {
		ref = *r.PaymentRef
	}
	var no string
	if r.OrderNo != nil {
		no = *r.OrderNo
	}
	return Order{
		ID:                  r.ID,
		OrderNo:             no,
		UserID:              r.UserID,
		LicenseID:           lic,
		PlanKey:             r.PlanKey,
		AmountCents:         r.AmountCents,
		Currency:            r.Currency,
		AgreementVersion:    r.AgreementVersion,
		AgreementAcceptedAt: r.AgreementAcceptedAt,
		Status:              r.Status,
		PaymentRef:          ref,
		CreatedAt:           r.CreatedAt,
	}
}

// Create records a pending renewal order. It rejects an input without a recorded
// agreement acceptance (ErrAgreementRequired) and an unknown plan (ErrNotFound).
// The persisted amount_cents/currency are taken from the plan row — the single
// source of truth for price — so any client-supplied amount is ignored. The order
// is created with status 'pending'.
func (r *Repo) Create(ctx context.Context, in CreateOrderInput, newOrderNo func() string) (Order, error) {
	if !r.st.Available() {
		return Order{}, errors.New("orders: database not configured")
	}
	if strings.TrimSpace(in.AgreementVersion) == "" || in.AgreementAcceptedAt.IsZero() {
		return Order{}, ErrAgreementRequired
	}
	plan, ok, err := r.plans.ByKey(ctx, in.PlanKey)
	if err != nil {
		return Order{}, err
	}
	if !ok {
		return Order{}, ErrNotFound
	}
	amountCents := plan.PriceCents
	if in.AmountCentsOverride != nil {
		amountCents = *in.AmountCentsOverride
	}
	// order_no is the business/payment-association number (the WeChat out_trade_no);
	// it carries a millisecond timestamp + random suffix and is unique. A unique
	// collision is retried with a freshly generated number (mirrors license_key).
	var row orderRow
	var lastErr error
	for range 5 {
		res := r.st.DB().WithContext(ctx).Raw(`
			INSERT INTO c3_ls_order
				(order_no, user_id, license_id, plan_key, amount_cents, currency, agreement_version, agreement_accepted_at, status)
			VALUES ($1, $2, NULLIF($3, 0), $4, $5, $6, $7, $8, 'pending')
			RETURNING `+orderSelectCols,
			newOrderNo(), in.UserID, in.LicenseID, in.PlanKey, amountCents, plan.Currency,
			in.AgreementVersion, in.AgreementAcceptedAt).Scan(&row)
		if res.Error == nil && res.RowsAffected > 0 {
			return row.toOrder(), nil
		}
		lastErr = res.Error
	}
	return Order{}, fmt.Errorf("orders: create: %w", lastErr)
}

// ByUser returns every order a user placed, newest first.
func (r *Repo) ByUser(ctx context.Context, userID int64) ([]Order, error) {
	if !r.st.Available() {
		return nil, errors.New("orders: database not configured")
	}
	var rows []orderRow
	res := r.st.DB().WithContext(ctx).Raw(`SELECT `+orderSelectCols+`
		FROM c3_ls_order
		WHERE user_id = $1
		ORDER BY created_at DESC, id DESC`, userID).Scan(&rows)
	if res.Error != nil {
		return nil, fmt.Errorf("orders: list: %w", res.Error)
	}
	out := make([]Order, len(rows))
	for i, row := range rows {
		out[i] = row.toOrder()
	}
	return out, nil
}

// ByID returns one order by its internal id, or ErrNotFound.
func (r *Repo) ByID(ctx context.Context, id int64) (Order, error) {
	if !r.st.Available() {
		return Order{}, errors.New("orders: database not configured")
	}
	var row orderRow
	res := r.st.DB().WithContext(ctx).Raw(`SELECT `+orderSelectCols+` FROM c3_ls_order WHERE id = $1`, id).Scan(&row)
	if res.Error != nil {
		return Order{}, fmt.Errorf("orders: get: %w", res.Error)
	}
	if res.RowsAffected == 0 {
		return Order{}, ErrNotFound
	}
	return row.toOrder(), nil
}

// MarkPaid advances a pending order to paid, records the external payment
// reference, and extends the linked license's term and status (PL-R9). It is
// idempotent: a callback delivered more than once finds the order already paid and
// returns (order, false, nil) without re-extending the license. A terminal failed
// order is left untouched. The payment reference is the only payment artifact
// persisted — no credentials ever reach the store (PL-R12). Reports whether this
// call performed the pending→paid transition.
func (r *Repo) MarkPaid(ctx context.Context, orderNo, paymentRef string, now time.Time) (Order, bool, error) {
	if !r.st.Available() {
		return Order{}, false, errors.New("orders: database not configured")
	}
	var out Order
	advanced := false
	err := r.st.DB().WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var row orderRow
		res := tx.Raw(`SELECT `+orderSelectCols+` FROM c3_ls_order WHERE order_no = $1 FOR UPDATE`, orderNo).Scan(&row)
		if res.Error != nil {
			return fmt.Errorf("orders: lock order: %w", res.Error)
		}
		if res.RowsAffected == 0 {
			return ErrNotFound
		}
		if row.Status != "pending" {
			// Already paid (idempotent replay), or a terminal failed/expired order —
			// never mutate and never (re-)extend the license (PL-R9, §11).
			out = row.toOrder()
			return nil
		}
		var updated orderRow
		res = tx.Raw(`
			UPDATE c3_ls_order SET status = 'paid', payment_ref = $2
			WHERE order_no = $1 AND status = 'pending'
			RETURNING `+orderSelectCols, orderNo, paymentRef).Scan(&updated)
		if res.Error != nil {
			return fmt.Errorf("orders: mark paid: %w", res.Error)
		}
		out = updated.toOrder()
		// Extend or replace the renewal target in the same transaction as the order
		// transition. Long-lived free licenses and paid→enterprise upgrades replace
		// the term from now; same-tier paid/enterprise renewals extend it.
		if out.LicenseID != 0 {
			plan, ok, err := r.plans.ByKeyTx(tx, out.PlanKey)
			if err != nil {
				return err
			}
			if !ok {
				return ErrNotFound
			}
			current, ok, err := r.licenses.ByIDTx(tx, out.LicenseID)
			if err != nil {
				return err
			}
			if !ok {
				return ErrNotFound
			}
			replaceTerm := current.Tier == "free" || (current.Tier == "paid" && plan.Tier == "enterprise")
			if replaceTerm {
				if err := r.licenses.ReplaceTermWithTierTx(tx, out.LicenseID, plan.DurationMonths, plan.Tier, now); err != nil {
					return err
				}
			} else if err := r.licenses.ExtendTermWithTierTx(tx, out.LicenseID, plan.DurationMonths, plan.Tier, now); err != nil {
				return err
			}
		}
		advanced = true
		return nil
	})
	if err != nil {
		return Order{}, false, err
	}
	return out, advanced, nil
}

// PlanByKey exposes the server-owned plan row to the service layer for checkout
// policy decisions. It is still backed by the plan repo, not client input.
func (r *Repo) PlanByKey(ctx context.Context, planKey string) (plans.Record, bool, error) {
	return r.plans.ByKey(ctx, planKey)
}

// UpgradeAmountCents computes the paid→enterprise upgrade amount from the target
// license's remaining paid term.
func (r *Repo) UpgradeAmountCents(ctx context.Context, enterprisePriceCents int, targetTermEnd time.Time, now time.Time) (int, error) {
	annual, ok, err := r.plans.AnnualPaidPriceCents(ctx)
	if err != nil {
		return 0, err
	}
	if !ok {
		return enterprisePriceCents, nil
	}
	remaining := targetTermEnd.Sub(now)
	if remaining <= 0 {
		return enterprisePriceCents, nil
	}
	credit := int(math.Round(remaining.Hours() / 24 / 365 * float64(annual)))
	if credit >= enterprisePriceCents {
		return 0, nil
	}
	return enterprisePriceCents - credit, nil
}

// MarkFailed records a pending order as failed with the external payment
// reference. It never downgrades a paid order and is idempotent on an
// already-failed one; only a pending order transitions. Reports whether this call
// performed the pending→failed transition.
func (r *Repo) MarkFailed(ctx context.Context, orderNo, paymentRef string) (Order, bool, error) {
	return r.terminatePending(ctx, orderNo, "failed", paymentRef)
}

// MarkExpired records a pending order as expired (its payment window lapsed
// without a successful payment, §11). It never downgrades a paid/failed order and
// is idempotent on an already-expired one; only a pending order transitions.
// Reports whether this call performed the transition.
func (r *Repo) MarkExpired(ctx context.Context, orderNo string) (Order, bool, error) {
	return r.terminatePending(ctx, orderNo, "expired", "")
}

// terminatePending transitions a single pending order to a terminal state
// (failed/expired), recording paymentRef when present. Shared by MarkFailed and
// MarkExpired so both stay idempotent and never touch a settled order.
func (r *Repo) terminatePending(ctx context.Context, orderNo, terminal, paymentRef string) (Order, bool, error) {
	if !r.st.Available() {
		return Order{}, false, errors.New("orders: database not configured")
	}
	var out Order
	advanced := false
	err := r.st.DB().WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var row orderRow
		res := tx.Raw(`SELECT `+orderSelectCols+` FROM c3_ls_order WHERE order_no = $1 FOR UPDATE`, orderNo).Scan(&row)
		if res.Error != nil {
			return fmt.Errorf("orders: lock order: %w", res.Error)
		}
		if res.RowsAffected == 0 {
			return ErrNotFound
		}
		if row.Status != "pending" {
			out = row.toOrder()
			return nil
		}
		var updated orderRow
		res = tx.Raw(`
			UPDATE c3_ls_order SET status = $2, payment_ref = COALESCE(NULLIF($3, ''), payment_ref)
			WHERE order_no = $1 AND status = 'pending'
			RETURNING `+orderSelectCols, orderNo, terminal, paymentRef).Scan(&updated)
		if res.Error != nil {
			return fmt.Errorf("orders: mark order %s: %w", terminal, res.Error)
		}
		out = updated.toOrder()
		advanced = true
		return nil
	})
	if err != nil {
		return Order{}, false, err
	}
	return out, advanced, nil
}

// StatusByNo returns the status of the named order, scoped to userID so a
// signed-in user can only poll their own order. ok is false when no such order
// exists for that user. Backs the checkout page's payment-confirmation poll.
func (r *Repo) StatusByNo(ctx context.Context, userID int64, orderNo string) (string, bool, error) {
	if !r.st.Available() {
		return "", false, errors.New("orders: database not configured")
	}
	var status string
	res := r.st.DB().WithContext(ctx).Raw(`
		SELECT status FROM c3_ls_order WHERE order_no = $1 AND user_id = $2`, orderNo, userID).Scan(&status)
	if res.Error != nil {
		return "", false, fmt.Errorf("orders: status: %w", res.Error)
	}
	if res.RowsAffected == 0 {
		return "", false, nil
	}
	return status, true, nil
}

// ListPending returns every order still in 'pending', oldest first, for the
// reconcile job (§11) to query against WeChat and settle.
func (r *Repo) ListPending(ctx context.Context) ([]PendingOrder, error) {
	if !r.st.Available() {
		return nil, errors.New("orders: database not configured")
	}
	var rows []struct {
		OrderNo   *string
		CreatedAt time.Time
	}
	res := r.st.DB().WithContext(ctx).Raw(`
		SELECT order_no, created_at FROM c3_ls_order
		WHERE status = 'pending' AND order_no IS NOT NULL
		ORDER BY created_at ASC`).Scan(&rows)
	if res.Error != nil {
		return nil, fmt.Errorf("orders: list pending: %w", res.Error)
	}
	out := make([]PendingOrder, 0, len(rows))
	for _, row := range rows {
		no := ""
		if row.OrderNo != nil {
			no = *row.OrderNo
		}
		out = append(out, PendingOrder{OrderNo: no, CreatedAt: row.CreatedAt})
	}
	return out, nil
}

// ExpireStalePending bulk-transitions pending orders created before cutoff to
// 'expired' (the lazy/sweep side of the payment window, §11). Returns the count
// expired. Idempotent: only 'pending' rows are touched.
func (r *Repo) ExpireStalePending(ctx context.Context, cutoff time.Time) (int64, error) {
	if !r.st.Available() {
		return 0, errors.New("orders: database not configured")
	}
	res := r.st.DB().WithContext(ctx).Exec(`
		UPDATE c3_ls_order SET status = 'expired'
		WHERE status = 'pending' AND created_at < $1`, cutoff)
	if res.Error != nil {
		return 0, fmt.Errorf("orders: expire stale pending: %w", res.Error)
	}
	return res.RowsAffected, nil
}

// PaidByUser returns a user's paid orders, newest first, for GET /v1/orders.
func (r *Repo) PaidByUser(ctx context.Context, userID int64) ([]Order, error) {
	if !r.st.Available() {
		return nil, errors.New("orders: database not configured")
	}
	var rows []orderRow
	res := r.st.DB().WithContext(ctx).Raw(`SELECT `+orderSelectCols+`
		FROM c3_ls_order
		WHERE user_id = $1 AND status = 'paid'
		ORDER BY created_at DESC, id DESC`, userID).Scan(&rows)
	if res.Error != nil {
		return nil, fmt.Errorf("orders: list paid: %w", res.Error)
	}
	out := make([]Order, len(rows))
	for i, row := range rows {
		out[i] = row.toOrder()
	}
	return out, nil
}
