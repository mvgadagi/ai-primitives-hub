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

The path every user walks on day one: install, connect a hub, install content from two source types at both scopes for both hosts, and have their AI agent actually pick it up.

### Steps

| # | Step | Expected result |
|---|---|---|
| G1.1 | Install the extension into a clean **VS Code** profile, and into a clean **Kiro** profile; reload each | Activates cleanly in both, both views render, setup flow appears once |
| G1.2 | In each host, read the `[host-app] detectHostApp:` line in the Output channel | Resolves to `vscode` in VS Code and `kiro` in Kiro — **not** the silent `vscode` fallback while running in Kiro |
| G1.3 | Connect a hub and confirm it exposes a **GitHub** source | The source enumerates its bundles |
| G1.4 | Install a collection containing **every primitive kind** plus a `README.md`, covering all four combinations in the matrix below | Files land at the documented destination each time |
| G1.5 | Confirm every primitive kind landed somewhere | Nothing silently dropped because a host has no route for that kind |
| G1.6 | Open GitHub Copilot Chat in VS Code | Prompts invocable, instructions applied, agents/chatmodes selectable |
| G1.7 | Open Kiro | Steering files in effect, agents and skills available |
| G1.8 | Open the bundle details view in the extension | The collection `README.md` renders correctly |
| G1.9 | Repeat G1.4 through the **CLI** | Same files, same destinations, same lockfile result |

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

| # | Step | Expected result |
|---|---|---|
| G2.1 | Scaffold a new project into an **empty folder**; add primitives of each kind and a `README.md` | Documented structure created, including the CI workflow |
| G2.2 | Validate the collection locally | Passes |
| G2.3 | Create a real GitHub repository and push | The scaffolded runner configuration is picked up and the workflow runs |
| G2.4 | Let the workflow complete | Validation passes on the runner and a **release is pushed to GitHub** with the expected artifacts |
| G2.5 | Add that repository manually as a source in AI Primitives Hub and sync it | The new collection is discovered |
| G2.6 | Install it | Installs correctly, routed per host as in G1 |
| G2.7 | Add the same content as a **local** source and sync | Discovered and installable from the local path too |
| G2.8 | Run G2.1, G2.2 and G2.5–G2.7 through the **CLI** | Same result as the extension |

### What matters most

G2.4 fails more often than anything else in this document and is invisible to local testing. The runner configuration that ships in the scaffold has to work on GitHub's actual runners and actually produce a release — a green local validation says nothing about either.

---

## G3 — Update

Runs immediately after G2, against the collection you just published. Do not reset state in between.

| # | Step | Expected result |
|---|---|---|
| G3.1 | Change the collection from G2 and push | The workflow runs again |
| G3.2 | Let it publish | A **new release** with a correctly incremented version — not a re-tag, not a skipped bump |
| G3.3 | Wait for the extension's update check, or trigger it manually | The user is **notified** an update is available |
| G3.4 | Apply the update from the extension | Version advances; content replaced, not duplicated |
| G3.5 | Check for updates from the **CLI** | Proposed automatically, or reported when checked |
| G3.6 | Apply the update from the CLI | Same result as G3.4 |
| G3.7 | Verify the updated primitives in Copilot and Kiro | Agents pick up the new content; stale content is gone |

### What matters most

This closes the loop the other two scenarios open: author publishes → consumer is told → consumer updates → the agent sees the change. Each link is covered by automation in isolation; the chain is not.

---

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
