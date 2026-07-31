# Golden Path Test Cases

The mandatory manual verification. **Every release must pass all three scenarios, on both the extension and the CLI.**

If you only ever run one page in this repository, run this one. The [Full Test Plan](./test-plan.md) exists for area-by-area coverage when a PR touches something specific — it is not expected to be executed in full for every release. This page is.

## Why These Three

A gate nobody runs is worse than no gate. These scenarios were chosen on two criteria: each crosses a boundary automation cannot reach on its own, and together they **chain** — G2 produces the collection that G3 updates, so you set up once and get three passes out of it.

| | Scenario | Boundary it crosses | Full-plan coverage |
|---|---|---|---|
| **G1** | [Collection user](#g1--collection-user) | Whether the host AI agent actually recognizes what we installed | TP-01, TP-04, TP-05, TP-07 |
| **G2** | [Collection author](#g2--collection-author) | Real GitHub — runners, releases, published artifacts | TP-14, TP-05 |
| **G3** | [Update](#g3--update) | The publish-to-notify loop, end to end | TP-10 |

Every step here also appears as a ⭐ row in the [Full Test Plan](./test-plan.md), so the two pages stay in step instead of drifting apart.

## Reading The Automation Column

Each step carries the automation that already covers it, so your attention lands where it is actually needed. See [#370](https://github.com/AmadeusITGroup/ai-primitives-hub/issues/370) for the work of growing this coverage.

| Marker | Meaning | How to treat it |
|---|---|---|
| 🟢 **Auto** | The logic is asserted by a test suite | Quick confirmation. First thing to drop when short on time |
| 🟡 **Partial** | Automation covers the logic, but not the real host, network or rendering | Focus on the named gap, not the logic |
| 🔴 **Manual** | No automated coverage exists | **Full attention.** These are the reason this page exists |

Suite paths are relative to `apps/vscode-extension/` for `test/…` and to the repository root for `packages/…` and `lib/…`.

## Before You Start

Run the automated suites first — see [Validation](../validation.md). This page assumes they are green and covers only what a person has to see with their own eyes.

You need:

- A clean VS Code profile
- Kiro installed
- A GitHub account you can create a repository under
- The CLI available (`ai-primitives-hub`)

Do not reset state between G2 and G3. They are deliberately continuous.

---

## G1 — Collection User

The path every user walks on day one: install, connect a hub, install content at both scopes for both hosts, and have their AI agent actually pick it up.

### Steps

| # | Step | Expected result | Automation → where to focus |
|---|---|---|---|
| G1.1 | Install the extension into a clean **VS Code** profile, and into a clean **Kiro** profile; reload each | Activates cleanly in both, both views render, setup flow appears once | 🟡 Activation covered by `test/suite/integration-scenarios.test.ts` — but only in VS Code. **Installing the packaged VSIX, and anything in Kiro, is unautomated** |
| G1.2 | In each host, read the `[host-app] detectHostApp:` line in the Output channel | Resolves to `vscode` in VS Code and `kiro` in Kiro — **not** the silent `vscode` fallback while running in Kiro | 🟡 `packages/infra/test/host-app/host-app-target.test.ts` asserts the signal→target mapping. The **real `appName`/`uriScheme` Kiro reports** is never exercised |
| G1.3 | Connect a hub and confirm it exposes a **GitHub** source | The source enumerates its bundles | 🟢 `packages/app/test/registry/hub-manager.test.ts`, `packages/infra/test/adapters/github-adapter.test.ts` |
| G1.4 | Install a collection containing **every primitive kind** plus a `README.md`, covering all four combinations in the matrix below | Files land at the documented destination each time | 🟢 `packages/app/test/install/layout-resolver.test.ts`, `install-bundle.test.ts`, `packages/app/test/transform/kiro-transformer.test.ts` |
| G1.5 | Confirm every primitive kind landed somewhere | Nothing silently dropped because a host has no route for that kind | 🟡 Routing is covered per host. **A kind with no route for the target host is the weak spot** — confirm the outcome is deliberate, not a silent drop |
| G1.6 | Open GitHub Copilot Chat in VS Code | Prompts invocable, instructions applied, agents/chatmodes selectable | 🔴 **Nothing asserts a real agent consumes our output.** Highest-value step on this page |
| G1.7 | Open Kiro | Steering files in effect, agents and skills available | 🔴 As above, and Kiro has no automated coverage at all |
| G1.8 | Open the bundle details view in the extension | The collection `README.md` renders correctly | 🟡 `test/ui/marketplace-view-provider.test.ts` covers the wiring. **Rendered markdown is unverified** |
| G1.9 | Repeat G1.4 through the **CLI** | Same files, same destinations, same lockfile result | 🟡 `packages/cli/test/commands/install.test.ts` covers the CLI in isolation. **No test compares CLI output against extension output** — that parity is only ever checked here |

### Install matrix for G1.4

All four installs come from the same **GitHub** source — the variables are scope and host.

| Scope | Host | Destination |
|---|---|---|
| user | VS Code | `~/.copilot/{prompts,instructions,agents,skills,hooks,plugins}/` |
| repository | VS Code | `<workspace>/.github/{prompts,instructions,agents,skills,hooks,plugins}/` |
| user | Kiro | `~/.kiro/{steering,agents,skills}/` |
| repository | Kiro | `<workspace>/.kiro/{steering,agents,skills}/` |

Destinations come from `packages/infra/src/writers/default-layouts.json`. Host routing differs in ways that matter here:

- **Kiro** folds `prompts/` **and** `instructions/` into `steering/`, and has no `hooks/` or `plugins/` route.
- **VS Code** routes `chatmodes/` into `agents/`.
- `deployment-manifest.yml` and `README.md` are in `skipPaths` for every host, so they must **not** appear in the installed layout. The README is verified in the bundle details view (G1.8), not on disk.

### What matters most

G1.6 and G1.7 are the reason this scenario is manual. Files landing in the right directory is not the same as the host agent recognizing them — verify behaviour in the agent, not just paths on disk.

For repository-scope installs, also confirm `prompt-registry.lock.json` is written and the files are where a teammate cloning the repo would find them.

---

## G2 — Collection Author

The path a collection author walks. Uses a real GitHub repository, because runners and releases cannot be faked locally.

| # | Step | Expected result | Automation → where to focus |
|---|---|---|---|
| G2.1 | Scaffold a new project into an **empty folder**; add primitives of each kind and a `README.md` | Documented structure created, including the CI workflow | 🟢 `packages/cli/test/commands/scaffolding.test.ts`, `test/e2e/github-scaffold-integration.test.ts` |
| G2.2 | Validate the collection locally | Passes | 🟢 `lib/test/validate.test.ts`, `packages/core/test/domain/collection/*` |
| G2.3 | Create a real GitHub repository and push | The scaffolded runner configuration is picked up and the workflow runs | 🔴 **Nothing runs the scaffolded workflow on a real runner.** The workflow file is generated but never executed by our tests |
| G2.4 | Let the workflow complete | Validation passes on the runner and a **release is pushed to GitHub** with the expected artifacts | 🔴 **No automated coverage.** `lib/test/publish-collections.test.ts` covers the script in dry-run only — never a real publish |
| G2.5 | Add that repository manually as a source in AI Primitives Hub and sync it | The new collection is discovered | 🟢 `packages/app/test/registry/load-hub-sources.test.ts`, `source-sync-queue.test.ts` |
| G2.6 | Install it | Installs correctly, routed per host as in G1 | 🟢 `packages/app/test/install/install-bundle.test.ts` |
| G2.7 | Add the same content as a **local** source and sync | Discovered and installable from the local path too | 🟢 `packages/infra/test/adapters/local-adapter.test.ts` |
| G2.8 | Run G2.1, G2.2 and G2.5–G2.7 through the **CLI** | Same result as the extension | 🟡 Per-command coverage exists in `packages/cli/test/commands/`. **Cross-layer parity is manual** |

### What matters most

G2.3 and G2.4 are the only red rows in this scenario and they are the whole point of it. The runner configuration that ships in the scaffold has to work on GitHub's actual runners and actually produce a release — a green local validation says nothing about either, and we have no test that closes that gap.

---

## G3 — Update

Runs immediately after G2, against the collection you just published. Do not reset state in between.

| # | Step | Expected result | Automation → where to focus |
|---|---|---|---|
| G3.1 | Change the collection from G2 and push | The workflow runs again | 🔴 Same unautomated runner path as G2.3 |
| G3.2 | Let it publish | A **new release** with a correctly incremented version — not a re-tag, not a skipped bump | 🟡 `lib/test/publish-collections.test.ts` and `packages/cli` `version-compute` cover version maths. **Whether a real second push produces a real second release is unverified** |
| G3.3 | Wait for the extension's update check, or trigger it manually | The user is **notified** an update is available | 🟡 Detection covered by `packages/app/test/registry/detect-updates.test.ts` and `test/services/update-system-integration.test.ts`. **The notification a user actually sees is not asserted** |
| G3.4 | Apply the update from the extension | Version advances; content replaced, not duplicated | 🟢 `packages/app/test/registry/update-registry-bundle.test.ts`, `test/e2e/bundle-update-github.test.ts` |
| G3.5 | Check for updates from the **CLI** | Proposed automatically, or reported when checked | 🟢 `packages/cli/test/commands/doctor-status-init-update.test.ts` |
| G3.6 | Apply the update from the CLI | Same result as G3.4 | 🟡 Covered per layer. **Parity with the extension is manual** |
| G3.7 | Verify the updated primitives in Copilot and Kiro | Agents pick up the new content; stale content is gone | 🔴 **No automated coverage.** Same boundary as G1.6/G1.7 |

### What matters most

This closes the loop the other two scenarios open: author publishes → consumer is told → consumer updates → the agent sees the change. Each link is covered by automation in isolation; **the chain is not covered anywhere**.

---

## Where The Real Gaps Are

Pulled out of the tables above, the 🔴 rows are the entire justification for manual testing. If automation ever closes these, this page can shrink:

| Gap | Steps | Why automation cannot reach it today |
|---|---|---|
| Host agents consuming our output | G1.6, G1.7, G3.7 | Requires a running Copilot or Kiro agent, not just files on disk |
| Anything running inside Kiro | G1.1, G1.2, G1.6, G1.7 | The test harness only ever launches VS Code |
| Scaffolded CI on a real runner | G2.3, G3.1 | Needs a real GitHub repository and a real Actions run |
| Real collection release | G2.4, G3.2 | `publish-collections` is only ever tested in dry-run |
| Cross-layer parity (extension vs CLI) | G1.9, G2.8, G3.6 | Both layers are tested in isolation; nothing diffs their results |

## Sign-Off

Record this in the release issue. All three scenarios are mandatory on both delivery layers.

| | Scenario | Extension | CLI | Owner | Date |
|---|---|---|---|---|---|
| **G1** | Collection user | | | | |
| **G2** | Collection author | | | | |
| **G3** | Update | | | | |

For a **MAJOR** release, two plans from the full test plan are also blocking, because both touch state users already have on disk:

| | Plan | Result | Owner | Date |
|---|---|---|---|---|
| **TP-11** | [Repository scope and lockfile](./test-plan.md#tp-11--repository-scope-and-lockfile--cannot-be-waived) | | | |
| **TP-17** | [Upgrade and migration](./test-plan.md#tp-17--upgrade-and-migration-from-the-previous-major--cannot-be-waived) | | | |

Blocking rules:

- G1, G2 and G3 must pass on **both** the extension and the CLI.
- TP-11 and TP-17 block a major release outright.
- Anything else is fixed or recorded as a known issue in the release notes, with an owner and a target release.

## See Also

- [Full Test Plan](./test-plan.md) — all 19 plans, for area-by-area coverage
- [Testing](../testing.md) — running the automated suites
- [Validation](../validation.md) — local validation commands
- [Releasing](../releasing.md) — version bump and publish mechanics
