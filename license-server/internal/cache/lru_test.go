package cache

import (
	"errors"
	"sync"
	"testing"
)

func TestLRUPutGet(t *testing.T) {
	c := NewLRU[int](2)
	c.Put("a", 1)
	c.Put("b", 2)
	if v, ok := c.Get("a"); !ok || v != 1 {
		t.Fatalf("Get(a) = %v,%v", v, ok)
	}
	if _, ok := c.Get("missing"); ok {
		t.Fatal("Get(missing) should miss")
	}
}

func TestLRUEviction(t *testing.T) {
	c := NewLRU[int](2)
	c.Put("a", 1)
	c.Put("b", 2)
	// Touch "a" so "b" is least-recently-used.
	c.Get("a")
	c.Put("c", 3) // evicts "b"
	if _, ok := c.Get("b"); ok {
		t.Error("b should have been evicted")
	}
	if _, ok := c.Get("a"); !ok {
		t.Error("a should survive (was touched)")
	}
	if _, ok := c.Get("c"); !ok {
		t.Error("c should be present")
	}
	if c.Len() != 2 {
		t.Errorf("Len = %d, want 2", c.Len())
	}
}

func TestLRUUpdateNoEvict(t *testing.T) {
	c := NewLRU[string](2)
	c.Put("a", "x")
	c.Put("a", "y") // update, not a new entry
	if c.Len() != 1 {
		t.Errorf("Len = %d, want 1", c.Len())
	}
	if v, _ := c.Get("a"); v != "y" {
		t.Errorf("Get(a) = %q, want y", v)
	}
}

func TestLRUInvalidate(t *testing.T) {
	c := NewLRU[int](2)
	c.Put("a", 1)
	c.Invalidate("a")
	if _, ok := c.Get("a"); ok {
		t.Error("a should be gone after Invalidate")
	}
	c.Invalidate("missing") // no panic
}

func TestLRUGetOrLoad(t *testing.T) {
	c := NewLRU[int](2)
	calls := 0
	load := func() (int, error) { calls++; return 42, nil }

	v, err := c.GetOrLoad("k", load)
	if err != nil || v != 42 {
		t.Fatalf("GetOrLoad = %v,%v", v, err)
	}
	v, err = c.GetOrLoad("k", load) // cached, no second load
	if err != nil || v != 42 {
		t.Fatalf("GetOrLoad(cached) = %v,%v", v, err)
	}
	if calls != 1 {
		t.Errorf("load called %d times, want 1", calls)
	}

	// A load error is not cached.
	wantErr := errors.New("boom")
	if _, err := c.GetOrLoad("e", func() (int, error) { return 0, wantErr }); !errors.Is(err, wantErr) {
		t.Errorf("GetOrLoad error = %v, want %v", err, wantErr)
	}
	if _, ok := c.Get("e"); ok {
		t.Error("errored load should not be cached")
	}
}

func TestLRUNonPositiveCapacity(t *testing.T) {
	c := NewLRU[int](0)
	if c.Cap() != 1 {
		t.Errorf("Cap = %d, want 1 (clamped)", c.Cap())
	}
	c.Put("a", 1)
	c.Put("b", 2) // evicts a
	if _, ok := c.Get("a"); ok {
		t.Error("capacity-1 cache should hold only newest")
	}
}

func TestLRUConcurrent(t *testing.T) {
	c := NewLRU[int](64)
	var wg sync.WaitGroup
	for i := range 50 {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			key := "k" + string(rune('a'+i%26))
			c.Put(key, i)
			c.Get(key)
		}(i)
	}
	wg.Wait() // -race in CI catches data races
}

func TestRegistryWiring(t *testing.T) {
	r := NewRegistry(32)
	if r.Size() != 32 {
		t.Errorf("Size = %d, want 32", r.Size())
	}
	for _, n := range Names() {
		c := r.Get(n)
		if c == nil {
			t.Fatalf("cache %q not wired", n)
		}
		if c.Cap() != 32 {
			t.Errorf("cache %q cap = %d, want 32", n, c.Cap())
		}
	}
	// Every documented hot path is present.
	for _, n := range []Name{NamePlans, NameLicense, NameAuth, NamePayment} {
		if _, ok := r.caches[n]; !ok {
			t.Errorf("expected cache %q to be wired", n)
		}
	}
}

func TestRegistryUnknownPanics(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Error("expected panic on unknown cache name")
		}
	}()
	NewRegistry(8).Get(Name("nope"))
}
