#!/usr/bin/env bash
# Selects the AI primitives to review and runs the optional static security scan.
#
# Selection: files matching INPUT_PATHS (glob patterns, `!` to exclude). In changed scope
# only the files added, modified or renamed in the pull request are considered; in all scope
# every file in the repository (minus .gitignore) is.
#
# Writes (JSON lines) to WORK_DIR: primitives.jsonl {path, type} and findings.jsonl.
#
# Inputs (environment):
#   INPUT_PATHS        space/newline-separated patterns (default "*"); `*` also matches `/`
#   INPUT_SCOPE        auto | changed | all (auto = changed on pull requests, else all)
#   INPUT_MAX_FILES    maximum primitives to review (default 20)
#   EVENT_NAME, BASE_SHA, HEAD_SHA, PR_NUMBER, REPOSITORY, GH_TOKEN   pull request context
#   INPUT_CLI_VERSION, SCANNER_CMD, INPUT_INCLUDE_LLM_CONTROLS        static scanner
#   WORK_DIR
set -euo pipefail

: "${WORK_DIR:?}"
workspace="${GITHUB_WORKSPACE:-$PWD}"
out="${GITHUB_OUTPUT:-/dev/stdout}"
max_files="${INPUT_MAX_FILES:-20}"
[[ "$max_files" =~ ^[0-9]+$ ]] || { echo "::error::max-files must be a whole number, got '${max_files}'"; exit 1; }
mkdir -p "$WORK_DIR"
primitives="${WORK_DIR}/primitives.jsonl"
findings="${WORK_DIR}/findings.jsonl"
: >"$primitives"
: >"$findings"
cd "$workspace"

# Primitive type for a path, or nothing when the file is not a primitive.
primitive_type() {
  case "$(basename "$1")" in
    *.prompt.md) echo prompt ;;
    *.instructions.md | AGENTS.md | CLAUDE.md | GEMINI.md | copilot-instructions.md) echo instruction ;;
    *.agent.md | *.chatmode.md) echo agent ;;
    SKILL.md) echo skill ;;
    *.md) [[ "/$1" == */.kiro/steering/* ]] && echo instruction ;;
  esac
  return 0
}

# --- Scope ---------------------------------------------------------------------------------
scope="${INPUT_SCOPE:-auto}"
case "$scope" in
  auto) [[ "${EVENT_NAME:-}" == pull_request* ]] && scope=changed || scope=all ;;
  changed | all) ;;
  *) echo "::error::scope must be auto, changed or all, got '${scope}'"; exit 1 ;;
esac
if [[ "$scope" == changed && -z "${BASE_SHA:-}" ]]; then
  echo "::error::scope 'changed' needs a pull_request event (no base commit found)."
  exit 1
fi

candidates="${WORK_DIR}/candidates.txt"
if [[ "$scope" == changed ]]; then
  # Prefer local history; fall back to the API when the checkout is shallow.
  if git cat-file -e "${BASE_SHA}^{commit}" 2>/dev/null && git cat-file -e "${HEAD_SHA}^{commit}" 2>/dev/null; then
    git diff --name-only --diff-filter=AMR "$(git merge-base "$BASE_SHA" "$HEAD_SHA")" "$HEAD_SHA" >"$candidates"
  elif [[ -n "${PR_NUMBER:-}" && -n "${REPOSITORY:-}" ]]; then
    gh api --paginate "repos/${REPOSITORY}/pulls/${PR_NUMBER}/files" \
      --jq '.[] | select(.status != "removed") | .filename' >"$candidates" ||
      { echo "::error::Could not list the pull request's files. Use fetch-depth: 0 or allow contents: read."; exit 1; }
  else
    echo "::error::The base commit is not in the checkout; use actions/checkout with fetch-depth: 0."
    exit 1
  fi
elif git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git ls-files -co --exclude-standard >"$candidates"
else
  find . \( -name .git -o -name node_modules \) -prune -o -type f -print | sed 's|^\./||' >"$candidates"
fi

# --- Path patterns -------------------------------------------------------------------------
include=()
exclude=()
read -r -a patterns <<<"$(tr '\n' ' ' <<<"${INPUT_PATHS:-*}")"
[[ ${#patterns[@]} -gt 0 ]] || patterns=('*')
for p in "${patterns[@]}"; do
  negate=false
  [[ "$p" == '!'* ]] && { negate=true; p="${p#!}"; }
  p="${p#./}"
  [[ "$p" == . || -z "$p" ]] && p='*'
  [[ "$p" != *'*'* && "$p" != *'?'* && -d "$p" ]] && p="${p%/}/*" # a directory means everything under it
  if [[ "$negate" == true ]]; then exclude+=("$p"); else include+=("$p"); fi
done
[[ ${#include[@]} -gt 0 ]] || include=('*')

matches() {
  local f="$1" p
  for p in "${exclude[@]+"${exclude[@]}"}"; do
    # shellcheck disable=SC2053 # the pattern is intentionally unquoted
    [[ "$f" == $p ]] && return 1
  done
  for p in "${include[@]}"; do
    # shellcheck disable=SC2053
    [[ "$f" == $p ]] && return 0
  done
  return 1
}

total=0
while IFS= read -r f; do
  [[ -f "$f" ]] || continue
  matches "$f" || continue
  type="$(primitive_type "$f")"
  [[ -n "$type" ]] || continue
  total=$((total + 1))
  ((total <= max_files)) && jq -cn --arg path "$f" --arg type "$type" '{path: $path, type: $type}' >>"$primitives"
done < <(sort -u "$candidates")

count="$(wc -l <"$primitives" | tr -d ' ')"
((total > max_files)) && echo "::warning::Found ${total} primitives; reviewing the first ${max_files} (raise max-files to review more)."
echo "Scope: ${scope}; patterns: ${include[*]}${exclude[*]+ (excluding ${exclude[*]})}; primitives to review: ${count}"
{
  echo "scope=${scope}"
  echo "count=${count}"
} >>"$out"
((count > 0)) || exit 0

# --- Optional static scan (advisory input to the rubric; never fails here) -----------------
if [[ -n "${SCANNER_CMD:-}" ]]; then
  read -r -a scanner <<<"$SCANNER_CMD"
elif [[ -n "${INPUT_CLI_VERSION:-}" ]]; then
  scanner=(npx --yes "@ai-primitives-hub/cli@${INPUT_CLI_VERSION}")
else
  echo "Static scan skipped (set cli-version to include scanner findings)."
  exit 0
fi
files=()
while IFS= read -r p; do files+=("$p"); done < <(jq -r '.path' "$primitives")
args=(security scan --ci --ignore-trust none --fail-on none -o json)
[[ "${INPUT_INCLUDE_LLM_CONTROLS:-false}" == true ]] && args+=(--include-llm-controls)

raw="${WORK_DIR}/scan.json"
set +e
"${scanner[@]}" "${args[@]}" -- "${files[@]}" >"$raw" 2>"${raw}.err"
status=$?
set -e
if ! jq -e '.data.findings' "$raw" >/dev/null 2>&1; then
  echo "::warning::The static scanner produced no JSON report (exit ${status}); continuing without its findings. $(head -c 300 "${raw}.err")"
  exit 0
fi
# Finding paths are relative to the scan root; turn them into workspace-relative paths.
jq -c --arg ws "$(pwd -P)" '
  .data.findings[] | . as $f
  | (($f.rootId // "") | if . == "" then $ws else . end) as $root
  | (if ($root | endswith(".md")) then $root else ($root + "/" + $f.file) end | ltrimstr($ws + "/")) as $path
  | {path: $path, ruleId: $f.ruleId, severity: $f.severity, line: $f.line, title: $f.title, fix: ($f.recommendedFix // "")}
' "$raw" >"$findings"
echo "Static findings: $(wc -l <"$findings" | tr -d ' ')"
