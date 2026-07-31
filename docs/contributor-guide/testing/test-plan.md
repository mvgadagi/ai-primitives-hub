# AI Primitives Hub Full Test Plan

All 19 plans covering the manual verification surface across the extension, the CLI, and the published packages.

**This page is not the release gate — [Golden Path Test Cases](./golden-path.md) is.** Run the golden path for every release. Come here when a PR touches a specific area and you want something concrete to run, or when the whole surface needs reviewing end to end.

| Page | Scope |
|---|---|
| [Golden Path Test Cases](./golden-path.md) | The three mandatory scenarios — start here |
| [Testing](../testing.md) | How to run the automated suites |
| [Validation](../validation.md) | Local CI simulation, per-commit checks |
| [Releasing](../releasing.md) | Version bump and publish mechanics |
| **Full Test Plan** (this page) | Area-by-area manual coverage |

## Relationship To The Golden Path

Rows marked **⭐** are part of the golden path. The [golden path page](./golden-path.md) sequences them into three chained scenarios with the setup they need; here they sit in their home plan so an area-focused run does not miss them.

| Golden scenario | Plans it draws on |
|---|---|
| G1 — Collection user | TP-01, TP-04, TP-05, TP-07 |
| G2 — Collection author | TP-14, TP-05 |
| G3 — Update | TP-10 |

---

## Host Coverage — VS Code and Kiro

The extension does not just *install for* Kiro and VS Code — it **runs inside both**. Kiro is a VS Code fork, so the same VSIX is loaded by both editors and has to behave correctly in each. Every plan below that touches the filesystem or the UI is therefore run twice: once with the extension running in VS Code, once with it running in Kiro.

### How the host is detected

`resolveHostApp` (in `packages/infra/src/host-app/host-app-target.ts`) matches the lowercased combination of `vscode.env.appName` and `vscode.env.uriScheme` against ordered rules:

| Signal contains | Resolved target |
|---|---|
| `kiro` | `kiro` |
| `windsurf` or `devin` | `windsurf` |
| `insiders` | `vscode-insiders` |
| anything else | `vscode` (the default `.github/` layout) |

**The failure mode to watch for:** detection falls back to `vscode` when a host is unrecognized. In Kiro that fallback is silent and wrong — content lands in `.github/` instead of `.kiro/`. The extension logs the resolved target on every detection (`[host-app] detectHostApp: appName="…", uriScheme="…" -> …`), so the Output channel is the fastest way to confirm the host was identified correctly.

### Which plans run per host

| Plan | VS Code | Kiro | Note |
|---|---|---|---|
| TP-01 Fresh install and activation | ✅ | ✅ | Host detection happens here |
| TP-02 First-run setup | ✅ | ✅ | |
| TP-06 Marketplace discovery | ✅ | ✅ | Webview theming differs between the two editors |
| TP-07 Bundle installation | ✅ | ✅ | Different destinations and different kind routing |
| TP-08 / TP-09 Profiles | ✅ | ✅ | Activation writes primitives to the host layout |
| TP-11 Repository scope and lockfile | ✅ | ✅ | Host detection decides `.github/` vs `.kiro/` |
| TP-12 Uninstall and cleanup | ✅ | ✅ | |
| TP-15 CLI | ✅ | ✅ | Via explicit `kiro` and `vscode` targets, not detection |
| TP-17 Upgrade and migration | ✅ | ✅ | |
| TP-03, TP-04, TP-05, TP-10, TP-13, TP-14, TP-16, TP-18, TP-19 | ✅ | — | Host-agnostic; run once unless your change touches host handling |

Claude Code and Windsurf are **install targets**, not hosts that run this extension — Claude Code is a CLI and never loads it. Cover them through TP-07 and the CLI's explicit target flags.

## How To Read This Page

The plans run in the order written — a user journey where state carries forward, so you are not rebuilding fixtures for every case. Running a subset is normal: pick the plans covering what changed, and check the preceding plans for state a chosen plan depends on.

Every plan is a happy path. Failure modes, resilience and performance are out of scope; they belong in automation.

This page does not name the automated suites covering each area — that mapping lives in [Testing](../testing.md). See [#370](https://github.com/AmadeusITGroup/ai-primitives-hub/issues/370) for the ongoing work of moving edge cases out of here and into test suites.

---

## TP-01 — Fresh Install and Activation

| # | Scenario | Expected result |
|---|---|---|
Run the whole plan twice — once in **VS Code**, once in **Kiro**.

| # | Scenario | Expected result |
|---|---|---|
| ⭐ 1.1 | Install the extension into a brand-new **VS Code** profile, then reload | Activates; Output channel shows a clean startup with no errors |
| ⭐ 1.2 | Install the same VSIX into a clean **Kiro** profile, then reload | Activates identically; no errors caused by the fork |
| ⭐ 1.3 | In each host, read the `[host-app] detectHostApp:` line in the Output channel | Resolves to `vscode` in VS Code and `kiro` in Kiro — **not** the `vscode` fallback while running in Kiro |
| 1.4 | Open the activity bar container in both hosts | Both the `Marketplace` webview and the `Registry Explorer` tree render |
| 1.5 | Open the command palette and type the `AI Primitives Hub:` category | All 66 contributed commands listed and invocable in both hosts |
| 1.6 | Open the extension's settings page | All 9 `promptregistry.*` settings appear with documented defaults |
| 1.7 | Note activation time on a workspace with installed bundles | No perceptible startup regression versus the previous major |

## TP-02 — First-Run Setup

| # | Scenario | Expected result |
|---|---|---|
Run in both **VS Code** and **Kiro**.

| # | Scenario | Expected result |
|---|---|---|
| ⭐ 2.1 | Activate for the first time with no prior state | Setup flow appears and leads to a usable state |
| 2.2 | Complete it, then reload | Does not reappear; the state it produced is intact |
| 2.3 | Inspect hubs seeded from `config/defaultHubs.json` | Documented default hubs present and usable |
| 2.4 | Run `Reset First Run (for Testing)` and reload | Setup flow reappears from a clean slate |
| 2.5 | Compare the setup flow between the two hosts | Wording and steps make sense in Kiro too — no VS Code-only terminology that misleads a Kiro user |

## TP-03 — Authentication

Runs before anything touching GitHub. The credential established here carries forward.

| # | Scenario | Expected result |
|---|---|---|
| ⭐ 3.1 | Configure a token via the `githubToken` setting | Picked up and used for GitHub API calls |
| 3.2 | Remove the setting, provide a token via the environment | Environment provider takes over transparently |
| 3.3 | Remove that, authenticate via the `gh` CLI | CLI provider used, per the documented precedence |
| 3.4 | Run `Force GitHub Authentication` | Session re-prompted and refreshed |
| 3.5 | Work behind an HTTP(S) proxy with the standard variables set | All network calls honour the proxy |

## TP-04 — Hub Onboarding

| # | Scenario | Expected result |
|---|---|---|
| ⭐ 4.1 | `Import Hub` against a valid hub repository | Hub appears in the tree, populated with its profiles |
| 4.2 | `List Hubs` | Every hub listed with accurate metadata |
| 4.3 | `Sync Hub` after an upstream change | New and changed profiles appear, progress reported |
| 4.4 | Import a second hub, then `Switch Hub` | Active hub changes; tree and marketplace both refresh |
| 4.5 | `Export Hub Configuration`, then import into a clean profile | Round-trips with no loss |
| 4.6 | `Open Hub Repository` / `Open Repository` on hub, source, profile and bundle nodes | Each opens the correct upstream URL |
| 4.7 | `Delete Hub` | That hub and its derived state removed; others untouched |

## TP-05 — Sources

Golden coverage is the **GitHub** adapter only. The awesome-copilot, APM, skills and local-path variants are exercised here when your change touches them, and otherwise rely on `packages/infra/test/adapters/**`.

| # | Scenario | Expected result |
|---|---|---|
| ⭐ 5.1 | `Add Source` for a public GitHub repository | Added, immediately enumerates its bundles |
| 5.2 | `Add Source` for an awesome-copilot source | Added, enumerates its bundles |
| 5.3 | `Sync Source`, then `Sync All Sources` | Content refreshes, progress reported, per-source results visible |
| 5.4 | Sync again with nothing changed upstream | ETag/cache short-circuits instead of refetching the tree |
| 5.5 | `Edit Source` | Change persists and the next sync uses it |
| 5.6 | `Toggle Source Enabled/Disabled` | Disabled source drops out of the marketplace and is skipped by `Sync All Sources` |
| 5.7 | Sync a source shipping a README and assets | Fetched to the expected location |
| ⭐ 5.8 | Private GitHub repository using the credential from TP-03 | Content enumerates normally |
| 5.9 | Remove all credentials, browse and sync the public source | Public flows work with no credentials |
| ⭐ 5.10 | Add a **local** source pointing at collection content on disk | Discovered and installable |
| 5.11 | GitHub source exposing multiple collections in one repository | All discovered and listed separately |
| 5.12 | Source backed by a large repository tree | Completes in reasonable time; UI stays responsive |
| 5.13 | `Remove Source` while its bundles are installed | Source removed, installed bundles intact |

## TP-06 — Marketplace Discovery

| # | Scenario | Expected result |
|---|---|---|
| 6.1 | Open the Marketplace webview with several sources configured | Bundles render with title, description, version, source and icon |
| 6.2 | Search for a known bundle and apply the filters | Relevant, responsive results |
| ⭐ 6.3 | Open a bundle's details view | Description, version, contents, source — and the `README.md` renders correctly |
| 6.4 | Switch between light, dark and high-contrast themes | Both webviews re-render correctly |
| 6.5 | Operate both webviews using only the keyboard | Every action reachable, focus order sensible, controls labelled for a screen reader |
| 6.6 | Reload the window with the marketplace open | Restores without a blank panel or duplicated content |
| ⭐ 6.7 | Repeat 6.1–6.6 with the extension running in **Kiro** | Webviews render and behave the same; Kiro's default theme does not break contrast or layout |

## TP-07 — Bundle Installation

Destinations come from `packages/infra/src/writers/default-layouts.json`. Note the host-specific routing: Kiro folds `prompts/` **and** `instructions/` into `steering/` and has no `hooks/` or `plugins/` route; VS Code routes `chatmodes/` into `agents/`. `deployment-manifest.yml` and `README.md` are never copied into the installed layout.

| # | Scenario | Expected result |
|---|---|---|
| ⭐ 7.1 | Install at `user` scope for **VS Code** | Lands under `~/.copilot/` per the kind routes |
| ⭐ 7.2 | Install at `repository` scope for **VS Code** | Lands under `<workspace>/.github/` |
| ⭐ 7.3 | Install at `user` scope for **Kiro** | Lands under `~/.kiro/` |
| ⭐ 7.4 | Install at `repository` scope for **Kiro** | Lands under `<workspace>/.kiro/` |
| 7.5 | Install for Claude Code and Windsurf | Correct per-host transform and layout |
| ⭐ 7.6 | Install a collection containing **every primitive kind** | Every kind routed correctly; nothing silently dropped |
| ⭐ 7.7 | In **Kiro**, check where `prompts/` and `instructions/` landed | Both folded into `steering/`; nothing left in a `prompts/` or `instructions/` directory |
| ⭐ 7.8 | Install a collection carrying `hooks/` or `plugins/` into **Kiro** | Kiro has no route for these kinds — the outcome is deliberate and reported, not a silent drop |
| ⭐ 7.9 | Confirm the installed primitives in Copilot and Kiro | Prompts invocable, instructions/steering applied, agents and skills available |
| 7.10 | Install a collection declaring MCP servers, in each host | MCP config written to the location that host actually reads |
| 7.11 | Install at `workspace` and `project` scope | Files land in the corresponding workspace paths |
| 7.12 | `View Bundle Details` on the installed bundle | Installed version, scope and source all accurate |
| 7.13 | Install a second bundle from a different source | Both coexist; neither overwrites the other |
| ⭐ 7.14 | Repeat 7.1–7.9 through the **CLI**, passing `kiro` and `vscode` as explicit targets | Same on-disk result as the extension |

### Destination reference

| Host | User base | Repository base | Notable routing |
|---|---|---|---|
| `vscode` | `~/.copilot` | `<ws>/.github` | `chatmodes/` → `agents/` |
| `vscode-insiders` | `~/.copilot` | `<ws>/.github` | same as `vscode` |
| `kiro` | `~/.kiro` | `<ws>/.kiro` | `prompts/` **and** `instructions/` → `steering/`; no `hooks/`, no `plugins/` |
| `claude-code` | `~/.claude` | `<ws>/.claude` | `prompts/` → `commands/` |
| `windsurf` | `~/.codeium/windsurf` | `<ws>/.windsurf` | `prompts/` and `instructions/` → `rules/` |
| `copilot-cli` | `~/.copilot` | `<ws>/.github` | also skips `collections/` |

## TP-08 — Local Profiles and Favorites

| # | Scenario | Expected result |
|---|---|---|
| 8.1 | Create a profile referencing several primitives, then reload | Persists exactly as authored |
| 8.2 | Activate it | Referenced primitives applied to the workspace |
| 8.3 | Edit and re-activate | Changes take effect with no stale leftovers |
| 8.4 | Deactivate | Primitives removed; unrelated files untouched |
| 8.5 | `Export Profile`, then `Import Profile` on a clean profile | Round-trips completely |
| ⭐ 8.6 | Activate and deactivate the same profile in **VS Code**, then in **Kiro** | Primitives written to and removed from that host's layout, not the other's |
| 8.7 | `List All Profiles` | Complete and accurate |
| 8.8 | `Toggle Favorite`, then switch `Show Favorites` / `Show All Profiles` | Filtered view correct; title actions follow the `promptRegistry.favoritesViewActive` context key |
| 8.9 | Delete a profile | Gone from the tree and from `List All Profiles` |

## TP-09 — Hub Profiles and Sync

| # | Scenario | Expected result |
|---|---|---|
| 9.1 | `Browse Hub Profiles`, then `View Hub Profile` | Content and metadata readable before committing to anything |
| ⭐ 9.2 | `Activate Hub Profile` in **VS Code**, then in **Kiro** | Primitives installed into the correct host layout each time; tree reflects the active state |
| 9.3 | `Show Active Hub Profiles` | Matches what is actually active on disk |
| 9.4 | Change upstream, then `Check Hub Profile for Updates` | Update detected and flagged |
| 9.5 | `View Hub Profile Changes` | Diff accurately describes what would change |
| 9.6 | `Sync Hub Profile Now` | Profile advances to the upstream state |
| 9.7 | `Review and Sync Hub Profile` | Lists each change, allows opting out per change |
| 9.8 | `View Hub Profile Sync History` | Every sync recorded in order |
| 9.9 | `Rollback Hub Profile` to a previous entry | Earlier state restored exactly |
| 9.10 | `Clear Hub Profile Sync History`, then `Deactivate Hub Profile` | History clears without touching active state; deactivation removes primitives cleanly |

## TP-10 — Update Lifecycle

| # | Scenario | Expected result |
|---|---|---|
| ⭐ 10.1 | Publish a newer version upstream, then `Check for Bundle Updates` | Bundle flagged in the tree with the correct `contextValue` |
| ⭐ 10.2 | Confirm the user is **notified** of the available update | Notification appears per the configured preference |
| ⭐ 10.3 | `Update Bundle` | Version advances; content replaced, not duplicated |
| 10.4 | `Update All Bundles` with two updatable | Both advance, progress reported per bundle |
| 10.5 | `Enable Auto-Update`, then `Disable Auto-Update` | `contextValue` and available menu entries change to match |
| 10.6 | `updateCheck.autoUpdate` on, with an update available | Installs in the background and notifies |
| 10.7 | Walk `updateCheck.frequency` through `daily`, `weekly`, `manual` | Scheduler honours each value |
| ⭐ 10.8 | Check for updates from the **CLI** | Proposed automatically, or reported when checked |
| ⭐ 10.9 | Apply the update from the CLI, then verify in Copilot and Kiro | Same result as the extension; agents pick up new content, stale content gone |

## TP-11 — Repository Scope and Lockfile — **cannot be waived**

`prompt-registry.lock.json` is the source of truth for repository scope. A regression corrupts state a whole team shares through Git.

Run every row in both hosts. Repository scope resolves its destination from host detection, so this is where a detection regression does the most damage.

| # | Scenario | Expected result |
|---|---|---|
| ⭐ 11.1 | Install at repository scope in **commit** mode | Committable lockfile entry; files land in the repository |
| ⭐ 11.2 | Install at repository scope in **local-only** mode | Entry marked local-only, excluded from the commit |
| ⭐ 11.3 | Do 11.1 with the extension running in **VS Code**, then in **Kiro** | Content lands in `<ws>/.github/` under VS Code and `<ws>/.kiro/` under Kiro — never `.github/` while running in Kiro |
| 11.4 | `Move to Repository (Commit)`, then `(Local Only)` from user scope | Files and lockfile move together; `contextValue` updates |
| 11.5 | `Move to User` from each repository mode | Reverse move complete, no lockfile residue |
| 11.6 | `Switch to Local Only`, then `Switch to Commit` | Mode flips in place without reinstalling |
| ⭐ 11.7 | Commit the lockfile, clone fresh elsewhere, activate in the host it was created in, then in the **other host** | Bundles restored from the lockfile alone; a lockfile written under one host is read correctly under the other |
| 11.8 | Inspect the lockfile after each operation | Valid, minimal, diff-friendly — no unrelated churn |
| 11.9 | Open a repository whose lockfile came from the **previous major** | Read without migration errors or needless rewriting |
| 11.10 | Delete an upstream source, then `Clean Up Stale Repository Bundles` | Stale entry removed; valid entries untouched |

## TP-12 — Uninstall and Cleanup

| # | Scenario | Expected result |
|---|---|---|
| ⭐ 12.1 | Uninstall a user-scope bundle in **VS Code**, then in **Kiro** | Files removed from `~/.copilot/` and `~/.kiro/` respectively |
| 12.2 | Uninstall one of two bundles installed side by side | The other's files untouched |
| ⭐ 12.3 | Uninstall at each repository mode, in both hosts | Files removed from `.github/` or `.kiro/` as appropriate; matching lockfile entry goes too |
| 12.4 | Hand-edit an installed file, then uninstall | Local-modification warning appears; choice honoured |
| 12.5 | Leave unrelated files alongside a bundle, then uninstall | Unrelated files preserved |
| 12.6 | Uninstall everything, then inspect the target directories | No orphaned directories or empty scaffolding |

## TP-13 — Settings

| # | Scenario | Expected result |
|---|---|---|
| 13.1 | All 9 `promptregistry.*` settings at defaults, main flows exercised | Behaviour matches the documented defaults |
| 13.2 | `installationScope` set to `user`, `workspace`, `project` in turn | Default install target follows the setting |
| ⭐ 13.3 | Set the settings in **Kiro** and confirm they are read | Settings apply the same way; nothing depends on a VS Code-only config path |
| 13.4 | Turn `enableLogging` off | Output channel quiet; genuine errors still surfaced |
| 13.5 | Turn `autoCheckUpdates` off and reload | No update check on activation |
| 13.6 | `Export Settings`, then `Import Settings` into a clean profile | Full configuration round-trips |
| 13.7 | `Open Settings` | Extension's settings scope opens directly |
| 13.8 | Compare `reference/settings.md` against `package.json` | Names, types, defaults and enums match exactly |

## TP-14 — Authoring, Scaffolding and Publishing

| # | Scenario | Expected result |
|---|---|---|
| ⭐ 14.1 | `Scaffold Project` into an **empty folder** | Documented structure created, including the CI workflow |
| 14.2 | `Scaffold Project` in a workspace that already has content | Existing files untouched; nothing clobbered |
| ⭐ 14.3 | `Add Resource` for each of prompt, instruction, agent and skill, plus a `README.md` | Each created with valid frontmatter from the template |
| 14.4 | `Create New Collection` | Valid `deployment-manifest.yml` with id, version and name |
| ⭐ 14.5 | `Validate Collections` against it | Passes |
| 14.6 | Break the manifest, re-run `Validate Collections` | Errors precise and located |
| 14.7 | `Validate APM Package` on a sample package | Reported against `schemas/apm.schema.json` |
| ⭐ 14.8 | Push to a **real GitHub repository** with the scaffolded runner configuration | Workflow runs and validation passes on the runner |
| ⭐ 14.9 | Let the workflow finish | A **release is pushed to GitHub** with the expected artifacts and correct version |
| ⭐ 14.10 | Change the collection and push again | A new release with a correctly incremented version — not a re-tag, not a skipped bump |
| 14.11 | `List All Collections` | Complete listing |
| 14.12 | Open a collection, manifest and hub config in the editor | Bundled schemas give completion and inline validation |
| ⭐ 14.13 | Run 14.1, 14.3, 14.5 and the publish flow through the **CLI** | Same result as the extension |

## TP-15 — CLI (`ai-primitives-hub`)

The bar is parity: the same operation must produce the same on-disk result as the extension.

| # | Scenario | Expected result |
|---|---|---|
| 15.1 | `--help`, `--version`, and a subcommand's `--help` | Help renders correctly at every level |
| ⭐ 15.2 | `init`, `status`, `doctor` in a real project | Each reports the environment accurately |
| ⭐ 15.3 | `install`, `apply`, `update`, `uninstall` for a bundle | On-disk result matches the extension for the same bundle |
| ⭐ 15.4 | `source`, `hub`, `profile` subcommands | Parity with the equivalent extension commands |
| ⭐ 15.5 | `target-types`, then `target-add` for both `vscode` and `kiro` | Both listed as supported; both persisted and reflected in `target-list` |
| ⭐ 15.6 | Install the same collection with `vscode` and with `kiro` as the target | Files land under `.copilot`/`.github` and `.kiro` respectively, matching what the extension produces in each host |
| 15.7 | `target-remove` for one of them | Removed without disturbing the other target's installed content |
| 15.8 | `discover` in a real project | Recommendations sensible for the detected context |
| 15.9 | `collection-create/list/validate/affected`, `bundle-build`, `bundle-manifest`, `version-compute` | Correct outputs on a sample collection |
| 15.10 | Generators — `skill-create`, `skill-new`, `skill-validate`, `agent-create`, `hook-create`, `prompt-create`, `instruction-create`, `plugin-create`, `plugins-list` | Each produces a valid artifact |
| 15.11 | Index pipeline — `index-harvest`, `index-build`, `index-search`, `index-shortlist`, `index-stats`, `index-report`, `index-export`, `index-eval` | Index round-trips; search returns expected hits |
| 15.12 | `config-get`, `config-list` | Output reflects real configuration |
| 15.13 | `completion` for each supported shell | Installs and works |
| 15.14 | SEA binary from `pnpm -C packages/cli run build:sea`, on a machine with no Node.js | Runs standalone |

The CLI has no editor to detect, so it takes the host as an **explicit target** rather than inferring it. That difference is the point of 15.5–15.7: a host bug can exist in one delivery layer and not the other.

## TP-16 — Collection Scripts (`lib`)

| # | Scenario | Expected result |
|---|---|---|
| 16.1 | Install from a clean `npx`, run each of the 11 bins with `--help` | Every bin present and self-documenting |
| ⭐ 16.2 | `validate-collections` and `validate-skills` on valid input | Both pass |
| 16.3 | The same two on deliberately invalid input | Failures precise and located |
| ⭐ 16.4 | `build-collection-bundle`, `generate-manifest`, `compute-collection-version` twice on the same input | Deterministic and reproducible |
| 16.5 | `detect-affected-collections` against a real diff | Correct affected set |
| 16.6 | `publish-collections` in dry-run | Nothing published |
| 16.7 | `list-collections`, `create-skill`, `hub-release-analyzer`, `hub-ownership-analyzer` | Expected report or artifact |
| ⭐ 16.8 | The `github-actions/validate-collections` action on a sample repository | Passes and fails as expected — this action has no test suite of its own |

## TP-17 — Upgrade and Migration from the Previous Major — **cannot be waived**

Run against real state, not a fixture.

| # | Scenario | Expected result |
|---|---|---|
| ⭐ 17.1 | Install the **previous major**, build real state — hubs, sources, profiles, favorites, bundles at user and repository scope | A representative starting point exists on disk |
| ⭐ 17.2 | Install this release over the top and activate | Migrations run once and complete without error |
| ⭐ 17.3 | Inspect all the state from 17.1 | Everything survives intact; nothing silently dropped |
| 17.4 | Check the source-id normalization migration | Legacy ids normalized and every reference updated |
| 17.5 | Reload and activate again | Migration does not re-run; provably idempotent |
| ⭐ 17.6 | Run 17.1–17.5 in **VS Code**, then repeat the whole sequence in **Kiro** | Migration works in both hosts; Kiro state is not migrated into VS Code paths or vice versa |
| ⭐ 17.7 | On migrated state, confirm installed content is still where the current host expects it | Kiro content still under `.kiro/`, VS Code content still under `.github/` and `~/.copilot/` |
| ⭐ 17.8 | Exercise G1 and G3 against the migrated state | Works on migrated data, not only on freshly created data |

## TP-18 — Publish and Distribution

| # | Scenario | Expected result |
|---|---|---|
| 18.1 | Trigger the `Publishing` workflow on a pre-release tag | Every job completes green |
| ⭐ 18.2 | Review the VS Code Marketplace listing | Correct version, README, icon and categories |
| 18.3 | Review the Open VSX listing | Same |
| ⭐ 18.4 | Install from each marketplace into a clean **VS Code**, and into a clean **Kiro** | Works end to end in both; Kiro can install the published artifact, not only a local VSIX |
| 18.5 | Download the release installation bundle; run `install.sh`, then `install.bat` on Windows | Both install successfully |
| 18.6 | Verify the checksums and SLSA provenance attached to the release | Both verify |
| 18.7 | Confirm the rollback path | Previous version still installable; procedure written down |

## TP-19 — Documentation and Release Notes

| # | Scenario | Expected result |
|---|---|---|
| 19.1 | Compare `reference/commands.md` and `reference/settings.md` against `package.json` | Both match exactly |
| 19.2 | Review user guide pages for every changed behaviour | Updated to match the shipped build |
| 19.3 | `pnpm -C website run build` | Clean build; new pages registered in `docs/README.md` and `website/sidebars.ts` |
| 19.4 | Read the release notes end to end | Every breaking change listed with a migration note |
| 19.5 | Check version references in `README.md` | Updated by `version:bump:major` |
| 19.6 | Regenerate helper skill references via `copy-skill-references` | Reflect the current `docs/` tree |

---

## Recording A Run

Release sign-off lives on the [golden path page](./golden-path.md#sign-off). When you run plans from this page — because a PR touched a specific area — record which ones in the PR or release issue:

| Plan | Reason it was run | Result | Owner | Date |
|---|---|---|---|---|
| | | | | |

Two plans here block a major release outright, because both touch state users already have on disk:

- [TP-11 — Repository scope and lockfile](#tp-11--repository-scope-and-lockfile--cannot-be-waived)
- [TP-17 — Upgrade and migration](#tp-17--upgrade-and-migration-from-the-previous-major--cannot-be-waived)

## See Also

- [Golden Path Test Cases](./golden-path.md) — the three mandatory scenarios and the release sign-off table
- [Testing](../testing.md) — running the automated suites
- [Validation](../validation.md) — local validation commands
- [Releasing](../releasing.md) — version bump and publish mechanics
- [Testing SSH Remote](./ssh-remote.md) — remote environment testing
