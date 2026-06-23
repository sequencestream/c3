package httpapi

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// maxArtifactSegment bounds a single path segment (version / batch / filename) to
// a safe charset. It must start with an alphanumeric, so "." and ".." can never
// be a whole segment — together with the basename check this forbids traversal.
var artifactSegment = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]*$`)

// handleArtifactUpload streams the request body to <dir>/<version>/<batch>/<file>.
// It writes to a temp file and renames on success so a failed or truncated upload
// never leaves a half-written artifact in place. An X-Artifact-Sha256 header, when
// present, is verified against the bytes received before the file is committed.
func handleArtifactUpload(d Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		cfg := d.Config
		if cfg == nil || !cfg.ArtifactUploadConfigured() {
			writeError(w, http.StatusServiceUnavailable, "unavailable", "artifact upload is not configured")
			return
		}
		if !artifactAuthorized(r, cfg.ArtifactUploadToken) {
			writeError(w, http.StatusUnauthorized, "unauthenticated", "invalid or missing upload token")
			return
		}

		q := r.URL.Query()
		version := strings.TrimSpace(q.Get("version"))
		batch := strings.TrimSpace(q.Get("batch"))
		filename := strings.TrimSpace(q.Get("filename"))
		if !artifactSegment.MatchString(version) {
			writeError(w, http.StatusBadRequest, "invalid_request", "version is missing or malformed")
			return
		}
		if !artifactSegment.MatchString(batch) {
			writeError(w, http.StatusBadRequest, "invalid_request", "batch is missing or malformed")
			return
		}
		// filename must be a bare basename matching the safe charset: no separators,
		// no "." / "..", nothing that could climb out of the destination directory.
		if filename != filepath.Base(filename) || !artifactSegment.MatchString(filename) {
			writeError(w, http.StatusBadRequest, "invalid_request", "filename is missing or malformed")
			return
		}

		// Belt-and-braces: resolve the destination and confirm it stays under the
		// configured root even though the segment validation already guarantees it.
		root := filepath.Clean(cfg.ArtifactDir)
		dir := filepath.Join(root, version, batch)
		dest := filepath.Join(dir, filename)
		if !strings.HasPrefix(dest, root+string(os.PathSeparator)) {
			writeError(w, http.StatusBadRequest, "invalid_request", "resolved path escapes the artifact root")
			return
		}

		if err := os.MkdirAll(dir, 0o755); err != nil {
			slog.Error("artifact upload mkdir failed", "err", err)
			writeError(w, http.StatusInternalServerError, "io_error", "could not create destination directory")
			return
		}

		body := http.MaxBytesReader(w, r.Body, cfg.ArtifactMaxBytes)
		tmp, err := os.CreateTemp(dir, "."+filename+".part-*")
		if err != nil {
			slog.Error("artifact upload tempfile failed", "err", err)
			writeError(w, http.StatusInternalServerError, "io_error", "could not create temp file")
			return
		}
		tmpName := tmp.Name()
		committed := false
		defer func() {
			_ = tmp.Close()
			if !committed {
				_ = os.Remove(tmpName)
			}
		}()

		hasher := sha256.New()
		n, err := io.Copy(io.MultiWriter(tmp, hasher), body)
		if err != nil {
			var maxErr *http.MaxBytesError
			if errors.As(err, &maxErr) {
				writeError(w, http.StatusRequestEntityTooLarge, "too_large", "artifact exceeds the configured size limit")
				return
			}
			slog.Error("artifact upload write failed", "err", err)
			writeError(w, http.StatusBadRequest, "io_error", "could not read request body")
			return
		}
		sum := hex.EncodeToString(hasher.Sum(nil))

		if want := strings.ToLower(strings.TrimSpace(r.Header.Get("X-Artifact-Sha256"))); want != "" {
			if subtle.ConstantTimeCompare([]byte(want), []byte(sum)) != 1 {
				writeError(w, http.StatusBadRequest, "checksum_mismatch", "sha256 does not match X-Artifact-Sha256")
				return
			}
		}

		if err := tmp.Close(); err != nil {
			slog.Error("artifact upload close failed", "err", err)
			writeError(w, http.StatusInternalServerError, "io_error", "could not finalize temp file")
			return
		}
		if err := os.Rename(tmpName, dest); err != nil {
			slog.Error("artifact upload rename failed", "err", err)
			writeError(w, http.StatusInternalServerError, "io_error", "could not store artifact")
			return
		}
		committed = true
		invalidateArtifactCache(d, version)

		rel := filepath.ToSlash(filepath.Join(version, batch, filename))
		slog.Info("artifact uploaded", "version", version, "batch", batch, "filename", filename, "bytes", n)
		writeJSON(w, http.StatusOK, map[string]any{"path": rel, "size": n, "sha256": sum})
	}
}

// artifactAuthorized constant-time compares the request's bearer token to the
// configured upload token.
func artifactAuthorized(r *http.Request, token string) bool {
	const prefix = "Bearer "
	h := r.Header.Get("Authorization")
	if !strings.HasPrefix(h, prefix) {
		return false
	}
	got := strings.TrimSpace(h[len(prefix):])
	return subtle.ConstantTimeCompare([]byte(got), []byte(token)) == 1
}
