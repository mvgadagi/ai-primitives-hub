# Primitives review action

Reviews AI primitives (prompts, instructions, agents, skills) against a quality rubric with Gemma 4 on the runner. On a pull request it reviews only the changed files that match your path patterns. It passes or fails the check on a grade threshold and posts one PR comment with the results, updated on every push. No API key is needed.

## Use it in a pull request workflow

```yaml
# .github/workflows/primitives-review.yml
name: Primitives review
on:
  pull_request:

permissions:
  contents: read
  pull-requests: write # to post the comment

jobs:
  review:
    runs-on: ubuntu-latest
    timeout-minutes: 45
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0 # needed to diff the pull request
      - uses: AmadeusITGroup/ai-primitives-hub/github-actions/primitives-review@<commit-sha>
        with:
          paths: skills/* prompts/* # default '*': every primitive in the PR
          fail-below: C             # default C; empty never fails
```

Pin the action to a full commit SHA. Pull requests from forks get a read-only token: the review and status still work, but the comment is skipped with a warning.

## What it does

1. **Selects files.** It takes the files added, modified or renamed in the PR (`scope: changed`, the default on pull requests) or every file (`scope: all`). It keeps those matching `paths`, then keeps primitives only: `*.prompt.md`, `*.instructions.md`, `AGENTS.md`/`CLAUDE.md`/`GEMINI.md`, `.kiro/steering/*.md`, `*.agent.md`, `*.chatmode.md` and `SKILL.md`.
2. **Optional static scan.** With `cli-version` (or `scanner-command`), the AI Primitives Hub security scanner runs on those files.
3. **Rubric review.** Gemma 4 scores each file 1–5 on the criteria in [`rubric.json`](rubric.json), with evidence and one suggestion per criterion. The score is a weighted 0–100 and the grade A (85+), B (70+), C (55+), D (40+) or E.
4. **Status and comment.** A file passes when its grade meets `fail-below`. Any failing file fails the step. The report goes to the PR comment, the job summary, and the `primitives-review` artifact.

`paths` takes glob patterns separated by spaces or newlines. `*` also matches `/`, a directory means everything under it, and a leading `!` excludes. Examples: `*`, `skills/*`, `*.prompt.md`, `* !test/*`.

## The rubric

| ID | Criterion | Weight | Based on |
|---|---|---|---|
| R1 | Purpose and scope | 2 | Primitive types, single responsibility, CTL-005 |
| R2 | Structure and metadata | 1 | Type structure, naming conventions, required skill frontmatter, SKL-004, SKL-007 |
| R3 | Clarity of instructions | 2 | Content quality, AGT-008, AGT-009, INJ-007 |
| R4 | Examples, edge cases and limitations | 1 | Content quality, clear documentation |
| R5 | Least privilege and tools | 2 | Allowed tools and tool minimization, AGT-\*, MCP-\*, SKL-003, SKL-010 |
| R6 | Safe execution and human control | 2 | HKS-\*, ASI-\*, AGT-003, SKL-001, SKL-005, LLM-004, LLM-008 |
| R7 | Untrusted input and data protection | 2 | INJ-\*, SEC-\*, MD-\*, LLM-002, CTL-011, CTL-014, CTL-015 |

The criteria come from the [author guides](../../docs/author-guide/agentic-primitives-guide.md) and the [security detection rules](../../docs/reference/security-rules.md). Pass your own rubric with `rubric-file`.

Scores are kept grounded in four ways:
- **Checked facts:** frontmatter, title, sections, naming and wildcard tools are checked by script and can cap or set a minimum for a score.
- **Scanner caps:** a static finding caps the matching criterion: CRITICAL at 1, HIGH at 2, MEDIUM at 3.
- **Evidence check:** a risk whose quote is not in the file is dropped.
- **Untrusted content:** instructions inside a primitive are reported as `INJ` risks, never followed.

## Inputs

| Input | Default | Description |
|---|---|---|
| `paths` | `*` | Glob patterns of files to review. |
| `scope` | `auto` | `changed`, `all`, or `auto` (`changed` on pull requests). |
| `fail-below` | `C` | Fail when a file grades below this letter; empty never fails. |
| `comment` | `true` | Post or update the PR comment. |
| `github-token` | `github.token` | Lists PR files (shallow checkouts) and posts the comment. |
| `rubric-file` | bundled | Custom rubric JSON. |
| `model` | `gemma4:e2b` | Ollama model tag. |
| `cli-version` | | `@ai-primitives-hub/cli` version with `security scan`, to add scanner findings and caps. |
| `scanner-command` | | Run a CLI built in your repository instead. |
| `include-llm-controls` | `false` | Pass `--include-llm-controls` to the scanner. |
| `max-files`, `max-file-bytes` | `20`, `12000` | Limits on files reviewed and bytes per file. |
| `num-ctx`, `max-tokens`, `request-timeout` | `16384`, `2048`, `600` | Model limits per file. |
| `step-summary` | `true` | Write the report to the job summary. |
| `ollama-version`, `ollama-host`, `cache` | `v0.40.13`, `127.0.0.1:11434`, `true` | See the [Gemma 4 action](../gemma4/README.md). |

Outputs: `status` (`success` or `failure`), `reviewed`, `failed`, `average-score`, `lowest-grade`, `report-json`, `report-markdown`.

## Limits

- Grades from `gemma4:e2b` are a first-pass signal to focus human review. Each file takes 5–15 seconds on a laptop, longer on CPU-only hosted runners. The first run downloads about 4.6 GB, which is then cached.
- The rubric does not review collections, hooks or MCP configuration. The static scanner still covers Claude settings.
- At the time of writing, the published CLI (0.2.1) does not include `security scan`, so `cli-version` only works with a later release.
