// Permanent committed stub — an empty asset map. This is what esbuild (`pnpm build`),
// dev (`tsx`), and typecheck consume; with an empty map, the static handler falls back
// to serving web/dist from the filesystem (see wiring/static-assets.ts).
//
// The Bun `--compile` path does NOT write this file. It redirects this import to the
// generated dist/static-embed.generated.ts at build time via an onResolve plugin
// (server/scripts/release/build-target.mjs), so multiple targets build in parallel
// without ever mutating src/. Do not generate real assets here.
export const STATIC_ASSETS: ReadonlyMap<string, { body: string; mime: string }> = new Map()
