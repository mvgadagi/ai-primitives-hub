# ADR-0011: One Shared Version for the npm Packages and the VS Code Extension

**Status:** Accepted

## Context

`@ai-primitives-hub/core`, `infra`, `app` and `cli` and the VS Code extension
are built from the same commit, and the extension bundles core, infra and app
from source. They were still versioned and released separately:

- The packages use `packages-release.yml`. It bumps `packages/*/package.json`
  in a release pull request, publishes to npm, and tags
  `packages/<name>-v<version>` (0.2.1 when this ADR was written).
- The extension uses `vscode-extension-secure-publish.yml`. Its version comes
  from the GitHub Release tag `v<version>` and is set only inside the CI run,
  so `apps/vscode-extension/package.json` stayed at 0.0.3 while the
  Marketplace had 0.0.44.

Because of this, nobody can tell which CLI goes with which extension release, a bug report
needs two version numbers, and the repository does not show what was shipped.
It also hid a scaffold bug: new collection repositories asked for
`@ai-primitives-hub/cli` `^0.1.0`, which never resolves to 0.2.x.

Constraints:

- Marketplace, Open VSX and npm versions can only increase.
- The VS Code Marketplace accepts only `major.minor.patch`; a semver
  prerelease suffix such as `-alpha.1` is rejected.

## Decision

- core, infra, app, cli and the extension share one version, stored in their
  `package.json` files and released together.
- `@prompt-registry/collection-scripts` (`lib/`) is not part of it. It is
  legacy (its tools now live in the CLI), is already at 1.x, and is pinned by
  existing collection repositories with `^1.x`.
- The version committed on `main` is always a stable `major.minor.patch`.
  Prereleases are npm-only and the extension does not publish them.
- A release is tagged once as `v<version>`. Per-package tags are not created
  for unified releases.
- The scaffold template depends on `@ai-primitives-hub/cli` `^<shared version>`.
- `scripts/check-versions.mjs` enforces the above in CI.
- The first unified release is 0.3.0, the next minor above both 0.2.1 (npm)
  and 0.0.44 (Marketplace).

## Consequences

- **Positive:** one version identifies a release across npm, the Marketplace
  and Open VSX; the repository shows the shipped version.
- **Positive:** new scaffolded repositories get the current CLI.
- **Negative:** the extension version jumps from 0.0.44 to 0.3.0, and every
  release bumps all five packages even when only one changed.
- **Negative:** collection repositories scaffolded earlier keep their old CLI
  range until their owners update it.
- The single release workflow, and retiring the extension's `version:bump:*`
  scripts, follow in later changes.
