package httpapi

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/sequencestream/code-creative-center/license-server/internal/cache"
)

const artifactCacheTTL = 30 * time.Second

var errInvalidArtifactManifest = errors.New("invalid artifact manifest")

var (
	stableArtifactVersion = regexp.MustCompile(`^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$`)
	artifactBatch         = regexp.MustCompile(`^[0-9]{8}-[0-9]{4}Z$`)
)

type artifactManifest struct {
	Artifacts []artifactManifestItem `json:"artifacts"`
}

type artifactManifestItem struct {
	Target string `json:"target"`
	File   string `json:"file"`
	SHA256 string `json:"sha256"`
	Bytes  int64  `json:"bytes"`
}

type artifactTarget struct {
	Target string `json:"target"`
	File   string `json:"file"`
	SHA256 string `json:"sha256"`
	Bytes  int64  `json:"bytes"`
}

type artifactRelease struct {
	Version string           `json:"version"`
	Batch   string           `json:"batch"`
	Targets []artifactTarget `json:"targets"`
}

type artifactCached struct {
	Release artifactRelease
	Expires time.Time
}

// mountArtifact registers the write endpoint and the anonymous public read API.
func mountArtifact(mux *http.ServeMux, d Deps) {
	mux.HandleFunc("/v1/artifact/upload", allowPOST(handleArtifactUpload(d)))
	mux.HandleFunc("/v1/artifact/latest", allowGET(handleArtifactLatest(d)))
	mux.HandleFunc("/v1/artifact/download", allowGET(handleArtifactDownload(d)))
	mux.HandleFunc("/v1/artifact/", allowGET(handleArtifactTargets(d)))
}

func handleArtifactLatest(d Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !artifactReadAvailable(w, d) {
			return
		}
		release, err := artifactLatest(d)
		if errors.Is(err, os.ErrNotExist) {
			writeError(w, http.StatusNotFound, "not_found", "no released artifacts found")
			return
		}
		if err != nil {
			writeError(w, http.StatusInternalServerError, "io_error", "could not read artifact store")
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"version": release.Version, "batch": release.Batch})
	}
}

func handleArtifactTargets(d Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !artifactReadAvailable(w, d) {
			return
		}
		const prefix = "/v1/artifact/"
		path := strings.TrimPrefix(r.URL.Path, prefix)
		if !strings.HasSuffix(path, "/targets") {
			writeError(w, http.StatusNotFound, "not_found", "artifact endpoint not found")
			return
		}
		version := strings.TrimSuffix(path, "/targets")
		if !validArtifactVersion(version) {
			writeError(w, http.StatusBadRequest, "invalid_request", "version is missing or malformed")
			return
		}
		release, err := artifactForVersion(d, version)
		if errors.Is(err, os.ErrNotExist) {
			writeError(w, http.StatusNotFound, "not_found", "artifact version not found")
			return
		}
		if err != nil {
			writeError(w, http.StatusInternalServerError, "io_error", "could not read artifact store")
			return
		}
		writeJSON(w, http.StatusOK, release)
	}
}

func handleArtifactDownload(d Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !artifactReadAvailable(w, d) {
			return
		}
		q := r.URL.Query()
		version := strings.TrimSpace(q.Get("version"))
		target := strings.TrimSpace(q.Get("os_arch"))
		kind := strings.TrimSpace(q.Get("type"))
		if !validArtifactVersion(version) || !artifactSegment.MatchString(target) || (kind != "binary" && kind != "sha256") {
			writeError(w, http.StatusBadRequest, "invalid_request", "version, os_arch, or type is malformed")
			return
		}
		release, err := artifactForVersion(d, version)
		if errors.Is(err, os.ErrNotExist) {
			writeError(w, http.StatusNotFound, "not_found", "artifact version not found")
			return
		}
		if err != nil {
			writeError(w, http.StatusInternalServerError, "io_error", "could not read artifact store")
			return
		}
		var selected *artifactTarget
		for i := range release.Targets {
			if release.Targets[i].Target == target {
				selected = &release.Targets[i]
				break
			}
		}
		if selected == nil {
			writeError(w, http.StatusNotFound, "not_found", "artifact target not found")
			return
		}
		filename := selected.File
		if kind == "sha256" {
			filename += ".sha256"
		}
		path, ok := artifactPath(d.Config.ArtifactDir, release.Version, release.Batch, filename)
		if !ok {
			writeError(w, http.StatusBadRequest, "invalid_request", "resolved path escapes the artifact root")
			return
		}
		f, err := os.Open(path)
		if errors.Is(err, os.ErrNotExist) {
			writeError(w, http.StatusNotFound, "not_found", "artifact file not found")
			return
		}
		if err != nil {
			writeError(w, http.StatusInternalServerError, "io_error", "could not read artifact file")
			return
		}
		defer f.Close()
		if kind == "binary" {
			w.Header().Set("Content-Type", "application/octet-stream")
			w.Header().Set("Content-Disposition", `attachment; filename="`+filename+`"`)
		} else {
			w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		}
		_, _ = io.Copy(w, f)
	}
}

func artifactReadAvailable(w http.ResponseWriter, d Deps) bool {
	if d.Config == nil || !d.Config.ArtifactReadConfigured() {
		writeError(w, http.StatusServiceUnavailable, "unavailable", "artifact store is not configured")
		return false
	}
	return true
}

func artifactLatest(d Deps) (artifactRelease, error) {
	const key = "artifact:latest"
	if release, ok := getArtifactCached(d, key); ok {
		return release, nil
	}
	entries, err := os.ReadDir(d.Config.ArtifactDir)
	if err != nil {
		return artifactRelease{}, err
	}
	versions := make([]string, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() && validArtifactVersion(entry.Name()) {
			versions = append(versions, entry.Name())
		}
	}
	sort.Slice(versions, func(i, j int) bool { return compareArtifactVersion(versions[i], versions[j]) > 0 })
	for _, version := range versions {
		release, err := artifactForVersion(d, version)
		if err == nil {
			putArtifactCached(d, key, release)
			return release, nil
		}
		if !errors.Is(err, os.ErrNotExist) {
			return artifactRelease{}, err
		}
	}
	return artifactRelease{}, os.ErrNotExist
}

func artifactForVersion(d Deps, version string) (artifactRelease, error) {
	key := "artifact:targets:" + version
	if release, ok := getArtifactCached(d, key); ok {
		return release, nil
	}
	root := filepath.Clean(d.Config.ArtifactDir)
	versionDir, ok := artifactPath(root, version)
	if !ok {
		return artifactRelease{}, os.ErrNotExist
	}
	entries, err := os.ReadDir(versionDir)
	if err != nil {
		return artifactRelease{}, err
	}
	batches := make([]string, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() && artifactBatch.MatchString(entry.Name()) {
			batches = append(batches, entry.Name())
		}
	}
	sort.Sort(sort.Reverse(sort.StringSlice(batches)))
	for _, batch := range batches {
		manifestPath, ok := artifactPath(root, version, batch, "manifest.json")
		if !ok {
			continue
		}
		manifest, err := readArtifactManifest(manifestPath)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if errors.Is(err, errInvalidArtifactManifest) {
			continue
		}
		if err != nil {
			return artifactRelease{}, err
		}
		release := artifactRelease{Version: version, Batch: batch, Targets: manifest}
		putArtifactCached(d, key, release)
		return release, nil
	}
	return artifactRelease{}, os.ErrNotExist
}

func readArtifactManifest(path string) ([]artifactTarget, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	var manifest artifactManifest
	if err := json.NewDecoder(io.LimitReader(f, 4<<20)).Decode(&manifest); err != nil {
		return nil, errInvalidArtifactManifest
	}
	targets := make([]artifactTarget, 0, len(manifest.Artifacts))
	seen := make(map[string]struct{}, len(manifest.Artifacts))
	for _, item := range manifest.Artifacts {
		if !artifactSegment.MatchString(item.Target) || item.File != filepath.Base(item.File) || !artifactSegment.MatchString(item.File) || item.Bytes < 0 {
			return nil, errInvalidArtifactManifest
		}
		if _, ok := seen[item.Target]; ok {
			return nil, errInvalidArtifactManifest
		}
		seen[item.Target] = struct{}{}
		targets = append(targets, artifactTarget{Target: item.Target, File: item.File, SHA256: item.SHA256, Bytes: item.Bytes})
	}
	if len(targets) == 0 {
		return nil, errInvalidArtifactManifest
	}
	return targets, nil
}

func validArtifactVersion(version string) bool { return stableArtifactVersion.MatchString(version) }

func compareArtifactVersion(a, b string) int {
	pa := stableArtifactVersion.FindStringSubmatch(a)
	pb := stableArtifactVersion.FindStringSubmatch(b)
	for i := 1; i <= 3; i++ {
		if pa[i] == pb[i] {
			continue
		}
		if len(pa[i]) != len(pb[i]) {
			return len(pa[i]) - len(pb[i])
		}
		if pa[i] > pb[i] {
			return 1
		}
		return -1
	}
	return 0
}

func artifactPath(root string, segments ...string) (string, bool) {
	cleanRoot := filepath.Clean(root)
	path := filepath.Join(append([]string{cleanRoot}, segments...)...)
	rel, err := filepath.Rel(cleanRoot, path)
	return path, err == nil && rel != "." && rel != ".." && !strings.HasPrefix(rel, ".."+string(os.PathSeparator))
}

func getArtifactCached(d Deps, key string) (artifactRelease, bool) {
	if d.Caches == nil {
		return artifactRelease{}, false
	}
	v, ok := d.Caches.Get(cache.NameArtifact).Get(key)
	if !ok {
		return artifactRelease{}, false
	}
	entry, ok := v.(artifactCached)
	if !ok || !time.Now().Before(entry.Expires) {
		d.Caches.Get(cache.NameArtifact).Invalidate(key)
		return artifactRelease{}, false
	}
	return entry.Release, true
}

func putArtifactCached(d Deps, key string, release artifactRelease) {
	if d.Caches != nil {
		d.Caches.Get(cache.NameArtifact).Put(key, artifactCached{Release: release, Expires: time.Now().Add(artifactCacheTTL)})
	}
}

func invalidateArtifactCache(d Deps, version string) {
	if d.Caches == nil {
		return
	}
	c := d.Caches.Get(cache.NameArtifact)
	c.Invalidate("artifact:latest")
	c.Invalidate("artifact:targets:" + version)
}
