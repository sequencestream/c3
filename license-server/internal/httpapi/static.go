package httpapi

import (
	"io/fs"
	"net/http"
	"path"
	"strings"
)

// indexFile is the SPA entry point served for any non-asset, non-API route.
const indexFile = "index.html"

// staticHandler serves the embedded frontend. An existing file is served
// directly; an unknown path falls back to the SPA entry point (index.html) so
// client-side routing works. Unknown API paths return a JSON 404 instead of the
// SPA, so a mistyped /v1/... never silently returns HTML.
func staticHandler(static fs.FS) http.Handler {
	fileServer := http.FileServerFS(static)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		clean := path.Clean(r.URL.Path)
		name := strings.TrimPrefix(clean, "/")
		if name == "" || name == "." {
			name = indexFile
		}

		if fileExists(static, name) {
			fileServer.ServeHTTP(w, r)
			return
		}

		// Reserved API namespaces must not be masked by the SPA fallback.
		if isAPIPath(clean) {
			writeError(w, http.StatusNotFound, "not_found", "unknown endpoint")
			return
		}

		serveIndex(w, r, static)
	})
}

func isAPIPath(p string) bool {
	return strings.HasPrefix(p, "/v1/") || p == "/healthz"
}

func fileExists(fsys fs.FS, name string) bool {
	f, err := fsys.Open(name)
	if err != nil {
		return false
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || info.IsDir() {
		return false
	}
	return true
}

func serveIndex(w http.ResponseWriter, r *http.Request, fsys fs.FS) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	http.ServeFileFS(w, r, fsys, indexFile)
}
