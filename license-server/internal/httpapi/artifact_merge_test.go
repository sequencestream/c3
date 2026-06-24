package httpapi

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// uploadIndex POSTs an index file (manifest.json / SHA256SUMS) to a fixed batch and
// asserts a 200.
func uploadIndex(t *testing.T, d Deps, filename string, body []byte) {
	t.Helper()
	sum := sha256.Sum256(body)
	r := uploadRequest(
		"/v1/artifact/upload?version=v0.4.2&batch=20260623-1527Z&filename="+filename,
		testUploadToken, body)
	r.Header.Set("X-Artifact-Sha256", hex.EncodeToString(sum[:]))
	if rec := serveUpload(d, r); rec.Code != http.StatusOK {
		t.Fatalf("upload %s = %d %s", filename, rec.Code, rec.Body.String())
	}
}

func manifestBytes(t *testing.T, targets ...artifactManifestItem) []byte {
	t.Helper()
	b, err := json.Marshal(artifactManifest{Artifacts: targets})
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func readStoredManifest(t *testing.T, dir string) []artifactManifestItem {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(dir, "v0.4.2", "20260623-1527Z", "manifest.json"))
	if err != nil {
		t.Fatalf("read merged manifest: %v", err)
	}
	var m artifactManifest
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatalf("merged manifest is invalid json: %v\n%s", err, b)
	}
	return m.Artifacts
}

func TestArtifactUploadMergesManifestAcrossTargets(t *testing.T) {
	d, dir := uploadDeps(t)

	linux := artifactManifestItem{Target: "linux-x64", File: "c3-v0.4.2-linux-x64.tar.gz", SHA256: "aa", Bytes: 1}
	macos := artifactManifestItem{Target: "macos-arm64", File: "c3-v0.4.2-macos-arm64.tar.gz", SHA256: "bb", Bytes: 2}
	win := artifactManifestItem{Target: "windows-x64", File: "c3-v0.4.2-windows-x64.zip", SHA256: "cc", Bytes: 3}

	// Three separate per-target uploads into the same batch — the classic split-build flow.
	uploadIndex(t, d, "manifest.json", manifestBytes(t, linux))
	uploadIndex(t, d, "manifest.json", manifestBytes(t, macos))
	uploadIndex(t, d, "manifest.json", manifestBytes(t, win))

	got := readStoredManifest(t, dir)
	if len(got) != 3 {
		t.Fatalf("merged manifest has %d artifacts, want 3: %+v", len(got), got)
	}
	seen := map[string]string{}
	for _, a := range got {
		seen[a.Target] = a.SHA256
	}
	for _, want := range []artifactManifestItem{linux, macos, win} {
		if seen[want.Target] != want.SHA256 {
			t.Errorf("target %s sha = %q, want %q", want.Target, seen[want.Target], want.SHA256)
		}
	}
}

func TestArtifactUploadManifestReuploadOverwritesSameTarget(t *testing.T) {
	d, dir := uploadDeps(t)

	uploadIndex(t, d, "manifest.json",
		manifestBytes(t, artifactManifestItem{Target: "linux-x64", File: "old.tar.gz", SHA256: "old", Bytes: 1}))
	// Re-uploading the same target replaces just that entry, not the whole file.
	uploadIndex(t, d, "manifest.json",
		manifestBytes(t, artifactManifestItem{Target: "linux-x64", File: "new.tar.gz", SHA256: "new", Bytes: 9}))

	got := readStoredManifest(t, dir)
	if len(got) != 1 || got[0].SHA256 != "new" || got[0].File != "new.tar.gz" {
		t.Fatalf("re-upload did not overwrite the shared target: %+v", got)
	}
}

func TestArtifactUploadMergesChecksumsAcrossTargets(t *testing.T) {
	d, dir := uploadDeps(t)

	uploadIndex(t, d, "SHA256SUMS", []byte("aa  c3-v0.4.2-linux-x64.tar.gz\n"))
	uploadIndex(t, d, "SHA256SUMS", []byte("cc  c3-v0.4.2-windows-x64.zip\n"))
	// Re-upload of the linux line must replace it, not duplicate it.
	uploadIndex(t, d, "SHA256SUMS", []byte("dd  c3-v0.4.2-linux-x64.tar.gz\n"))

	b, err := os.ReadFile(filepath.Join(dir, "v0.4.2", "20260623-1527Z", "SHA256SUMS"))
	if err != nil {
		t.Fatalf("read merged SHA256SUMS: %v", err)
	}
	lines := strings.Split(strings.TrimSpace(string(b)), "\n")
	if len(lines) != 2 {
		t.Fatalf("merged SHA256SUMS has %d lines, want 2:\n%s", len(lines), b)
	}
	joined := string(b)
	if !strings.Contains(joined, "dd  c3-v0.4.2-linux-x64.tar.gz") ||
		!strings.Contains(joined, "cc  c3-v0.4.2-windows-x64.zip") ||
		strings.Contains(joined, "aa  ") {
		t.Errorf("unexpected merged SHA256SUMS:\n%s", b)
	}
}

// TestArtifactUploadMergeConcurrent fires many simultaneous per-target manifest
// uploads into the same batch and asserts every entry survives — i.e. the merge
// read-modify-write is serialized and no update is lost. Run with -race to catch
// any unsynchronized access.
func TestArtifactUploadMergeConcurrent(t *testing.T) {
	d, dir := uploadDeps(t)

	const n = 24
	var wg sync.WaitGroup
	wg.Add(n)
	for i := range n {
		go func(i int) {
			defer wg.Done()
			target := fmt.Sprintf("t%02d-x64", i)
			body := manifestBytes(t, artifactManifestItem{
				Target: target,
				File:   fmt.Sprintf("c3-v0.4.2-%s.tar.gz", target),
				SHA256: fmt.Sprintf("%02d", i),
				Bytes:  int64(i),
			})
			uploadIndex(t, d, "manifest.json", body)
		}(i)
	}
	wg.Wait()

	got := readStoredManifest(t, dir)
	if len(got) != n {
		t.Fatalf("merged manifest has %d artifacts after %d concurrent uploads, want %d", len(got), n, n)
	}
}

func TestArtifactUploadMergeRejectsMalformedManifest(t *testing.T) {
	d, _ := uploadDeps(t)
	r := uploadRequest(
		"/v1/artifact/upload?version=v0.4.2&batch=20260623-1527Z&filename=manifest.json",
		testUploadToken, []byte("{not json"))
	if rec := serveUpload(d, r); rec.Code != http.StatusInternalServerError {
		t.Fatalf("malformed manifest upload = %d, want 500", rec.Code)
	}
}
