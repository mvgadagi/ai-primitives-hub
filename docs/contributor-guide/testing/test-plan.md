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

## Reading The Automation Column

Every scenario carries the automation that already covers it, so manual effort lands where it is actually needed rather than re-proving what vitest and Mocha already assert. Growing this coverage is tracked in [#370](https://github.com/AmadeusITGroup/ai-primitives-hub/issues/370).

| Marker | Meaning | How to treat it |
|---|---|---|
| 🟢 **Auto** | The logic is asserted by a test suite | Quick confirmation. First thing to drop when short on time |
| 🟡 **Partial** | Automation covers the logic, but not the real host, network, filesystem or rendering | Focus on the named gap, not the logic |
| 🔴 **Manual** | No automated coverage exists | **Full attention.** These justify the whole page |

Suite paths are relative to `apps/vscode-extension/` for `test/…`, and to the repository root for `packages/…` and `lib/…`.

A useful shortcut: if a plan is entirely 🟢, running it is a smoke test. If it contains 🔴 rows, those rows are the plan.

---

## Host Coverage — VS Code and Kiro

The extension does not just *install for* Kiro and VS Code — it **runs inside both**. Kiro is a VS Code fork, so the same VSIX is loaded by both editors and has to behave correctly in each. Every plan below that touches the filesystem or the UI is therefore run twice: once with the extension running in VS Code, once with it running in Kiro.

**No automated test ever launches Kiro.** `test/runExtensionTests.js` calls `runTests()` without a `version` option, so the harness always downloads the default VS Code build. Every Kiro row in this document is therefore unautomated by definition — the single largest gap in our coverage.

> Worth knowing while reading the rest of this page: the harness also never reads the `VSCODE_VERSION` environment variable, even though the CI matrix sets it to `stable` and `insiders`. Both matrix legs currently exercise the same default build, so "tested on Insiders" is not something this document can rely on.

### How the host is detected

`resolveHostApp` (in `packages/infra/src/host-app/host-app-target.ts`) matches the lowercased combination of `vscode.env.appName` and `vscode.env.uriScheme` against ordered rules:

| Signal contains | Resolved target |
|---|---|
| `kiro` | `kiro` |
| `windsurf` or `devin` | `windsurf` |
| `insiders` | `vscode-insiders` |
| anything else | `vscode` (the default `.github/` layout) |

**The failure mode to watch for:** detection falls back to `vscode` when a host is unrecognized. In Kiro that fallback is silent and wrong — content lands in `.github/` instead of `.kiro/`. The extension logs the resolved target on every detection (`[host-app] detectHostApp: appName="…", uriScheme="…" -> …`), so the Output channel is the fastest way to confirm the host was identified correctly.

`packages/infra/test/host-app/host-app-target.test.ts` asserts the signal→target mapping for known inputs. What it cannot assert is what `appName` and `uriScheme` a real Kiro build actually reports — which is precisely the input that decides whether the fallback fires.

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

---

## TP-01 — Fresh Install and Activation

Run the whole plan twice — once in **VS Code**, once in **Kiro**.

| # | Scenario | Expected result | Automation → where to focus |
|---|---|---|---|
| ⭐ 1.1 | Install the extension into a brand-new **VS Code** profile, then reload | Activates; Output channel shows a clean startup with no errors | 🟡 `test/suite/integration-scenarios.test.ts` activates in a real VS Code host, but from source. **Installing the packaged VSIX is unautomated** |
| ⭐ 1.2 | Install the same VSIX into a clean **Kiro** profile, then reload | Activates identically; no errors caused by the fork | 🔴 The harness never launches Kiro |
| ⭐ 1.3 | In each host, read the `[host-app] detectHostApp:` line in the Output channel | Resolves to `vscode` in VS Code and `kiro` in Kiro — **not** the `vscode` fallback while running in Kiro | 🟡 `packages/infra/test/host-app/host-app-target.test.ts` covers the mapping. **The signals Kiro really reports are untested** |
| 1.4 | Open the activity bar container in both hosts | Both the `Marketplace` webview and the `Registry Explorer` tree render | 🟡 `test/ui/marketplace-view-provider.test.ts`, `test/ui/registry-tree-provider.test.ts` assert provider behaviour, not that the panel paints |
| 1.5 | Open the command palette and type the `AI Primitives Hub:` category | All 66 contributed commands listed and invocable in both hosts | 🟡 `test/suite/integration-scenarios.test.ts` asserts registration for **6 scope commands only** (`syncAllSources`, `moveToUser`, `moveToRepositoryCommit`, `moveToRepositoryLocalOnly`, `switchToLocalOnly`, `switchToCommit`) — the file is otherwise placeholders. **The other 60 commands are unverified** |
| 1.6 | Open the extension's settings page | All 9 `promptregistry.*` settings appear with documented defaults | 🟡 `test/config/package-configuration.test.ts` covers **only the 4 `updateCheck.*` settings**. `autoCheckUpdates`, `installationScope`, `enableLogging`, `githubToken` and `updateCheck.cacheTTL` are unasserted |
| 1.7 | Note activation time on a workspace with installed bundles | No perceptible startup regression versus the previous major | 🔴 No performance budget is measured anywhere |

## TP-02 — First-Run Setup

Run in both **VS Code** and **Kiro**.

| # | Scenario | Expected result | Automation → where to focus |
|---|---|---|---|
| ⭐ 2.1 | Activate for the first time with no prior state | Setup flow appears and leads to a usable state | 🟢 `test/services/setup-state-manager.test.ts`, `test/e2e/setup-state-flows.test.ts` |
| 2.2 | Complete it, then reload | Does not reappear; the state it produced is intact | 🟢 `test/services/setup-state-manager.test.ts` (+ `.property.test.ts`) |
| 2.3 | Inspect hubs seeded from `config/defaultHubs.json` | Documented default hubs present and usable | 🟡 Seeding logic covered by `test/e2e/setup-state-flows.test.ts`. **The shipped `defaultHubs.json` content is not validated against reachable hubs** |
| 2.4 | Run `Reset First Run (for Testing)` and reload | Setup flow reappears from a clean slate | 🟢 `test/services/setup-state-manager.test.ts` |
| 2.5 | Compare the setup flow between the two hosts | Wording and steps make sense in Kiro too — no VS Code-only terminology that misleads a Kiro user | 🔴 Copy review; nothing automated |

## TP-03 — Authentication

Runs before anything touching GitHub. The credential established here carries forward.

| # | Scenario | Expected result | Automation → where to focus |
|---|---|---|---|
| ⭐ 3.1 | Configure a token via the `githubToken` setting | Picked up and used for GitHub API calls | 🟢 `packages/infra/test/auth/default-token-provider.test.ts` |
| 3.2 | Remove the setting, provide a token via the environment | Environment provider takes over transparently | 🟢 `packages/infra/test/auth/env-token-provider.test.ts` |
| 3.3 | Remove that, authenticate via the `gh` CLI | CLI provider used, per the documented precedence | 🟢 `packages/infra/test/auth/gh-cli-token-provider.test.ts`, `composite-token-provider.test.ts` |
| 3.4 | Run `Force GitHub Authentication` | Session re-prompted and refreshed | 🔴 Depends on the real VS Code auth provider; not mockable in our suites |
| 3.5 | Work behind an HTTP(S) proxy with the standard variables set | All network calls honour the proxy | 🟡 `packages/infra/test/http/proxy-env.test.ts` covers variable parsing. **A real proxy is never exercised** |

## TP-04 — Hub Onboarding

| # | Scenario | Expected result | Automation → where to focus |
|---|---|---|---|
| ⭐ 4.1 | `Import Hub` against a valid hub repository | Hub appears in the tree, populated with its profiles | 🟢 `packages/app/test/registry/hub-manager.test.ts`, `packages/infra/test/hub/hub-resolver.test.ts` |
| 4.2 | `List Hubs` | Every hub listed with accurate metadata | 🟢 `packages/infra/test/stores/hub-store.test.ts` |
| 4.3 | `Sync Hub` after an upstream change | New and changed profiles appear, progress reported | 🟢 `packages/app/test/registry/load-hub-sources.test.ts`, `source-sync-queue.test.ts` |
| 4.4 | Import a second hub, then `Switch Hub` | Active hub changes; tree and marketplace both refresh | 🟡 `packages/infra/test/stores/active-hub-store.test.ts` covers the switch; **the coordinated UI refresh only partly, via `test/ui/ui-source-sync-refresh.test.ts`** |
| 4.5 | `Export Hub Configuration`, then import into a clean profile | Round-trips with no loss | 🟡 `packages/infra/test/hub/validate-hub-config.test.ts` validates the shape. **The export→import round-trip is not asserted end to end** |
| 4.6 | `Open Hub Repository` / `Open Repository` on hub, source, profile and bundle nodes | Each opens the correct upstream URL | 🔴 Opens an external browser; not automatable in-process |
| 4.7 | `Delete Hub` | That hub and its derived state removed; others untouched | 🟢 `packages/app/test/registry/hub-manager.test.ts`, `packages/infra/test/stores/hub-store.test.ts` |

## TP-05 — Sources

Golden coverage is the **GitHub** adapter only. The awesome-copilot, APM, skills and local-path variants are exercised here when your change touches them, and otherwise rely on `packages/infra/test/adapters/**`.

| # | Scenario | Expected result | Automation → where to focus |
|---|---|---|---|
| ⭐ 5.1 | `Add Source` for a public GitHub repository | Added, immediately enumerates its bundles | 🟢 `test/commands/source-commands.test.ts` (`addSource`: prompts, URL validation, GitHub and local types), `packages/infra/test/adapters/github-adapter.test.ts` |
| 5.2 | `Add Source` for an awesome-copilot source | Added, enumerates its bundles | 🟢 `packages/infra/test/adapters/awesome-copilot-adapter.test.ts` |
| 5.3 | `Sync Source`, then `Sync All Sources` | Content refreshes, progress reported, per-source results visible | 🟢 `packages/app/test/registry/source-sync-queue.test.ts` |
| 5.4 | Sync again with nothing changed upstream | ETag/cache short-circuits instead of refetching the tree | 🟢 `packages/infra/test/harvest/etag-store.test.ts`, `blob-cache.test.ts` |
| 5.5 | `Edit Source` | Change persists and the next sync uses it | 🟢 `test/commands/source-commands.test.ts` (`editSource`: name, URL, type, priority preserved) |
| 5.6 | `Toggle Source Enabled/Disabled` | Disabled source drops out of the marketplace and is skipped by `Sync All Sources` | 🟡 `packages/app/test/registry/load-hub-sources.test.ts` asserts only enabled sources are loaded. **Marketplace filtering after a live toggle is the gap** |
| 5.7 | Sync a source shipping a README and assets | Fetched to the expected location | 🟢 `test/e2e/source-sync-readme-download.test.ts` |
| ⭐ 5.8 | Private GitHub repository using the credential from TP-03 | Content enumerates normally | 🔴 **Needs a real private repository and a real token.** Suites use `nock`, so authorization is never truly exercised |
| 5.9 | Remove all credentials, browse and sync the public source | Public flows work with no credentials | 🟡 Provider fallback covered in `packages/infra/test/auth/**`; the unauthenticated network path is mocked |
| ⭐ 5.10 | Add a **local** source pointing at collection content on disk | Discovered and installable | 🟢 `packages/infra/test/adapters/local-adapter.test.ts` |
| 5.11 | GitHub source exposing multiple collections in one repository | All discovered and listed separately | 🟢 `test/e2e/github-multiple-collections.test.ts` |
| 5.12 | Source backed by a large repository tree | Completes in reasonable time; UI stays responsive | 🔴 No performance or scale test exists |
| 5.13 | `Remove Source` while its bundles are installed | Source removed, installed bundles intact | 🟡 `test/commands/source-commands.test.ts` (`removeSource`: confirmation, cancellation) covers the command. **That installed bundles survive is not asserted** |

## TP-06 — Marketplace Discovery

Everything in this plan is UI. Automation asserts what the providers return; nobody has automated what the user sees.

| # | Scenario | Expected result | Automation → where to focus |
|---|---|---|---|
| 6.1 | Open the Marketplace webview with several sources configured | Bundles render with title, description, version, source and icon | 🟡 `test/ui/marketplace-view-provider.test.ts` covers the data handed to the webview. **Rendering is unverified** |
| 6.2 | Search for a known bundle and apply the filters | Relevant, responsive results | 🟢 `packages/app/test/registry/search-registry-bundles.test.ts`, `packages/infra/test/search/**` |
| ⭐ 6.3 | Open a bundle's details view | Description, version, contents, source — and the `README.md` renders correctly | 🟡 Wiring covered by `test/ui/marketplace-view-provider.test.ts`. **Rendered markdown is unverified** |
| 6.4 | Switch between light, dark and high-contrast themes | Both webviews re-render correctly | 🔴 No visual or theme test |
| 6.5 | Operate both webviews using only the keyboard | Every action reachable, focus order sensible, controls labelled for a screen reader | 🔴 **No accessibility coverage of any kind.** Playwright is a devDependency but unused |
| 6.6 | Reload the window with the marketplace open | Restores without a blank panel or duplicated content | 🟡 `test/ui/marketplace-view-provider.eventHandling.test.ts` |
| ⭐ 6.7 | Repeat 6.1–6.6 with the extension running in **Kiro** | Webviews render and behave the same; Kiro's default theme does not break contrast or layout | 🔴 The harness never launches Kiro |

## TP-07 — Bundle Installation

Destinations come from `packages/infra/src/writers/default-layouts.json`. Note the host-specific routing: Kiro folds `prompts/` **and** `instructions/` into `steering/` and has no `hooks/` or `plugins/` route; VS Code routes `chatmodes/` into `agents/`. `deployment-manifest.yml` and `README.md` are never copied into the installed layout.

Layout resolution is well covered by unit tests. What they use is a mocked filesystem — so the manual focus is real files on a real machine, in the real host.

| # | Scenario | Expected result | Automation → where to focus |
|---|---|---|---|
| ⭐ 7.1 | Install at `user` scope for **VS Code** | Lands under `~/.copilot/` per the kind routes | 🟢 `packages/app/test/install/layout-resolver.test.ts`, `install-bundle.test.ts` |
| ⭐ 7.2 | Install at `repository` scope for **VS Code** | Lands under `<workspace>/.github/` | 🟢 `test/e2e/repository-level-installation.test.ts`, `packages/infra/test/writers/repo-scope-writer.test.ts` |
| ⭐ 7.3 | Install at `user` scope for **Kiro** | Lands under `~/.kiro/` | 🟡 `packages/app/test/transform/kiro-transformer.test.ts` covers the routing. **Never verified inside a running Kiro** |
| ⭐ 7.4 | Install at `repository` scope for **Kiro** | Lands under `<workspace>/.kiro/` | 🟡 As above — the transform is tested, the host is not |
| 7.5 | Install for Claude Code and Windsurf | Correct per-host transform and layout | 🟢 `packages/app/test/transform/claude-code-transformer.test.ts`, `windsurf-transformer.test.ts` |
| ⭐ 7.6 | Install a collection containing **every primitive kind** | Every kind routed correctly; nothing silently dropped | 🟢 `packages/app/test/install/pipeline.test.ts`, `test/e2e/skills-workflow.test.ts` |
| ⭐ 7.7 | In **Kiro**, check where `prompts/` and `instructions/` landed | Both folded into `steering/`; nothing left in a `prompts/` or `instructions/` directory | 🟡 `kiro-transformer.test.ts` asserts the fold. **Confirm on real disk** |
| ⭐ 7.8 | Install a collection carrying `hooks/` or `plugins/` into **Kiro** | Kiro has no route for these kinds — the outcome is deliberate and reported, not a silent drop | 🔴 **No test covers a kind with no route for the target host.** Genuine unknown; treat as exploratory |
| ⭐ 7.9 | Confirm the installed primitives in Copilot and Kiro | Prompts invocable, instructions/steering applied, agents and skills available | 🔴 **Nothing asserts a real agent consumes our output.** Highest-value row in this plan |
| 7.10 | Install a collection declaring MCP servers, in each host | MCP config written to the location that host actually reads | 🟡 `test/services/mcp-config-service.*.test.ts` covers merge, duplicates and inputs. **Per-host config location is the gap** — see the note below |
| 7.11 | Install at `workspace` and `project` scope | Files land in the corresponding workspace paths | 🟢 `test/services/user-scope-service.test.ts`, `packages/app/test/install/layout-resolver.test.ts` |
| 7.12 | `View Bundle Details` on the installed bundle | Installed version, scope and source all accurate | 🟢 `packages/app/test/registry/list-installed-bundles.test.ts` |
| 7.13 | Install a second bundle from a different source | Both coexist; neither overwrites the other | 🟢 `packages/app/test/install/install-bundle.test.ts` |
| ⭐ 7.14 | Repeat 7.1–7.9 through the **CLI**, passing `kiro` and `vscode` as explicit targets | Same on-disk result as the extension | 🟡 `packages/cli/test/commands/install.test.ts` covers the CLI alone. **No test diffs CLI output against extension output** |

> **On 7.10.** `McpConfigLocator` resolves the VS Code variant for Insiders, Cursor and Windsurf but has no Kiro branch, and the workspace path is hardcoded to `.vscode`. Verify against whatever the current behaviour is meant to be rather than assuming — this is being addressed separately.

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

Strongly covered by automation. Run this as a smoke pass unless your change is here.

| # | Scenario | Expected result | Automation → where to focus |
|---|---|---|---|
| 8.1 | Create a profile referencing several primitives, then reload | Persists exactly as authored | 🟢 `test/commands/profile-commands.test.ts` (`createProfile`: name uniqueness, bundle selection), `packages/app/test/registry/local-profile-crud.test.ts` |
| 8.2 | Activate it | Referenced primitives applied to the workspace | 🟢 `test/commands/profile-commands.test.ts` (`activateProfile`, incl. deactivating others), `packages/app/test/registry/activate-registry-profile.test.ts` |
| 8.3 | Edit and re-activate | Changes take effect with no stale leftovers | 🟢 `test/commands/profile-commands.test.ts` (`editProfile`: rename, add/remove bundles, ID preserved) |
| 8.4 | Deactivate | Primitives removed; unrelated files untouched | 🟢 `packages/app/test/registry/deactivate-registry-profile.test.ts` |
| 8.5 | `Export Profile`, then `Import Profile` on a clean profile | Round-trips completely | 🟡 `packages/app/test/registry/local-profile-crud.test.ts` covers `exportLocalProfile` serialization. **The import half, and moving the file to another machine, are manual** (note: `packages/app/test/search/export-profile.test.ts` is a different feature — shortlist→profile export) |
| ⭐ 8.6 | Activate and deactivate the same profile in **VS Code**, then in **Kiro** | Primitives written to and removed from that host's layout, not the other's | 🟡 Routing covered by the transformers; **the host is not** |
| 8.7 | `List All Profiles` | Complete and accurate | 🟢 `packages/app/test/registry/list-all-profiles.test.ts` |
| 8.8 | `Toggle Favorite`, then switch `Show Favorites` / `Show All Profiles` | Filtered view correct; title actions follow the `promptRegistry.favoritesViewActive` context key | 🟢 `packages/infra/test/stores/favorites-store.test.ts`, `test/ui/registry-tree-provider.test.ts` |
| 8.9 | Delete a profile | Gone from the tree and from `List All Profiles` | 🟢 `packages/app/test/registry/local-profile-crud.test.ts` |

## TP-09 — Hub Profiles and Sync

Better automated than it looks. `test/commands/hub-sync-commands.test.ts` and `test/commands/hub-sync-history.test.ts` cover the update/diff/sync/review commands and the full history lifecycle including rollback. Run this plan as a smoke pass unless your change is here.

| # | Scenario | Expected result | Automation → where to focus |
|---|---|---|---|
| 9.1 | `Browse Hub Profiles`, then `View Hub Profile` | Content and metadata readable before committing to anything | 🟢 `test/commands/hub-profile-commands.test.ts`, `test/services/hub-manager-profiles.test.ts` |
| ⭐ 9.2 | `Activate Hub Profile` in **VS Code**, then in **Kiro** | Primitives installed into the correct host layout each time; tree reflects the active state | 🟡 `test/commands/hub-profile-activation-commands.test.ts`, `test/services/hub-profile-activation.test.ts`. **Kiro is unautomated** |
| 9.3 | `Show Active Hub Profiles` | Matches what is actually active on disk | 🟢 `packages/infra/test/stores/profile-activation-store.test.ts` |
| 9.4 | Change upstream, then `Check Hub Profile for Updates` | Update detected and flagged | 🟢 `test/commands/hub-sync-commands.test.ts` (`Check For Updates`), `packages/app/test/registry/detect-updates.test.ts` |
| 9.5 | `View Hub Profile Changes` | Diff accurately describes what would change | 🟢 `test/commands/hub-sync-commands.test.ts` (`View Changes`) |
| 9.6 | `Sync Hub Profile Now` | Profile advances to the upstream state | 🟢 `test/commands/hub-sync-commands.test.ts` (`Sync Profile`) |
| 9.7 | `Review and Sync Hub Profile` | Lists each change, allows opting out per change | 🟡 `test/commands/hub-sync-commands.test.ts` (`Review And Sync`) covers the review dialog and the no-changes case. **Opting out of one change while accepting others is not asserted** |
| 9.8 | `View Hub Profile Sync History` | Every sync recorded in order | 🟢 `test/commands/hub-sync-history.test.ts` — records additions, updates, removals and metadata changes; asserts chronological order and limits |
| 9.9 | `Rollback Hub Profile` to a previous entry | Earlier state restored exactly | 🟢 `test/commands/hub-sync-history.test.ts` (`Rollback to History Entry`) — restores state, records the rollback as a new entry, errors on a non-active profile |
| 9.10 | `Clear Hub Profile Sync History`, then `Deactivate Hub Profile` | History clears without touching active state; deactivation removes primitives cleanly | 🟢 `test/commands/hub-sync-history.test.ts` (`Clear History`, including per-profile scoping), `test/services/hub-profile-deactivation.test.ts` |

## TP-10 — Update Lifecycle

| # | Scenario | Expected result | Automation → where to focus |
|---|---|---|---|
| ⭐ 10.1 | Publish a newer version upstream, then `Check for Bundle Updates` | Bundle flagged in the tree with the correct `contextValue` | 🟢 `test/commands/bundle-commands.checkBundleUpdates.test.ts` (selection dialog, "up to date" case), `packages/app/test/registry/detect-updates.test.ts` |
| ⭐ 10.2 | Confirm the user is **notified** of the available update | Notification appears per the configured preference | 🟡 `test/services/notification-manager.property.test.ts` covers the policy. **The notification a user actually sees is not asserted** |
| ⭐ 10.3 | `Update Bundle` | Version advances; content replaced, not duplicated | 🟢 `test/commands/bundle-commands.updateBundle.test.ts` (incl. the versioned-ID-after-consolidation regression), `test/e2e/bundle-update-github.test.ts` |
| 10.4 | `Update All Bundles` with two updatable | Both advance, progress reported per bundle | 🟢 `test/services/update-system-integration.test.ts` |
| 10.5 | `Enable Auto-Update`, then `Disable Auto-Update` | `contextValue` and available menu entries change to match | 🟢 `test/ui/auto-update-toggle.property.test.ts`, `test/e2e/context-menu-regression.test.ts` |
| 10.6 | `updateCheck.autoUpdate` on, with an update available | Installs in the background and notifies | 🟢 `packages/app/test/update/auto-update.test.ts`, `test/services/auto-update-service.test.ts` |
| 10.7 | Walk `updateCheck.frequency` through `daily`, `weekly`, `manual` | Scheduler honours each value | 🟢 `test/services/update-scheduler.property.test.ts` |
| ⭐ 10.8 | Check for updates from the **CLI** | Proposed automatically, or reported when checked | 🟢 `packages/cli/test/commands/doctor-status-init-update.test.ts` |
| ⭐ 10.9 | Apply the update from the CLI, then verify in Copilot and Kiro | Same result as the extension; agents pick up new content, stale content gone | 🔴 **The agent-consumption half has no coverage**, and cross-layer parity is manual |

## TP-11 — Repository Scope and Lockfile — **cannot be waived**

`prompt-registry.lock.json` is the source of truth for repository scope. A regression corrupts state a whole team shares through Git.

Run every row in both hosts. Repository scope resolves its destination from host detection, so this is where a detection regression does the most damage. This is the **best-automated** area in the document — which is why the manual focus is narrow and specific: real Git, real clone, real Kiro.

| # | Scenario | Expected result | Automation → where to focus |
|---|---|---|---|
| ⭐ 11.1 | Install at repository scope in **commit** mode | Committable lockfile entry; files land in the repository | 🟢 `test/services/lockfile-manager.test.ts`, `bundle-installer.repositoryScope.test.ts`, `packages/app/test/stores/json-lockfile-store.test.ts` |
| ⭐ 11.2 | Install at repository scope in **local-only** mode | Entry marked local-only, excluded from the commit | 🟢 `test/services/repository-scope-service.test.ts` (+ `.property.test.ts`) |
| ⭐ 11.3 | Do 11.1 with the extension running in **VS Code**, then in **Kiro** | Content lands in `<ws>/.github/` under VS Code and `<ws>/.kiro/` under Kiro — never `.github/` while running in Kiro | 🔴 **The exact regression the code comments warn about, and Kiro is unautomated.** Do not skip |
| 11.4 | `Move to Repository (Commit)`, then `(Local Only)` from user scope | Files and lockfile move together; `contextValue` updates | 🟢 `test/commands/bundle-scope-commands.test.ts` (`moveToRepository`: both modes, cancellation, not-installed and no-workspace errors) |
| 11.5 | `Move to User` from each repository mode | Reverse move complete, no lockfile residue | 🟢 `test/commands/bundle-scope-commands.test.ts` (`moveToUser`), `test/services/user-scope-service.unsync.test.ts` |
| 11.6 | `Switch to Local Only`, then `Switch to Commit` | Mode flips in place without reinstalling | 🟢 `test/services/repository-scope-service.test.ts` |
| ⭐ 11.7 | Commit the lockfile, clone fresh elsewhere, activate in the host it was created in, then in the **other host** | Bundles restored from the lockfile alone; a lockfile written under one host is read correctly under the other | 🟡 `test/e2e/lockfile-source-of-truth.test.ts` covers restore-from-lockfile. **A real clone, and cross-host reads, are manual** |
| 11.8 | Inspect the lockfile after each operation | Valid, minimal, diff-friendly — no unrelated churn | 🟡 Shape covered by `packages/app/test/stores/json-lockfile-store.test.ts`. **Diff noise is a human judgement** |
| 11.9 | Open a repository whose lockfile came from the **previous major** | Read without migration errors or needless rewriting | 🔴 **No previous-major lockfile fixture exists** |
| 11.10 | Delete an upstream source, then `Clean Up Stale Repository Bundles` | Stale entry removed; valid entries untouched | 🟢 `test/commands/bundle-commands.cleanupStale.property.test.ts`, `test/services/scope-conflict-resolver.test.ts` |

## TP-12 — Uninstall and Cleanup

| # | Scenario | Expected result | Automation → where to focus |
|---|---|---|---|
| ⭐ 12.1 | Uninstall a user-scope bundle in **VS Code**, then in **Kiro** | Files removed from `~/.copilot/` and `~/.kiro/` respectively | 🟡 `packages/app/test/install/uninstall-bundle.test.ts`, `uninstall-pipeline.test.ts`. **Kiro unautomated** |
| 12.2 | Uninstall one of two bundles installed side by side | The other's files untouched | 🟢 `packages/app/test/registry/uninstall-installed-bundle.test.ts` |
| ⭐ 12.3 | Uninstall at each repository mode, in both hosts | Files removed from `.github/` or `.kiro/` as appropriate; matching lockfile entry goes too | 🟡 Covered for VS Code by `test/e2e/lockfile-source-of-truth.test.ts`; **Kiro unautomated** |
| 12.4 | Hand-edit an installed file, then uninstall | Local-modification warning appears; choice honoured | 🟢 `test/services/local-modification-warning-service.test.ts` (+ `.property.test.ts`) |
| 12.5 | Leave unrelated files alongside a bundle, then uninstall | Unrelated files preserved | 🟢 `test/e2e/uninstall-preserves-unrelated-files.test.ts` |
| 12.6 | Uninstall everything, then inspect the target directories | No orphaned directories or empty scaffolding | 🟡 Pipeline covered; **leftover empty directories on real disk are the gap** |

## TP-13 — Settings

| # | Scenario | Expected result | Automation → where to focus |
|---|---|---|---|
| 13.1 | All 9 `promptregistry.*` settings at defaults, main flows exercised | Behaviour matches the documented defaults | 🟡 `test/config/package-configuration.test.ts` asserts schema, defaults and enums for **the 4 `updateCheck.*` settings only**. The remaining 5 have no schema or default assertions |
| 13.2 | `installationScope` set to `user`, `workspace`, `project` in turn | Default install target follows the setting | 🟢 `test/services/user-scope-service.test.ts`, `packages/app/test/install/layout-resolver.test.ts` |
| ⭐ 13.3 | Set the settings in **Kiro** and confirm they are read | Settings apply the same way; nothing depends on a VS Code-only config path | 🔴 The harness never launches Kiro |
| 13.4 | Turn `enableLogging` off | Output channel quiet; genuine errors still surfaced | 🟡 Logger behaviour covered in `test/utils/**`; **"errors still reach the user" is a judgement call** |
| 13.5 | Turn `autoCheckUpdates` off and reload | No update check on activation | 🔴 `updateCheck.enabled` scheduling is covered by `test/services/update-scheduler.property.test.ts`, but **`autoCheckUpdates` appears in no behavioural test** — only as a serialized field in `packages/app/test/registry/registry-settings.test.ts` |
| 13.6 | `Export Settings`, then `Import Settings` into a clean profile | Full configuration round-trips | 🟡 `packages/app/test/registry/registry-settings.test.ts` covers serialization properly (JSON/YAML, version checks, replace strategy). `test/commands/settings-commands.test.ts` only asserts the commands are callable. **The clean-profile round-trip is manual** |
| 13.7 | `Open Settings` | Extension's settings scope opens directly | 🔴 No test references the `openSettings` command |
| 13.8 | Compare `reference/settings.md` against `package.json` | Names, types, defaults and enums match exactly | 🔴 **No test compares docs against the manifest.** Easy automation win |

## TP-14 — Authoring, Scaffolding and Publishing

Local authoring is well covered. Everything involving a real GitHub runner is not covered at all.

| # | Scenario | Expected result | Automation → where to focus |
|---|---|---|---|
| ⭐ 14.1 | `Scaffold Project` into an **empty folder** | Documented structure created, including the CI workflow | 🟢 `test/commands/scaffold-command.test.ts` (directory structure, example files), `test/e2e/github-scaffold-integration.test.ts`, `packages/cli/test/commands/scaffolding.test.ts` |
| 14.2 | `Scaffold Project` in a workspace that already has content | Existing files untouched; nothing clobbered | 🟢 `test/commands/scaffold-command.test.ts` ("should not overwrite existing directory") |
| ⭐ 14.3 | `Add Resource` for each of prompt, instruction, agent and skill, plus a `README.md` | Each created with valid frontmatter from the template | 🟢 `packages/app/test/collection/generate-skill.test.ts`, `lib/test/skills.test.ts` |
| 14.4 | `Create New Collection` | Valid `deployment-manifest.yml` with id, version and name | 🟢 `lib/test/generate-manifest.test.ts`, `packages/core/test/domain/collection/manifest-validator.test.ts` |
| ⭐ 14.5 | `Validate Collections` against it | Passes | 🟢 `lib/test/validate.test.ts`, `lib/test/collections.test.ts` |
| 14.6 | Break the manifest, re-run `Validate Collections` | Errors precise and located | 🟢 `lib/test/validate.test.ts` |
| 14.7 | `Validate APM Package` on a sample package | Reported against `schemas/apm.schema.json` | 🟢 `packages/infra/test/adapters/apm-adapter.test.ts` |
| ⭐ 14.8 | Push to a **real GitHub repository** with the scaffolded runner configuration | Workflow runs and validation passes on the runner | 🔴 **The scaffolded workflow is generated but never executed on a runner** |
| ⭐ 14.9 | Let the workflow finish | A **release is pushed to GitHub** with the expected artifacts and correct version | 🔴 `lib/test/publish-collections.test.ts` is dry-run only. **No real publish is ever tested** |
| ⭐ 14.10 | Change the collection and push again | A new release with a correctly incremented version — not a re-tag, not a skipped bump | 🟡 Version maths covered by `lib/test/hub-release-analyzer.test.ts` and `version-compute`. **Real second release is unverified** |
| 14.11 | `List All Collections` | Complete listing | 🟢 `lib/test/collections.test.ts`, `packages/cli/test/commands/collection-bundle.test.ts` |
| 14.12 | Open a collection, manifest and hub config in the editor | Bundled schemas give completion and inline validation | 🔴 Editor schema association is not tested |
| ⭐ 14.13 | Run 14.1, 14.3, 14.5 and the publish flow through the **CLI** | Same result as the extension | 🟡 Per-command coverage exists. **Cross-layer parity is manual** |

## TP-15 — CLI (`ai-primitives-hub`)

The bar is parity: the same operation must produce the same on-disk result as the extension. Per-command behaviour is well covered; **the parity claim itself is not covered by anything.**

| # | Scenario | Expected result | Automation → where to focus |
|---|---|---|---|
| 15.1 | `--help`, `--version`, and a subcommand's `--help` | Help renders correctly at every level | 🟢 `packages/cli/test/framework/help-renderer.test.ts`, `golden.test.ts` |
| ⭐ 15.2 | `init`, `status`, `doctor` in a real project | Each reports the environment accurately | 🟡 `packages/cli/test/commands/doctor-status-init-update.test.ts` uses a test context. **A real project is the gap** |
| ⭐ 15.3 | `install`, `apply`, `update`, `uninstall` for a bundle | On-disk result matches the extension for the same bundle | 🟡 `packages/cli/test/commands/install.test.ts`, `uninstall.test.ts`. **Nothing diffs against the extension** |
| ⭐ 15.4 | `source`, `hub`, `profile` subcommands | Parity with the equivalent extension commands | 🟡 `packages/cli/test/commands/source.test.ts`, `hub.test.ts`, `profile.test.ts` — each alone |
| ⭐ 15.5 | `target-types`, then `target-add` for both `vscode` and `kiro` | Both listed as supported; both persisted and reflected in `target-list` | 🟢 `packages/cli/test/commands/target.test.ts`, `packages/infra/test/stores/target-state-store.test.ts` |
| ⭐ 15.6 | Install the same collection with `vscode` and with `kiro` as the target | Files land under `.copilot`/`.github` and `.kiro` respectively, matching what the extension produces in each host | 🟡 Transformers covered per target. **The cross-layer match is manual** |
| 15.7 | `target-remove` for one of them | Removed without disturbing the other target's installed content | 🟢 `packages/cli/test/commands/target.test.ts` |
| 15.8 | `discover` in a real project | Recommendations sensible for the detected context | 🟡 `packages/cli/test/commands/discover.test.ts`, `packages/app/test/discovery/recommendation-engine.test.ts`. **Whether results are *useful* is a judgement** |
| 15.9 | `collection-create/list/validate/affected`, `bundle-build`, `bundle-manifest`, `version-compute` | Correct outputs on a sample collection | 🟢 `packages/cli/test/commands/collection-bundle.test.ts` |
| 15.10 | Generators — `skill-create`, `skill-new`, `skill-validate`, `agent-create`, `hook-create`, `prompt-create`, `instruction-create`, `plugin-create`, `plugins-list` | Each produces a valid artifact | 🟢 `packages/cli/test/commands/scaffolding.test.ts`, `misc.test.ts` |
| 15.11 | Index pipeline — `index-harvest`, `index-build`, `index-search`, `index-shortlist`, `index-stats`, `index-report`, `index-export`, `index-eval` | Index round-trips; search returns expected hits | 🟢 `packages/infra/test/search/**` including `eval-pattern` and `bench` |
| 15.12 | `config-get`, `config-list` | Output reflects real configuration | 🟡 `packages/cli/test/framework/config.test.ts` covers resolution precedence thoroughly (defaults, project, user/XDG, env coercion). **The two commands' own output is not asserted** |
| 15.13 | `completion` for each supported shell | Installs and works | 🟡 `packages/cli/test/commands/completion.test.ts` covers generation. **Installing into a real shell is manual** |
| 15.14 | SEA binary from `pnpm -C packages/cli run build:sea`, on a machine with no Node.js | Runs standalone | 🔴 **`build:sea` never runs in CI.** No test executes the binary |

The CLI has no editor to detect, so it takes the host as an **explicit target** rather than inferring it. That difference is the point of 15.5–15.7: a host bug can exist in one delivery layer and not the other.

## TP-16 — Collection Scripts (`lib`)

| # | Scenario | Expected result | Automation → where to focus |
|---|---|---|---|
| 16.1 | Install from a clean `npx`, run each of the 11 bins with `--help` | Every bin present and self-documenting | 🔴 `lib/test/cli.test.ts` only tests argument-parsing helpers (`parseSingleArg`, `parseMultiArg`). **No test invokes a bin or its `--help`** |
| ⭐ 16.2 | `validate-collections` and `validate-skills` on valid input | Both pass | 🟢 `lib/test/validate.test.ts`, `lib/test/skills.test.ts` |
| 16.3 | The same two on deliberately invalid input | Failures precise and located | 🟢 `lib/test/validate.test.ts` |
| ⭐ 16.4 | `build-collection-bundle`, `generate-manifest`, `compute-collection-version` twice on the same input | Deterministic and reproducible | 🟢 `lib/test/generate-manifest.test.ts`, `lib/test/bundle-id.test.ts` |
| 16.5 | `detect-affected-collections` against a real diff | Correct affected set | 🟡 `lib/test/collections.test.ts`. **A real Git diff is the gap** |
| 16.6 | `publish-collections` in dry-run | Nothing published | 🟢 `lib/test/publish-collections.test.ts` |
| 16.7 | `list-collections`, `create-skill`, `hub-release-analyzer`, `hub-ownership-analyzer` | Expected report or artifact | 🟡 `lib/test/hub-release-analyzer.test.ts` covers one of the four; **`hub-ownership-analyzer` has no test** |
| ⭐ 16.8 | The `github-actions/validate-collections` action on a sample repository | Passes and fails as expected | 🔴 **This action has no test suite at all**, and consumers depend on it in their own CI |

## TP-17 — Upgrade and Migration from the Previous Major — **cannot be waived**

Run against real state, not a fixture. The migration *mechanism* is covered; **real upgrade-in-place from a previously shipped version is not.**

| # | Scenario | Expected result | Automation → where to focus |
|---|---|---|---|
| ⭐ 17.1 | Install the **previous major**, build real state — hubs, sources, profiles, favorites, bundles at user and repository scope | A representative starting point exists on disk | 🔴 **No previous-major state fixture exists anywhere** |
| ⭐ 17.2 | Install this release over the top and activate | Migrations run once and complete without error | 🟡 `test/services/migration-registry.test.ts` runs migrations against synthetic state. **Real accumulated state is the gap** |
| ⭐ 17.3 | Inspect all the state from 17.1 | Everything survives intact; nothing silently dropped | 🔴 Nothing asserts survival of state written by a previous release |
| 17.4 | Check the source-id normalization migration | Legacy ids normalized and every reference updated | 🟢 `test/migrations/source-id-normalization-migration.test.ts` |
| 17.5 | Reload and activate again | Migration does not re-run; provably idempotent | 🟢 `test/services/migration-registry.test.ts` |
| ⭐ 17.6 | Run 17.1–17.5 in **VS Code**, then repeat the whole sequence in **Kiro** | Migration works in both hosts; Kiro state is not migrated into VS Code paths or vice versa | 🔴 Kiro unautomated, and no cross-host migration test exists |
| ⭐ 17.7 | On migrated state, confirm installed content is still where the current host expects it | Kiro content still under `.kiro/`, VS Code content still under `.github/` and `~/.copilot/` | 🟡 Path resolution covered by `packages/infra/test/storage/xdg-app-storage.test.ts`. **Post-migration reality is manual** |
| ⭐ 17.8 | Exercise G1 and G3 against the migrated state | Works on migrated data, not only on freshly created data | 🔴 All suites start from clean state |

## TP-18 — Publish and Distribution

Almost entirely manual by nature — it involves real registries and real releases.

| # | Scenario | Expected result | Automation → where to focus |
|---|---|---|---|
| 18.1 | Trigger the `Publishing` workflow on a pre-release tag | Every job completes green | 🟡 The workflow gates itself (tag format, audit, Trivy). **A dry run against a real tag is the only real check** |
| ⭐ 18.2 | Review the VS Code Marketplace listing | Correct version, README, icon and categories | 🔴 No coverage |
| 18.3 | Review the Open VSX listing | Same | 🔴 No coverage |
| ⭐ 18.4 | Install from each marketplace into a clean **VS Code**, and into a clean **Kiro** | Works end to end in both; Kiro can install the published artifact, not only a local VSIX | 🔴 No coverage |
| 18.5 | Download the release installation bundle; run `install.sh`, then `install.bat` on Windows | Both install successfully | 🔴 The generated install scripts are never executed by CI |
| 18.6 | Verify the checksums and SLSA provenance attached to the release | Both verify | 🟡 The publish workflow generates and verifies checksums. **Provenance is only verifiable on the real release** |
| 18.7 | Confirm the rollback path | Previous version still installable; procedure written down | 🔴 No coverage |

## TP-19 — Documentation and Release Notes

| # | Scenario | Expected result | Automation → where to focus |
|---|---|---|---|
| 19.1 | Compare `reference/commands.md` and `reference/settings.md` against `package.json` | Both match exactly | 🔴 **No docs-vs-manifest check exists.** Same easy automation win as 13.8 |
| 19.2 | Review user guide pages for every changed behaviour | Updated to match the shipped build | 🔴 Editorial judgement |
| 19.3 | `pnpm -C website run build` | Clean build; new pages registered in `docs/README.md` and `website/sidebars.ts` | 🟢 Enforced by the `docs.yml` workflow |
| 19.4 | Read the release notes end to end | Every breaking change listed with a migration note | 🔴 Editorial judgement |
| 19.5 | Check version references in `README.md` | Updated by `version:bump:major` | 🟡 `version:update` rewrites them. **Nothing verifies the result** |
| 19.6 | Regenerate helper skill references via `copy-skill-references` | Reflect the current `docs/` tree | 🔴 **Nothing detects a stale generated index** |

---

## Where The Coverage Gaps Cluster

Pulled out of the tables above. Five themes account for nearly every 🔴 row, and each is a candidate for [#370](https://github.com/AmadeusITGroup/ai-primitives-hub/issues/370):

| Gap | Rows affected | Why automation does not reach it today |
|---|---|---|
| **Nothing runs in Kiro** | 1.2, 6.7, 7.3, 7.4, 8.6, 9.2, 11.3, 12.1, 12.3, 13.3, 17.6 | `@vscode/test-electron` only downloads VS Code stable/insiders |
| **Host agents consuming our output** | 7.9, 10.9 | Needs a live Copilot or Kiro agent, not files on disk |
| **Real GitHub — runners, releases, private repos** | 5.8, 14.8, 14.9, 18.x | Suites use `nock`; `publish-collections` is dry-run only |
| **Cross-layer parity (extension vs CLI)** | 7.14, 14.13, 15.3, 15.4, 15.6 | Both layers tested in isolation; nothing diffs their output |
| **Previous-major upgrade state** | 11.9, 17.1, 17.3, 17.8 | No captured fixture of state written by a shipped release |
| **Command surface breadth** | 1.5, 13.1, 13.5, 13.7 | Only 6 of 66 commands and 4 of 9 settings are asserted anywhere |

Three cheap wins worth filing separately: a docs-vs-manifest check would close 13.8 and 19.1, a staleness check on the generated skill reference index would close 19.6, and extending `test/config/package-configuration.test.ts` to all 9 settings plus a `getCommands()` sweep over all 66 would close 1.5, 1.6 and 13.1 at once.

Two claims in earlier drafts of this page were wrong and are worth stating plainly, because the same mistake is easy to repeat: hub profile **sync history and rollback are well covered** (`test/commands/hub-sync-history.test.ts`), and `test/commands/**` covers far more of the command surface than the service-level suites suggest. Check `test/commands/` before assuming a command is unautomated.

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
