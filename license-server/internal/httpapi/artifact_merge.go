package httpapi

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"sort"
	"strings"
	"sync"
)

// mergeMu serializes the read-modify-write of mergeable index files so that two
// uploads racing into the same batch can't interleave and drop each other's entries.
var mergeMu sync.Mutex

// isMergeableIndex reports whether an uploaded filename is an aggregate index that
// must accumulate across per-target uploads rather than be overwritten wholesale.
func isMergeableIndex(filename string) bool {
	return filename == "manifest.json" || filename == "SHA256SUMS"
}

// commitMergedIndex merges the freshly uploaded file at tmpName into the existing
// dest (union by target / by filename, incoming wins on conflict) and atomically
// replaces dest with the result. The raw upload temp is removed on success. It
// returns the stored file's sha256 (hex) and byte size.
func commitMergedIndex(dir, filename, dest, tmpName string) (string, int64, error) {
	mergeMu.Lock()
	defer mergeMu.Unlock()

	incoming, err := os.ReadFile(tmpName)
	if err != nil {
		return "", 0, err
	}
	existing, err := os.ReadFile(dest)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return "", 0, err
	}
	merged, err := mergeIndexContent(filename, existing, incoming)
	if err != nil {
		return "", 0, err
	}

	out, err := os.CreateTemp(dir, "."+filename+".merged-*")
	if err != nil {
		return "", 0, err
	}
	outName := out.Name()
	if _, err := out.Write(merged); err != nil {
		out.Close()
		os.Remove(outName)
		return "", 0, err
	}
	if err := out.Close(); err != nil {
		os.Remove(outName)
		return "", 0, err
	}
	if err := os.Rename(outName, dest); err != nil {
		os.Remove(outName)
		return "", 0, err
	}
	os.Remove(tmpName)

	sum := sha256.Sum256(merged)
	return hex.EncodeToString(sum[:]), int64(len(merged)), nil
}

func mergeIndexContent(filename string, existing, incoming []byte) ([]byte, error) {
	switch filename {
	case "manifest.json":
		return mergeManifestJSON(existing, incoming)
	case "SHA256SUMS":
		return mergeChecksums(existing, incoming), nil
	default:
		return incoming, nil
	}
}

// mergeManifestJSON unions the artifacts arrays of the existing and incoming
// manifests by target (incoming wins on conflict), keeping every other top-level
// field from the incoming manifest. Unknown fields pass through verbatim so the
// schema can evolve without the merge needing to know about it.
func mergeManifestJSON(existing, incoming []byte) ([]byte, error) {
	var inc map[string]any
	if err := json.Unmarshal(incoming, &inc); err != nil {
		return nil, errInvalidArtifactManifest
	}
	if len(existing) > 0 {
		var old map[string]any
		if err := json.Unmarshal(existing, &old); err == nil {
			inc["artifacts"] = unionArtifactsByTarget(
				artifactObjects(old["artifacts"]),
				artifactObjects(inc["artifacts"]),
			)
		}
	}
	out, err := json.MarshalIndent(inc, "", "  ")
	if err != nil {
		return nil, err
	}
	return append(out, '\n'), nil
}

func artifactObjects(v any) []map[string]any {
	list, _ := v.([]any)
	out := make([]map[string]any, 0, len(list))
	for _, el := range list {
		if obj, ok := el.(map[string]any); ok {
			out = append(out, obj)
		}
	}
	return out
}

// unionArtifactsByTarget keeps existing artifacts in their original order, overlays
// incoming ones (incoming wins for a shared target), and appends incoming-only
// targets after. Entries without a string target are dropped.
func unionArtifactsByTarget(old, incoming []map[string]any) []any {
	order := make([]string, 0, len(old)+len(incoming))
	byTarget := make(map[string]map[string]any, len(old)+len(incoming))
	add := func(arts []map[string]any) {
		for _, a := range arts {
			t, _ := a["target"].(string)
			if t == "" {
				continue
			}
			if _, ok := byTarget[t]; !ok {
				order = append(order, t)
			}
			byTarget[t] = a
		}
	}
	add(old)
	add(incoming)
	out := make([]any, 0, len(order))
	for _, t := range order {
		out = append(out, byTarget[t])
	}
	return out
}

// mergeChecksums unions SHA256SUMS lines by their filename column (incoming wins),
// emitting them in deterministic filename order. Blank lines are dropped.
func mergeChecksums(existing, incoming []byte) []byte {
	byName := make(map[string]string)
	add := func(b []byte) {
		for _, raw := range strings.Split(string(b), "\n") {
			line := strings.TrimRight(raw, "\r")
			if strings.TrimSpace(line) == "" {
				continue
			}
			fields := strings.Fields(line)
			byName[fields[len(fields)-1]] = line
		}
	}
	add(existing)
	add(incoming)
	names := make([]string, 0, len(byName))
	for name := range byName {
		names = append(names, name)
	}
	sort.Strings(names)
	var sb strings.Builder
	for _, name := range names {
		sb.WriteString(byName[name])
		sb.WriteByte('\n')
	}
	return []byte(sb.String())
}
