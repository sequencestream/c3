package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/sequencestream/code-creative-center/license-server/internal/cache"
	"github.com/sequencestream/code-creative-center/license-server/internal/config"
)

func artifactDeps(t *testing.T, cacheSize int) (Deps, string) {
	t.Helper()
	dir := t.TempDir()
	cfg, err := config.LoadFrom(func(k string) string {
		switch k {
		case config.EnvArtifactDir:
			return dir
		case config.EnvArtifactUploadToken:
			return testUploadToken
		case config.EnvLRUSize:
			return strconv.Itoa(cacheSize)
		default:
			return ""
		}
	})
	if err != nil {
		t.Fatalf("config: %v", err)
	}
	return Deps{Config: cfg, Caches: cache.NewRegistry(cacheSize)}, dir
}

func writeArtifactRelease(t *testing.T, root, version, batch string, targets []artifactManifestItem) {
	t.Helper()
	dir := filepath.Join(root, version, batch)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	b, err := json.Marshal(artifactManifest{Artifacts: targets})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "manifest.json"), b, 0o644); err != nil {
		t.Fatal(err)
	}
	for _, target := range targets {
		if err := os.WriteFile(filepath.Join(dir, target.File), []byte("package-"+target.Target), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, target.File+".sha256"), []byte(target.SHA256+"  "+target.File+"\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func artifactRequest(d Deps, target string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	NewServer(d).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, target, nil))
	return rec
}

func TestArtifactLatestUsesHighestStableSemverAndNewestBatch(t *testing.T) {
	d, root := artifactDeps(t, 4)
	item := artifactManifestItem{Target: "linux-x64", File: "c3-v1.10.0-linux-x64.tar.gz", SHA256: "abc", Bytes: 12}
	writeArtifactRelease(t, root, "v1.9.0", "20260621-1200Z", itemSlice(item))
	writeArtifactRelease(t, root, "v1.10.0", "20260621-1200Z", itemSlice(item))
	writeArtifactRelease(t, root, "v1.10.0", "20260622-1200Z", itemSlice(item))
	writeArtifactRelease(t, root, "v9.0.0-dev", "20260623-1200Z", itemSlice(item))

	rec := artifactRequest(d, "/v1/artifact/latest")
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"version":"v1.10.0"`) || !strings.Contains(rec.Body.String(), `"batch":"20260622-1200Z"`) {
		t.Fatalf("latest = %d %s", rec.Code, rec.Body.String())
	}
}

func TestArtifactTargetsAndDownloads(t *testing.T) {
	d, root := artifactDeps(t, 4)
	linux := artifactManifestItem{Target: "linux-x64", File: "c3-v1.2.3-linux-x64.tar.gz", SHA256: "linuxsum", Bytes: 21}
	windows := artifactManifestItem{Target: "windows-x64", File: "c3-v1.2.3-windows-x64.zip", SHA256: "winsum", Bytes: 22}
	writeArtifactRelease(t, root, "v1.2.3", "20260622-1200Z", []artifactManifestItem{linux, windows})

	targets := artifactRequest(d, "/v1/artifact/v1.2.3/targets")
	if targets.Code != http.StatusOK || !strings.Contains(targets.Body.String(), `"sha256":"winsum"`) || !strings.Contains(targets.Body.String(), `"bytes":22`) {
		t.Fatalf("targets = %d %s", targets.Code, targets.Body.String())
	}
	binary := artifactRequest(d, "/v1/artifact/download?version=v1.2.3&os_arch=windows-x64&type=binary")
	if binary.Code != http.StatusOK || binary.Body.String() != "package-windows-x64" || binary.Header().Get("Content-Type") != "application/octet-stream" || !strings.Contains(binary.Header().Get("Content-Disposition"), "c3-v1.2.3-windows-x64.zip") {
		t.Fatalf("binary = %d %q headers=%v", binary.Code, binary.Body.String(), binary.Header())
	}
	sha := artifactRequest(d, "/v1/artifact/download?version=v1.2.3&os_arch=linux-x64&type=sha256")
	if sha.Code != http.StatusOK || sha.Body.String() != "linuxsum  c3-v1.2.3-linux-x64.tar.gz\n" || sha.Header().Get("Content-Type") != "text/plain; charset=utf-8" {
		t.Fatalf("sha256 = %d %q headers=%v", sha.Code, sha.Body.String(), sha.Header())
	}
}

func TestArtifactReadErrorsAndMethodGuard(t *testing.T) {
	d, root := artifactDeps(t, 2)
	item := artifactManifestItem{Target: "linux-x64", File: "c3-v1.0.0-linux-x64.tar.gz", SHA256: "sum", Bytes: 1}
	writeArtifactRelease(t, root, "v1.0.0", "20260622-1200Z", itemSlice(item))
	for _, target := range []string{
		"/v1/artifact/nope/targets",
		"/v1/artifact/download?version=v1.0.0&os_arch=../x&type=binary",
		"/v1/artifact/download?version=v1.0.0&os_arch=linux-x64&type=minisig",
		"/v1/artifact/download?version=v1.0.0&os_arch=macos-x64&type=binary",
	} {
		rec := artifactRequest(d, target)
		if rec.Code != http.StatusBadRequest && rec.Code != http.StatusNotFound {
			t.Errorf("%s: status = %d, want 400/404", target, rec.Code)
		}
	}
	if err := os.Remove(filepath.Join(root, "v1.0.0", "20260622-1200Z", item.File)); err != nil {
		t.Fatal(err)
	}
	if rec := artifactRequest(d, "/v1/artifact/download?version=v1.0.0&os_arch=linux-x64&type=binary"); rec.Code != http.StatusNotFound {
		t.Errorf("missing file = %d, want 404", rec.Code)
	}
	rec := httptest.NewRecorder()
	NewServer(d).ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/v1/artifact/latest", nil))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("method guard = %d, want 405", rec.Code)
	}
}

func TestArtifactReadUnavailableAndCacheInvalidation(t *testing.T) {
	cfg, err := config.LoadFrom(func(string) string { return "" })
	if err != nil {
		t.Fatal(err)
	}
	if rec := artifactRequest(Deps{Config: cfg, Caches: cache.NewRegistry(1)}, "/v1/artifact/latest"); rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("unconfigured = %d, want 503", rec.Code)
	}

	d, root := artifactDeps(t, 2)
	old := artifactManifestItem{Target: "linux-x64", File: "c3-v1.0.0-linux-x64.tar.gz", SHA256: "old", Bytes: 1}
	writeArtifactRelease(t, root, "v1.0.0", "20260622-1200Z", itemSlice(old))
	if rec := artifactRequest(d, "/v1/artifact/latest"); rec.Code != http.StatusOK {
		t.Fatal(rec.Code)
	}
	if d.Caches.Get(cache.NameArtifact).Len() == 0 {
		t.Fatal("latest was not cached")
	}
	// Removing the directory proves a second lookup served cached metadata rather
	// than reading the filesystem again.
	if err := os.RemoveAll(root); err != nil {
		t.Fatal(err)
	}
	if rec := artifactRequest(d, "/v1/artifact/latest"); rec.Code != http.StatusOK {
		t.Fatalf("cached latest = %d", rec.Code)
	}

	// A successful upload clears stale discovery metadata in the same process.
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	newer := artifactManifestItem{Target: "linux-x64", File: "c3-v2.0.0-linux-x64.tar.gz", SHA256: "new", Bytes: 1}
	writeArtifactRelease(t, root, "v2.0.0", "20260623-1200Z", itemSlice(newer))
	req := uploadRequest("/v1/artifact/upload?version=v2.0.0&batch=20260623-1200Z&filename=marker", testUploadToken, []byte("ok"))
	if rec := serveUpload(d, req); rec.Code != http.StatusOK {
		t.Fatalf("upload = %d %s", rec.Code, rec.Body.String())
	}
	rec := artifactRequest(d, "/v1/artifact/latest")
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"version":"v2.0.0"`) {
		t.Fatalf("invalidated latest = %d %s", rec.Code, rec.Body.String())
	}
}

func itemSlice(item artifactManifestItem) []artifactManifestItem { return []artifactManifestItem{item} }
