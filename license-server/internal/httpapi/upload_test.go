package httpapi

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/sequencestream/code-creative-center/license-server/internal/config"
)

const testUploadToken = "fixed-upload-token"

// uploadDeps returns Deps wired with an artifact upload token + a fresh temp dir.
func uploadDeps(t *testing.T) (Deps, string) {
	t.Helper()
	dir := t.TempDir()
	cfg, err := config.LoadFrom(func(k string) string {
		switch k {
		case config.EnvArtifactUploadToken:
			return testUploadToken
		case config.EnvArtifactDir:
			return dir
		default:
			return ""
		}
	})
	if err != nil {
		t.Fatalf("config: %v", err)
	}
	return Deps{Config: cfg}, dir
}

func uploadRequest(target, token string, body []byte) *http.Request {
	r := httptest.NewRequest(http.MethodPost, target, bytes.NewReader(body))
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	return r
}

func serveUpload(d Deps, r *http.Request) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	allowPOST(handleArtifactUpload(d)).ServeHTTP(rec, r)
	return rec
}

func TestArtifactUploadDisabledWhenUnconfigured(t *testing.T) {
	cfg, err := config.LoadFrom(func(string) string { return "" })
	if err != nil {
		t.Fatalf("config: %v", err)
	}
	rec := serveUpload(Deps{Config: cfg},
		uploadRequest("/v1/artifact/upload?version=v1.0.0&batch=b1&filename=c3.tar.gz", testUploadToken, []byte("x")))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", rec.Code)
	}
}

func TestArtifactUploadRejectsBadToken(t *testing.T) {
	d, _ := uploadDeps(t)
	rec := serveUpload(d,
		uploadRequest("/v1/artifact/upload?version=v1.0.0&batch=b1&filename=c3.tar.gz", "wrong-token", []byte("x")))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}

func TestArtifactUploadRejectsTraversalFilename(t *testing.T) {
	d, dir := uploadDeps(t)
	for _, fn := range []string{"..%2Fevil", "..", "sub%2Fc3.tar.gz"} {
		rec := serveUpload(d,
			uploadRequest("/v1/artifact/upload?version=v1.0.0&batch=b1&filename="+fn, testUploadToken, []byte("x")))
		if rec.Code != http.StatusBadRequest {
			t.Errorf("filename %q: status = %d, want 400", fn, rec.Code)
		}
	}
	// Nothing must have been written anywhere under the root.
	_ = filepath.Walk(dir, func(p string, info os.FileInfo, err error) error {
		if err == nil && info != nil && !info.IsDir() {
			t.Errorf("unexpected file written: %s", p)
		}
		return nil
	})
}

func TestArtifactUploadHappyPath(t *testing.T) {
	d, dir := uploadDeps(t)
	data := []byte("a release tarball's bytes")
	sum := sha256.Sum256(data)
	hexsum := hex.EncodeToString(sum[:])

	r := uploadRequest("/v1/artifact/upload?version=v1.2.3&batch=20260618-1430Z&filename=c3-v1.2.3-linux-x64.tar.gz", testUploadToken, data)
	r.Header.Set("X-Artifact-Sha256", hexsum)
	rec := serveUpload(d, r)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), hexsum) {
		t.Errorf("response missing sha256: %s", rec.Body.String())
	}

	dest := filepath.Join(dir, "v1.2.3", "20260618-1430Z", "c3-v1.2.3-linux-x64.tar.gz")
	got, err := os.ReadFile(dest)
	if err != nil {
		t.Fatalf("artifact not stored: %v", err)
	}
	if !bytes.Equal(got, data) {
		t.Errorf("stored bytes differ from upload")
	}
}

func TestArtifactUploadChecksumMismatch(t *testing.T) {
	d, dir := uploadDeps(t)
	r := uploadRequest("/v1/artifact/upload?version=v1.0.0&batch=b1&filename=c3.tar.gz", testUploadToken, []byte("payload"))
	r.Header.Set("X-Artifact-Sha256", strings.Repeat("0", 64))
	rec := serveUpload(d, r)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
	// A mismatched upload must not leave the committed file behind.
	if _, err := os.Stat(filepath.Join(dir, "v1.0.0", "b1", "c3.tar.gz")); !os.IsNotExist(err) {
		t.Errorf("checksum-mismatch upload left a file behind")
	}
}

func TestArtifactUploadTooLarge(t *testing.T) {
	dir := t.TempDir()
	cfg, err := config.LoadFrom(func(k string) string {
		switch k {
		case config.EnvArtifactUploadToken:
			return testUploadToken
		case config.EnvArtifactDir:
			return dir
		case config.EnvArtifactMaxBytes:
			return "8"
		default:
			return ""
		}
	})
	if err != nil {
		t.Fatalf("config: %v", err)
	}
	rec := serveUpload(Deps{Config: cfg},
		uploadRequest("/v1/artifact/upload?version=v1.0.0&batch=b1&filename=c3.tar.gz", testUploadToken, bytes.Repeat([]byte("x"), 64)))
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413", rec.Code)
	}
}

func TestArtifactUploadMethodGuard(t *testing.T) {
	d, _ := uploadDeps(t)
	rec := httptest.NewRecorder()
	allowPOST(handleArtifactUpload(d)).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/v1/artifact/upload", nil))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want 405", rec.Code)
	}
}
