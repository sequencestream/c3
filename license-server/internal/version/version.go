// Package version exposes the license-server build version.
package version

// Version is the license-server semantic version. It is overridable at build
// time via -ldflags "-X .../version.Version=x.y.z" for release binaries.
var Version = "0.1.0-dev"
