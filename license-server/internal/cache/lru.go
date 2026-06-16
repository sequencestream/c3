// Package cache provides a small, dependency-free LRU cache and the named-cache
// wiring the license-server uses for its hot read paths (plan catalog today;
// license, auth, and payment lookups as those surfaces land).
package cache

import (
	"container/list"
	"sync"
)

// LRU is a fixed-capacity, least-recently-used cache that is safe for
// concurrent use. Keys are strings; values are arbitrary. When full, inserting
// a new key evicts the least-recently-used entry.
//
// A non-positive capacity is treated as 1 so the cache is always usable.
type LRU[V any] struct {
	mu       sync.Mutex
	capacity int
	ll       *list.List               // front = most-recently-used
	items    map[string]*list.Element // key -> element
}

type entry[V any] struct {
	key   string
	value V
}

// NewLRU returns an LRU bounded to capacity entries.
func NewLRU[V any](capacity int) *LRU[V] {
	if capacity <= 0 {
		capacity = 1
	}
	return &LRU[V]{
		capacity: capacity,
		ll:       list.New(),
		items:    make(map[string]*list.Element, capacity),
	}
}

// Get returns the value for key and marks it most-recently-used. The second
// result reports whether the key was present.
func (c *LRU[V]) Get(key string) (V, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if el, ok := c.items[key]; ok {
		c.ll.MoveToFront(el)
		return el.Value.(*entry[V]).value, true
	}
	var zero V
	return zero, false
}

// Put inserts or updates key, marking it most-recently-used. If the cache is at
// capacity, the least-recently-used entry is evicted.
func (c *LRU[V]) Put(key string, value V) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if el, ok := c.items[key]; ok {
		el.Value.(*entry[V]).value = value
		c.ll.MoveToFront(el)
		return
	}
	el := c.ll.PushFront(&entry[V]{key: key, value: value})
	c.items[key] = el
	if c.ll.Len() > c.capacity {
		c.evictOldest()
	}
}

// GetOrLoad returns the cached value for key, or invokes load to produce it,
// caches the result, and returns it. load runs at most once per miss; if it
// returns an error the value is not cached and the error is propagated.
func (c *LRU[V]) GetOrLoad(key string, load func() (V, error)) (V, error) {
	if v, ok := c.Get(key); ok {
		return v, nil
	}
	v, err := load()
	if err != nil {
		var zero V
		return zero, err
	}
	c.Put(key, v)
	return v, nil
}

// Invalidate removes key if present.
func (c *LRU[V]) Invalidate(key string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if el, ok := c.items[key]; ok {
		c.removeElement(el)
	}
}

// Len returns the number of entries currently cached.
func (c *LRU[V]) Len() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.ll.Len()
}

// Cap returns the cache capacity.
func (c *LRU[V]) Cap() int {
	return c.capacity
}

func (c *LRU[V]) evictOldest() {
	if el := c.ll.Back(); el != nil {
		c.removeElement(el)
	}
}

func (c *LRU[V]) removeElement(el *list.Element) {
	c.ll.Remove(el)
	delete(c.items, el.Value.(*entry[V]).key)
}
