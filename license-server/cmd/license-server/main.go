// Command license-server is the c3 license authority (ADR-0026): a standalone
// Go service that owns the entitlement record, the plan catalog, and the buyer/
// admin web. This entrypoint wires configuration, the in-process caches, the
// PostgreSQL connection + schema, and the HTTP surface, then serves until
// interrupted.
package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	lsdb "github.com/sequencestream/code-creative-center/license-server/database"
	"github.com/sequencestream/code-creative-center/license-server/internal/cache"
	"github.com/sequencestream/code-creative-center/license-server/internal/config"
	"github.com/sequencestream/code-creative-center/license-server/internal/httpapi"
	"github.com/sequencestream/code-creative-center/license-server/internal/oauth"
	"github.com/sequencestream/code-creative-center/license-server/internal/plans"
	"github.com/sequencestream/code-creative-center/license-server/internal/store"
	"github.com/sequencestream/code-creative-center/license-server/internal/token"
	"github.com/sequencestream/code-creative-center/license-server/internal/version"
	"github.com/sequencestream/code-creative-center/license-server/internal/wechatpay"
	"github.com/sequencestream/code-creative-center/license-server/web"
	"gorm.io/gorm"
)

func main() {
	if err := run(); err != nil {
		log.Fatalf("license-server: %v", err)
	}
}

func run() error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	caches := cache.NewRegistry(cfg.LRUSize)

	// Database is best-effort at the foundation stage: when a DSN is configured
	// we connect and migrate; when it is absent or unreachable the service still
	// serves /healthz (degraded) and the static frontend.
	var db = openDatabase(ctx, cfg)
	if db != nil {
		if sqlDB, err := db.DB(); err == nil {
			defer sqlDB.Close()
		}
	}

	// Activation dependencies. Each is best-effort: a missing OAuth credential,
	// signing key, or database leaves the activation surface reporting
	// "unavailable" rather than crashing the foundation service.
	signer := loadSigner(cfg)

	// The plan catalog lives in c3_ls_plan; bootstrap it from the code-owned set
	// so a fresh database serves plans, then GET /v1/plans reads the table.
	st := store.New(db)
	seedPlans(ctx, st)

	pay := loadGateway(cfg)

	srv := &http.Server{
		Addr: cfg.ListenAddr,
		Handler: httpapi.NewServer(httpapi.Deps{
			Config: cfg,
			Caches: caches,
			DB:     db,
			Static: web.DistFS(),
			OAuth:  oauth.New(cfg.GitHubOAuthClientID, cfg.GitHubOAuthClientSecret),
			Store:  st,
			Signer: signer,
			Pay:    pay,
		}),
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdownCtx)
	}()

	log.Printf("license-server %s listening on %s", version.Version, cfg.ListenAddr)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

// seedPlans bootstraps the persisted plan catalog (c3_ls_plan) from the
// code-owned plan set. It is best-effort: without a database it is a no-op, and a
// seed failure is logged and tolerated since GET /v1/plans falls back to the code
// catalog. ON CONFLICT DO NOTHING means existing rows (operator edits) survive.
func seedPlans(ctx context.Context, st *store.Store) {
	if !st.Available() {
		return
	}
	catalog := plans.All()
	rows := make([]store.Plan, len(catalog))
	for i, p := range catalog {
		rows[i] = store.Plan{
			PlanKey:        p.ID,
			Name:           p.Name,
			DurationMonths: p.DurationMonths,
			PriceCents:     p.PriceCents,
			Currency:       p.Currency,
			SortOrder:      i,
		}
	}
	if err := st.SeedPlans(ctx, rows); err != nil {
		log.Printf("license-server: plan catalog seed failed (%v); serving code catalog", err)
		return
	}
	log.Printf("license-server: plan catalog ensured (%d plans)", len(rows))
}

// loadSigner parses the Ed25519 signing seed when configured. A malformed key
// is an operator typo: it is logged and tolerated (returns nil), which makes the
// activation surface report "unavailable" rather than crashing the service.
func loadSigner(cfg *config.Config) httpapi.Signer {
	if cfg.Ed25519PrivateKey == "" {
		log.Printf("license-server: no %s configured; activation signing disabled", config.EnvEd25519PrivateKey)
		return nil
	}
	priv, kid, err := token.ParsePrivateKey(cfg.Ed25519PrivateKey)
	if err != nil {
		log.Printf("license-server: invalid %s (%v); activation signing disabled", config.EnvEd25519PrivateKey, err)
		return nil
	}
	log.Printf("license-server: entitlement signing key loaded (kid %s)", kid)
	return priv
}

// loadGateway builds the WeChat Pay gateway when the full credential set is
// configured. It is best-effort: missing credentials yield a nil gateway (the
// renewal checkout records the pending order but reports payment unavailable),
// and a construction failure (bad key/cert, or WeChat unreachable while the
// client fetches platform certs) is logged and tolerated rather than crashing
// the service.
func loadGateway(cfg *config.Config) wechatpay.Gateway {
	gw, err := wechatpay.New(wechatpay.Settings{
		MerchantID:    cfg.WeChatPayMchID,
		AppID:         cfg.WeChatPayAppID,
		CertSerialNo:  cfg.WeChatPayCertSerialNo,
		APIv3Key:      cfg.WeChatPayAPIKey,
		PrivateKeyB64: cfg.WeChatPayPrivateKey,
		CertB64:       cfg.WeChatPayCert,
	})
	if err != nil {
		log.Printf("license-server: WeChat Pay gateway disabled (%v); renewal payment unavailable", err)
		return nil
	}
	if gw == nil {
		log.Printf("license-server: no WeChat Pay credentials; renewal payment unavailable")
		return nil
	}
	log.Printf("license-server: WeChat Pay gateway ready (Native)")
	return gw
}

// openDatabase connects and ensures the schema when a DSN is configured. A
// connection failure is logged and tolerated (returns nil); a schema-setup
// failure is fatal, since a reachable-but-unschemaed database is a real
// operational error.
func openDatabase(ctx context.Context, cfg *config.Config) *gorm.DB {
	if cfg.DatabaseURL == "" {
		log.Printf("license-server: no %s configured; running without a database", config.EnvDatabaseURL)
		return nil
	}
	connectCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	db, err := lsdb.Open(connectCtx, cfg.DatabaseURL)
	if err != nil {
		log.Printf("license-server: database unreachable (%v); continuing degraded", err)
		return nil
	}
	if err := lsdb.EnsureSchema(ctx, db); err != nil {
		log.Fatalf("license-server: schema setup failed: %v", err)
	}
	log.Printf("license-server: database connected and schema ensured")
	return db
}
