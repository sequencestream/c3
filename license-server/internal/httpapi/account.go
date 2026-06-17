package httpapi

import (
	"html/template"
	"net/http"

	"github.com/sequencestream/code-creative-center/license-server/internal/store"
)

// mountAccount registers the buyer self-service account page. GET renders the
// signed-in buyer's licenses (with binding status) and order history. An
// unauthenticated visitor is redirected to the sign-in page.
func mountAccount(mux *http.ServeMux, d Deps) {
	mux.HandleFunc("/account", allowGET(handleAccountPage(d)))
}

// --- GET /account : buyer self-service dashboard -----------------------------

func handleAccountPage(d Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		sess, ok := d.currentSession(r)
		if !ok {
			http.Redirect(w, r, "/activate", http.StatusSeeOther)
			return
		}
		if !d.Store.Available() {
			renderError(w, http.StatusServiceUnavailable, "Account unavailable",
				"The license database is not configured.")
			return
		}
		bindings, err := d.Store.LicenseBindingsByUser(r.Context(), sess.UserID)
		if err != nil {
			renderError(w, http.StatusInternalServerError, "Account error",
				"Could not load your license data.")
			return
		}
		orders, err := d.Store.OrdersByUser(r.Context(), sess.UserID)
		if err != nil {
			renderError(w, http.StatusInternalServerError, "Account error",
				"Could not load your order history.")
			return
		}
		renderAccount(w, sess.Login, bindings, orders)
	}
}

// --- templates --------------------------------------------------------------

var accountTmpl = template.Must(template.New("account").Parse(`<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>账户中心 — c3 license</title>
<style>
 body{font:16px/1.6 system-ui,sans-serif;max-width:48rem;margin:3rem auto;padding:0 1rem;color:#1a1a1a}
 h1{font-size:1.4rem} h2{font-size:1.1rem;margin:1.8rem 0 .4rem}
 .note{color:#666;font-size:.9rem}
 table{width:100%;border-collapse:collapse;margin:.6rem 0 1.2rem}
 th,td{text-align:left;padding:.4rem .5rem;border-bottom:1px solid #ddd;font-size:.9rem}
 th{font-weight:600;color:#555}
 .key{font:0.85rem ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all;background:#f4f4f4;padding:.15rem .35rem;border-radius:.2rem}
 .s{}.s-active{color:#1b7e1b}.s-expired{color:#a00}.s-pending{color:#a60}.s-paid{color:#1b7e1b}.s-failed{color:#a00}
 .meta{color:#666;font-size:.85rem}
 .cta{margin:2rem 0}.cta a{display:inline-block;padding:.5rem 1rem;border:1px solid #1a1a1a;border-radius:.3rem;text-decoration:none;color:#1a1a1a;font-weight:500}
 .cta a:hover{background:#1a1a1a;color:#fff}
 @media(prefers-color-scheme:dark){body{background:#111;color:#eee}.key{background:#1c1c1c}th,td{border-color:#333}th{color:#aaa}.note,.meta{color:#aaa}.cta a{border-color:#eee;color:#eee}.cta a:hover{background:#eee;color:#111}}
</style></head><body>
<h1>账户中心 / Account</h1>
<p class="note">Signed in as {{.Login}}.</p>
<div class="cta"><a href="/checkout">续费 / Renew a license →</a></div>

<h2>我的授权 / My Licenses</h2>
{{if .Licenses}}
<table>
 <tr><th>License Key</th><th>Plan</th><th>Status</th><th>有效期至</th><th>绑定设备</th><th>最后活跃</th></tr>
 {{range .Licenses}}
 <tr>
  <td><span class="key">{{.LicenseKey}}</span></td>
  <td>{{.Plan}}</td>
  <td class="s-{{.Status}}">{{.StatusLabel}}</td>
  <td>{{.TermEndDisplay}}</td>
  <td class="meta">{{.AliveInstallDisplay}}</td>
  <td class="meta">{{.AliveTimeDisplay}}</td>
 </tr>
 {{end}}
</table>
{{else}}<p class="note">暂无授权。</p>{{end}}

<h2>我的订单 / My Orders</h2>
{{if .Orders}}
<table>
 <tr><th>Order #</th><th>Plan</th><th>金额</th><th>Status</th><th>时间</th></tr>
 {{range .Orders}}
 <tr>
  <td>{{.ID}}</td>
  <td>{{.PlanKey}}</td>
  <td>{{.Amount}}</td>
  <td class="s-{{.Status}}">{{.StatusLabel}}</td>
  <td class="meta">{{.CreatedAtDisplay}}</td>
 </tr>
 {{end}}
</table>
{{else}}<p class="note">暂无订单。</p>{{end}}

<p class="meta"><a href="/checkout">返回续费</a></p>
</body></html>`))

// --- view types -------------------------------------------------------------

type accountLicenseView struct {
	LicenseKey         string
	Plan               string
	Status             string
	StatusLabel        string
	TermEndDisplay     string
	AliveInstallDisplay string
	AliveTimeDisplay   string
}

type accountOrderView struct {
	ID               int64
	PlanKey          string
	Amount           string
	Status           string
	StatusLabel      string
	CreatedAtDisplay string
}

func renderAccount(w http.ResponseWriter, login string, bindings []store.LicenseBinding, orders []store.Order) {
	licViews := make([]accountLicenseView, len(bindings))
	for i, b := range bindings {
		aliveInstall := ""
		if b.AliveInstallID != nil {
			aliveInstall = *b.AliveInstallID
		}
		aliveTime := ""
		if b.AliveTime != nil {
			aliveTime = b.AliveTime.UTC().Format("2006-01-02 15:04")
		}
		licViews[i] = accountLicenseView{
			LicenseKey:         b.LicenseKey,
			Plan:               b.PlanKey,
			Status:             b.Status,
			StatusLabel:        statusLabel(b.Status),
			TermEndDisplay:     b.TermEnd.UTC().Format("2006-01-02"),
			AliveInstallDisplay: aliveInstall,
			AliveTimeDisplay:   aliveTime,
		}
	}
	ordViews := make([]accountOrderView, len(orders))
	for i, o := range orders {
		ordViews[i] = accountOrderView{
			ID:               o.ID,
			PlanKey:          o.PlanKey,
			Amount:           formatPrice(o.AmountCents, o.Currency),
			Status:           o.Status,
			StatusLabel:      statusLabel(o.Status),
			CreatedAtDisplay: o.CreatedAt.UTC().Format("2006-01-02 15:04"),
		}
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_ = accountTmpl.Execute(w, map[string]any{
		"Login":    login,
		"Licenses": licViews,
		"Orders":   ordViews,
	})
}

// statusLabel returns a Chinese display label for order/license status.
func statusLabel(s string) string {
	switch s {
	case "active":
		return "有效"
	case "expired":
		return "已过期"
	case "pending":
		return "待支付"
	case "paid":
		return "已支付"
	case "failed":
		return "失败"
	case "disabled":
		return "已禁用"
	default:
		return s
	}
}

