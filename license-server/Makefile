# license-server build path. The Go binary embeds web/dist (committed), so
# `make build` alone produces a runnable single binary; `make web` regenerates
# the embedded frontend from web/src before building a release artifact.

BINARY    ?= dist/license-server
VERSION   ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
LDFLAGS   := -s -w -X github.com/sequencestream/code-creative-center/license-server/internal/version.Version=$(VERSION)

# Target a Linux server build by default (cross-compiled, static-ish).
GOOS      ?= linux
GOARCH    ?= amd64

.PHONY: all build release web test vet fmt run clean

all: build

## build: compile the single binary for Linux server (embeds the committed web/dist)
build:
	mkdir -p dist
	CGO_ENABLED=0 GOOS=$(GOOS) GOARCH=$(GOARCH) go build -ldflags "$(LDFLAGS)" -o $(BINARY) ./cmd/license-server

## release: rebuild the embedded frontend, then compile the binary
release: web build

## web: build the Vue frontend into web/dist (embedded by the Go binary)
web:
	cd web && npm install && npm run build

## test: run unit/build checks (set C3_LS_TEST_DATABASE_URL to include live DB tests)
test:
	go test ./...

vet:
	go vet ./...

fmt:
	gofmt -w .

## run: build for the host platform and start the server (local dev)
run:
	mkdir -p dist
	go build -ldflags "$(LDFLAGS)" -o $(BINARY) ./cmd/license-server
	$(BINARY)

clean:
	rm -rf dist
