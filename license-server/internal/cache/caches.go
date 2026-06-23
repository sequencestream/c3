package cache

// Name identifies an in-process cache. Naming the caches up front documents the
// hot read paths the LS will serve and keeps the wiring in one place, even
// before the license/auth/payment surfaces are implemented.
type Name string

const (
	// NamePlans caches the plan catalog (served today).
	NamePlans Name = "plans"
	// NameLicense caches license lookups keyed by installation/license id.
	NameLicense Name = "license"
	// NameAuth caches resolved auth/identity sessions.
	NameAuth Name = "auth"
	// NamePayment caches in-flight payment/order state.
	NamePayment Name = "payment"
	// NameArtifact caches filesystem-derived artifact distribution metadata.
	NameArtifact Name = "artifact"
)

// Names lists every wired cache, in a stable order.
func Names() []Name {
	return []Name{NamePlans, NameLicense, NameAuth, NamePayment, NameArtifact}
}

// Registry holds the process-wide set of named caches, each bounded to the same
// configured capacity. Values are stored as any so a single registry can back
// heterogeneous read paths; callers type-assert at their boundary.
type Registry struct {
	size   int
	caches map[Name]*LRU[any]
}

// NewRegistry builds every named cache at the given per-cache capacity.
func NewRegistry(size int) *Registry {
	r := &Registry{size: size, caches: make(map[Name]*LRU[any])}
	for _, n := range Names() {
		r.caches[n] = NewLRU[any](size)
	}
	return r
}

// Get returns the named cache. It panics on an unknown name, which can only be
// a programming error since every name is a typed constant created at startup.
func (r *Registry) Get(name Name) *LRU[any] {
	c, ok := r.caches[name]
	if !ok {
		panic("cache: unknown cache name " + string(name))
	}
	return c
}

// Size is the per-cache capacity every cache in the registry was built with.
func (r *Registry) Size() int { return r.size }
