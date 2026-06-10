# Contributing to c3

## Branch protection

The `main` branch is protected. Before merging a pull request, the following GitHub
status checks must all pass (set via **Settings → Branches → Add branch protection
rule**):

| Required check | What it runs |
|---|---|
| `lint` | `pnpm lint` + `pnpm i18n:check` |
| `typecheck` | `pnpm typecheck` |
| `build` | `pnpm build` |
| `e2e` | `pnpm e2e` (build + server boot + WebSocket e2e suite) |

### How to enable

1. Go to [Settings → Branches](https://github.com/sequencestream/claude-code-center/settings/branches)
2. Click **Add rule** (or edit the existing rule for `main`)
3. Under **Branch name pattern**: `main`
4. Under **Protect matching branches**:
   - [x] **Require a pull request before merging**
   - [x] **Require status checks to pass before merging**
   - From the check list, tick: `lint`, `typecheck`, `build`, `e2e`
5. (Recommended) **Require branches to be up-to-date** — this ensures the PR
   includes the latest `main` before merging.
6. Click **Create** / **Save**.

> Once enabled, every PR triggers the full CI pipeline. The four status checks
> run in parallel and are visible on the PR's **Checks** tab and at the bottom
> of the PR merge box.

## Pull request checklist

Every PR should self-certify against the checklist in
[.github/pull_request_template.md](.github/pull_request_template.md).
Key points:

- `pnpm typecheck` / `pnpm lint` / `pnpm test` pass
- Specs kept in sync with code
- i18n: no raw text in `web/`, all new user-facing strings use `t()`/`$t()`,
  `pnpm i18n:check` green on en + zh
