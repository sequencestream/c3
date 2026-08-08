// Several server tests drive the REAL `git` CLI against throwaway repos, so their
// outcome must not depend on the machine's git configuration. Two host defaults
// break them:
//   - a CI runner has no user identity, so `git commit` fails with
//     "Author identity unknown";
//   - `init.defaultBranch` still defaults to `master` on many hosts, so a repo (or
//     bare remote) created without `-b main` lands on `master` and every helper
//     that assumes a `main` baseline silently pushes/clones the wrong branch.
//
// `GIT_CONFIG_COUNT` + `GIT_CONFIG_KEY_<n>` / `GIT_CONFIG_VALUE_<n>` inject config
// into every git process spawned by this test run — the ones tests spawn directly
// AND the ones the server code under test spawns — without touching any file on
// disk. Signing is disabled because a signing key would make commits interactive.
const gitConfig: ReadonlyArray<readonly [string, string]> = [
  ['init.defaultBranch', 'main'],
  ['user.name', 'c3 test'],
  ['user.email', 'test@c3.invalid'],
  ['commit.gpgsign', 'false'],
  ['tag.gpgsign', 'false'],
]

process.env.GIT_CONFIG_COUNT = String(gitConfig.length)
gitConfig.forEach(([key, value], i) => {
  process.env[`GIT_CONFIG_KEY_${i}`] = key
  process.env[`GIT_CONFIG_VALUE_${i}`] = value
})
