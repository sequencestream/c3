package httpapi

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"html/template"
	"net/http"
	"strconv"
	"strings"
	"time"

	qrcode "github.com/skip2/go-qrcode"

	"github.com/sequencestream/code-creative-center/license-server/internal/agreement"
	"github.com/sequencestream/code-creative-center/license-server/internal/plans"
	"github.com/sequencestream/code-creative-center/license-server/internal/store"
	"github.com/sequencestream/code-creative-center/license-server/internal/wechatpay"
)

// mountCheckout registers the buyer-facing renewal checkout. Both methods live
// on one path: GET renders the plan-selection page, POST records a pending
// order. A signed-in cookie is required; an unauthenticated visitor is sent to
// the sign-in page (PL-R9).
func mountCheckout(mux *http.ServeMux, d Deps) {
	mux.HandleFunc("/checkout", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			handleCheckoutPage(d)(w, r)
		case http.MethodPost:
			handleCheckoutCreate(d)(w, r)
		default:
			w.Header().Set("Allow", "GET, POST")
			renderError(w, http.StatusMethodNotAllowed, "Method not allowed", "Only GET and POST are allowed.")
		}
	})
}

// --- GET /checkout : choose a plan, accept the agreement --------------------

func handleCheckoutPage(d Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if d.Signer == nil {
			renderError(w, http.StatusServiceUnavailable, "Checkout unavailable", "signing key is not configured")
			return
		}
		sess, ok := d.currentSession(r)
		if !ok {
			http.Redirect(w, r, "/activate", http.StatusSeeOther)
			return
		}
		if !d.Store.Available() {
			renderError(w, http.StatusServiceUnavailable, "Checkout unavailable", "license database is not configured")
			return
		}
		licenses, err := d.Store.ListLicensesByBuyer(r.Context(), sess.UserID)
		if err != nil {
			renderError(w, http.StatusInternalServerError, "Checkout error", "Could not load your licenses.")
			return
		}
		renderCheckout(w, sess.Login, d.purchasablePlans(r.Context()), licenses)
	}
}

// --- POST /checkout : record a pending renewal order ------------------------

func handleCheckoutCreate(d Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if d.Signer == nil {
			renderError(w, http.StatusServiceUnavailable, "Checkout unavailable", "signing key is not configured")
			return
		}
		sess, ok := d.currentSession(r)
		if !ok {
			http.Redirect(w, r, "/activate", http.StatusSeeOther)
			return
		}
		if err := r.ParseForm(); err != nil {
			renderError(w, http.StatusBadRequest, "Invalid request", "Could not read the form.")
			return
		}
		// Acceptance of the service-usage agreement must be explicit and is
		// recorded on the order before any charge (PL-R9). Gated before any store
		// access so an unaccepted checkout is refused outright.
		if !accepted(r) {
			renderError(w, http.StatusBadRequest, "Agreement required",
				"You must accept the service agreement to continue. "+agreement.Summary)
			return
		}
		planKey := r.PostForm.Get("plan")
		if planKey == "" {
			renderError(w, http.StatusBadRequest, "Plan required", "Choose a plan to renew.")
			return
		}
		if !d.Store.Available() {
			renderError(w, http.StatusServiceUnavailable, "Checkout unavailable", "license database is not configured")
			return
		}

		// The renewal target must be a license the signed-in buyer owns.
		licenses, err := d.Store.ListLicensesByBuyer(r.Context(), sess.UserID)
		if err != nil {
			renderError(w, http.StatusInternalServerError, "Checkout error", "Could not load your licenses.")
			return
		}
		licenseID, _ := strconv.ParseInt(r.PostForm.Get("licenseId"), 10, 64)
		if !ownsLicense(licenses, licenseID) {
			renderError(w, http.StatusBadRequest, "License required", "Choose which license to renew.")
			return
		}

		// The amount is derived server-side in the store from the plan; any
		// client-supplied amount in the form is ignored entirely (PL-R9).
		order, err := d.Store.CreateOrder(r.Context(), store.CreateOrderInput{
			UserID:              sess.UserID,
			LicenseID:           licenseID,
			PlanKey:             planKey,
			AgreementVersion:    agreement.Version,
			AgreementAcceptedAt: time.Now(),
		})
		if err != nil {
			switch {
			case errors.Is(err, store.ErrAgreementRequired):
				renderError(w, http.StatusBadRequest, "Agreement required", agreement.Summary)
			case errors.Is(err, store.ErrNotFound):
				renderError(w, http.StatusBadRequest, "Unknown plan", "That plan is not available.")
			default:
				renderError(w, http.StatusInternalServerError, "Checkout error", "Could not create your order.")
			}
			return
		}

		// With WeChat Pay configured, place a Native unified order and show the
		// scan-to-pay QR; otherwise the order is recorded and payment is deferred.
		if d.Pay != nil {
			res, perr := d.Pay.Prepay(r.Context(), wechatpay.PrepayInput{
				OutTradeNo:  wechatpay.OutTradeNo(order.ID),
				AmountCents: order.AmountCents,
				Description: "c3 license renewal · " + order.PlanKey,
				NotifyURL:   strings.TrimRight(d.Config.PublicURL, "/") + "/v1/payment/wechat/notify",
			})
			if perr != nil {
				// The order is already recorded as pending; the buyer can retry from
				// the order page rather than losing the checkout.
				renderError(w, http.StatusBadGateway, "Payment unavailable",
					"Your order was created but the payment QR could not be generated. Please try again.")
				return
			}
			renderPaymentQR(w, order, res.CodeURL)
			return
		}
		renderOrderCreated(w, order)
	}
}

// --- helpers ----------------------------------------------------------------

// accepted reports whether the agreement checkbox was ticked on the form.
func accepted(r *http.Request) bool {
	v := r.PostForm.Get("accept")
	return v == "on" || v == "true"
}

// ownsLicense reports whether licenseID is one the buyer holds.
func ownsLicense(licenses []store.License, licenseID int64) bool {
	for _, l := range licenses {
		if l.ID == licenseID {
			return true
		}
	}
	return false
}

// purchasablePlans is the renewal-selectable catalog: the persisted catalog with
// trial plans excluded, falling back to the code catalog when the store is
// unavailable or empty (which carries no trials).
func (d Deps) purchasablePlans(ctx context.Context) []store.Plan {
	if d.Store.Available() {
		rows, err := d.Store.ListPlans(ctx)
		if err == nil && len(rows) > 0 {
			out := make([]store.Plan, 0, len(rows))
			for _, p := range rows {
				if !p.IsTrial {
					out = append(out, p)
				}
			}
			return out
		}
	}
	fallback := plans.All()
	out := make([]store.Plan, len(fallback))
	for i, p := range fallback {
		out[i] = store.Plan{PlanKey: p.ID, Name: p.Name, DurationMonths: p.DurationMonths, PriceCents: p.PriceCents, Currency: p.Currency}
	}
	return out
}

// formatPrice renders a minor-unit price as a major-unit amount with its
// currency symbol/code (e.g. 590 CNY → "¥5.90").
func formatPrice(cents int, currency string) string {
	major := fmt.Sprintf("%.2f", float64(cents)/100)
	if currency == "CNY" {
		return "¥" + major
	}
	return major + " " + currency
}

// --- templates --------------------------------------------------------------

var checkoutTmpl = template.Must(template.New("checkout").Parse(`<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>续费 — c3 license</title>
<style>
 body{font:16px/1.7 system-ui,sans-serif;max-width:42rem;margin:3rem auto;padding:0 1rem;color:#1a1a1a}
 h1{font-size:1.45rem} h2{font-size:1.05rem;margin:1.6rem 0 .4rem}
 .opt{display:flex;gap:.5rem;align-items:baseline;margin:.4rem 0;padding:.5rem .7rem;border:1px solid #ddd;border-radius:.4rem}
 .price{margin-left:auto;font-weight:600} .key{font:0.85rem ui-monospace,Menlo,monospace;color:#666}
 .agree{margin:1.4rem 0;display:flex;gap:.5rem;align-items:flex-start}
 button{font:inherit;padding:.6rem 1.2rem;border:0;border-radius:.4rem;background:#1a1a1a;color:#fff;cursor:pointer}
 button:disabled{opacity:.5;cursor:not-allowed} .note{color:#666;font-size:.9rem}
 @media(prefers-color-scheme:dark){body{background:#111;color:#eee}.opt{border-color:#333}button{background:#eee;color:#111}.note,.key{color:#aaa}}
</style></head><body>
<h1>续费 / Renew</h1>
<p class="note">Signed in as {{.Login}}.</p>
<form method="post" action="/checkout">
 <h2>选择套餐 / Plan</h2>
 {{range $i, $p := .Plans}}
 <label class="opt"><input type="radio" name="plan" value="{{$p.PlanKey}}"{{if eq $i 0}} checked{{end}}>
  <span>{{$p.Name}}</span><span class="price">{{$p.Price}}</span></label>
 {{else}}<p>No purchasable plans are available.</p>{{end}}

 <h2>续期目标 / License to renew</h2>
 {{range $i, $l := .Licenses}}
 <label class="opt"><input type="radio" name="licenseId" value="{{$l.ID}}"{{if eq $i 0}} checked{{end}}>
  <span class="key">{{$l.LicenseKey}}</span><span class="price">{{$l.Status}}</span></label>
 {{else}}<p>This account has no license to renew yet.</p>{{end}}

 <label class="agree"><input type="checkbox" name="accept" id="accept" onchange="document.getElementById('go').disabled=!this.checked">
  <span>我已阅读并同意《{{.AgreementTitle}}》（含无退款条款）。<a href="/activate" target="_blank">阅读全文</a></span></label>
 <button type="submit" id="go" disabled>下单 / Place order</button>
</form>
<p class="note">协议版本 {{.AgreementVersion}}。{{.AgreementSummary}}</p>
</body></html>`))

// checkoutPlanView / checkoutLicenseView are the display shapes for the page.
type checkoutPlanView struct {
	PlanKey string
	Name    string
	Price   string
}

type checkoutLicenseView struct {
	ID         int64
	LicenseKey string
	Status     string
}

func renderCheckout(w http.ResponseWriter, login string, ps []store.Plan, licenses []store.License) {
	planViews := make([]checkoutPlanView, len(ps))
	for i, p := range ps {
		planViews[i] = checkoutPlanView{PlanKey: p.PlanKey, Name: p.Name, Price: formatPrice(p.PriceCents, p.Currency)}
	}
	licViews := make([]checkoutLicenseView, len(licenses))
	for i, l := range licenses {
		licViews[i] = checkoutLicenseView{ID: l.ID, LicenseKey: l.LicenseKey, Status: l.Status}
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_ = checkoutTmpl.Execute(w, map[string]any{
		"Login":            login,
		"Plans":            planViews,
		"Licenses":         licViews,
		"AgreementTitle":   agreement.Title,
		"AgreementVersion": agreement.Version,
		"AgreementSummary": agreement.Summary,
	})
}

var orderCreatedTmpl = template.Must(template.New("order").Parse(`<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>订单已创建 — c3 license</title>
<style>
 body{font:16px/1.7 system-ui,sans-serif;max-width:42rem;margin:3rem auto;padding:0 1rem;color:#1a1a1a}
 h1{font-size:1.4rem} .meta{color:#666;font-size:.95rem}
 .card{margin:1.2rem 0;padding:1rem 1.2rem;border:1px solid #ddd;border-radius:.5rem}
 @media(prefers-color-scheme:dark){body{background:#111;color:#eee}.card{border-color:#333}.meta{color:#aaa}}
</style></head><body>
<h1>订单已创建 / Order created</h1>
<div class="card">
 <p>订单号 / Order #{{.ID}}</p>
 <p>套餐 / Plan {{.PlanKey}} · {{.Amount}} · {{.Status}}</p>
 <p class="meta">已记录服务协议接受（版本 {{.AgreementVersion}}）。</p>
</div>
<p class="meta">支付（微信支付）为后续里程碑；支付确认后将延长所选 license 的有效期。</p>
<p class="meta"><a href="/checkout">返回续费</a></p>
</body></html>`))

func renderOrderCreated(w http.ResponseWriter, o store.Order) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_ = orderCreatedTmpl.Execute(w, map[string]any{
		"ID":               o.ID,
		"PlanKey":          o.PlanKey,
		"Amount":           formatPrice(o.AmountCents, o.Currency),
		"Status":           o.Status,
		"AgreementVersion": o.AgreementVersion,
	})
}

var paymentQRTmpl = template.Must(template.New("pay").Parse(`<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>微信支付 — c3 license</title>
<style>
 body{font:16px/1.7 system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;color:#1a1a1a;text-align:center}
 h1{font-size:1.4rem} .meta{color:#666;font-size:.95rem}
 .qr{margin:1.4rem auto;width:256px;height:256px;border:1px solid #ddd;border-radius:.5rem;padding:.6rem;background:#fff}
 .amount{font-size:1.2rem;font-weight:600;margin:.4rem 0}
 @media(prefers-color-scheme:dark){body{background:#111;color:#eee}.meta{color:#aaa}}
</style></head><body>
<h1>微信扫码支付 / Scan to pay</h1>
<p class="amount">{{.Amount}} · {{.PlanKey}}</p>
<p class="meta">订单号 / Order #{{.ID}}</p>
<img class="qr" src="data:image/png;base64,{{.QR}}" alt="WeChat Pay QR" width="256" height="256">
<p class="meta">用微信「扫一扫」扫描上方二维码完成支付。支付确认后将延长所选 license 的有效期。</p>
<p class="meta">二维码 15 分钟内有效。<a href="/checkout">返回续费</a></p>
</body></html>`))

// renderPaymentQR shows the WeChat Pay Native scan code for a pending order. The
// code_url is encoded to a QR PNG server-side and inlined as a data URI so the
// pay link never leaves the page to a third-party renderer.
func renderPaymentQR(w http.ResponseWriter, o store.Order, codeURL string) {
	png, err := qrcode.Encode(codeURL, qrcode.Medium, 256)
	if err != nil {
		renderError(w, http.StatusInternalServerError, "Payment error", "Could not render the payment QR.")
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_ = paymentQRTmpl.Execute(w, map[string]any{
		"ID":      o.ID,
		"PlanKey": o.PlanKey,
		"Amount":  formatPrice(o.AmountCents, o.Currency),
		"QR":      base64.StdEncoding.EncodeToString(png),
	})
}
