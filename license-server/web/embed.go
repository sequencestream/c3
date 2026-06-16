// Package web embeds the built license-server frontend (the Vue build output in
// dist/) so the single binary serves the buyer/admin web without any external
// asset directory. The committed dist/ is a minimal placeholder that proves the
// embed + SPA-fallback path; `npm run build` regenerates it from src/.
package web

import (
	"embed"
	"io/fs"
)

// distFS holds the embedded build output. The `all:` prefix includes files that
// would otherwise be skipped (e.g. dot-prefixed Vite assets).
//
//go:embed all:dist
var distFS embed.FS

// DistFS returns the embedded frontend rooted at the dist directory, so callers
// see "index.html" rather than "dist/index.html".
func DistFS() fs.FS {
	sub, err := fs.Sub(distFS, "dist")
	if err != nil {
		// Unreachable: dist is embedded at build time and always present.
		panic("web: embedded dist missing: " + err.Error())
	}
	return sub
}
