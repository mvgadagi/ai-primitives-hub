#!/usr/bin/env bash
# Builds report.json and report.md from the review results, decides pass/fail, writes the job
# summary, posts or updates the pull request comment, and fails the step when the review fails.
#
# Inputs (environment):
#   RESULTS_FILE, RUBRIC_FILE, REPORT_DIR, INPUT_MODEL, SCOPE
#   INPUT_FAIL_BELOW     grade letter; fail when any primitive grades below it (empty = never fail)
#   INPUT_STEP_SUMMARY   'true' to append the report to the job summary
#   INPUT_COMMENT        'true' to post the report on the pull request
#   PR_NUMBER, REPOSITORY, GH_TOKEN, RUN_URL
set -euo pipefail

: "${RESULTS_FILE:?}" "${RUBRIC_FILE:?}" "${REPORT_DIR:?}"
out="${GITHUB_OUTPUT:-/dev/stdout}"
marker='<!-- ai-primitives-review -->'
mkdir -p "$REPORT_DIR"
json="${REPORT_DIR}/report.json"
md="${REPORT_DIR}/report.md"
touch "$RESULTS_FILE"

threshold="$(tr '[:lower:]' '[:upper:]' <<<"${INPUT_FAIL_BELOW:-}")"
if [[ -n "$threshold" ]] && ! jq -e --arg g "$threshold" '[.grades[].grade] | index($g) != null' "$RUBRIC_FILE" >/dev/null; then
  echo "::error::fail-below must be one of $(jq -r '[.grades[].grade] | join(", ")' "$RUBRIC_FILE"), got '${threshold}'"
  exit 1
fi

# Grades sort A < B < ... so "below the threshold" is a greater letter. With a threshold set, a
# file the model could not review (grade "?") fails too, so a broken model never passes the gate.
jq -s --slurpfile rubric "$RUBRIC_FILE" --arg model "${INPUT_MODEL:-}" --arg threshold "$threshold" --arg scope "${SCOPE:-}" '
  [.[] | .passed = ($threshold == "" or (.grade != "?" and .grade <= $threshold))] as $p
  | {
      model: $model,
      rubric_version: $rubric[0].version,
      scope: $scope,
      fail_below: (if $threshold == "" then null else $threshold end),
      reviewed: ($p | length),
      failed: ([$p[] | select(.passed | not)] | length),
      errors: ([$p[] | select(.grade == "?")] | length),
      status: (if [$p[] | select(.passed | not)] | length > 0 then "failure" else "success" end),
      average_score: ([$p[].score | select(. != null)] | if length == 0 then null else (add / length | round) end),
      lowest_grade: ([$p[].grade | select(. != "?")] | sort | last // null),
      primitives: $p
    }' "$RESULTS_FILE" >"$json"

jq -r --arg marker "$marker" --arg run_url "${RUN_URL:-}" '
  def cell: tostring | gsub("[\r\n]+"; " ") | gsub("\\|"; "\\|") | if length > 220 then .[0:217] + "..." else . end;
  def code: if . == "" or . == null then "" else "`" + (tostring | gsub("`"; "'\''") | cell) + "`" end;
  def icon: if . == "A" or . == "B" then "🟢" elif . == "C" then "🟡" elif . == "D" then "🟠" elif . == "E" then "🔴" else "⚪" end;
  def sev: if . == "CRITICAL" then "🔴 CRITICAL" elif . == "HIGH" then "🟠 HIGH" elif . == "MEDIUM" then "🟡 MEDIUM" elif . == "LOW" then "🟢 LOW" else "⚪ \(.)" end;
  $marker,
  "## 🧭 AI primitives review: " + (if .status == "success" then "✅ Passed" else "❌ Failed" end),
  "",
  (if .reviewed == 0 then
     "No AI primitives " + (if .scope == "changed" then "changed in this pull request" else "found" end) + " under the configured paths."
   else
     "Reviewed **\(.reviewed)** " + (if .scope == "changed" then "changed " else "" end) + "primitive(s) with `\(.model)` against rubric v\(.rubric_version)"
     + (if .average_score != null then " · average **\(.average_score)/100**" else "" end)
     + (if .fail_below != null then " · required grade **\(.fail_below)** or better" else " · advisory" end)
     + (if .failed > 0 then " · **\(.failed) below the required grade**" else "" end) + ".",
     "",
     "| | Primitive | Type | Score | Grade | Static findings | Main improvement |",
     "|---|---|---|---|---|---|---|",
     (.primitives[] |
       ([.criteria[] | select(.score != null and (.raised_by // null) == null and ((.suggestion // "") != "" or .score < 5))] | sort_by(.score, -.weight) | first) as $worst
       | "| \(if .passed then "✅" else "❌" end) | `\(.path | cell)` | \(.type) | \(.score // "n/a") | \(.grade | icon) \(.grade) | \(.static_findings | length) | \(if $worst == null then (.error // "" | cell) else "\($worst.id) \($worst.name): \(($worst.suggestion // "") | if . == "" then ($worst.finding // "") else . end | cell)" end) |"),
     "",
     (.primitives[] |
       "<details><summary><b>\(.path | cell)</b> — \(.grade | icon) \(.grade) (\(.score // "n/a")/100)</summary>",
       "",
       (if .summary != "" then (.summary | cell), "" else empty end),
       (if .error != null then "> ⚠️ \(.error)", "" else empty end),
       "| Criterion | Score | Evidence | Finding | Suggestion |",
       "|---|---|---|---|---|",
       (.criteria[] | "| \(.id) \(.name) (×\(.weight)) | \(.score // "n/a")\(if .capped_by != null then " ⛔ capped: \(.capped_by | cell)" elif (.raised_by // null) != null then " ⬆️ checked: \(.raised_by | cell)" else "" end) | \(.evidence | code) | \(.finding | cell) | \(.suggestion | cell) |"),
       "",
       (if (.risks | length) > 0 then
         "**Risk indications (AI, evidence verified)**", "",
         "| Severity | Family | Evidence | Why | Mitigation |", "|---|---|---|---|---|",
         (.risks[] | "| \(.severity | sev) | \(.family) | \(.evidence | code) | \(.why | cell) | \(.mitigation | cell) |"), ""
        else empty end),
       (if (.static_findings | length) > 0 then
         "**Static scanner findings**", "",
         "| Severity | Rule | Line | Title |", "|---|---|---|---|",
         (.static_findings | sort_by({"CRITICAL": 0, "HIGH": 1, "MEDIUM": 2, "LOW": 3, "INFO": 4}[.severity] // 5, .line // 0)[] | "| \(.severity | sev) | \(.ruleId) | \(.line // "-") | \(.title | cell) |"), ""
        else empty end),
       (if .risks_dropped > 0 then "_\(.risks_dropped) AI risk indication(s) dropped because their quoted evidence is not in the file._", "" else empty end),
       (if .truncated then "_The file was truncated for review._", "" else empty end),
       "</details>", ""
     )
   end),
  "",
  "_Scores are AI-assisted. Caps come from checked facts and the static scanner; evidence not found in the file is discarded. Verify before acting._"
  + (if $run_url != "" then " [Workflow run](\($run_url))" else "" end)
' "$json" | jq -Rr 'gsub("@"; "@\u200b")' >"$md" # neutralise @mentions in model text

status="$(jq -r '.status' "$json")"
{
  echo "status=${status}"
  echo "report-json=${json}"
  echo "report-markdown=${md}"
  echo "reviewed=$(jq -r '.reviewed' "$json")"
  echo "failed=$(jq -r '.failed' "$json")"
  echo "average-score=$(jq -r '.average_score // ""' "$json")"
  echo "lowest-grade=$(jq -r '.lowest_grade // ""' "$json")"
} >>"$out"

if [[ "${INPUT_STEP_SUMMARY:-true}" == true && -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  cat "$md" >>"$GITHUB_STEP_SUMMARY"
fi
jq -r '"Status: \(.status); reviewed \(.reviewed), below grade: \(.failed), model errors: \(.errors); average \(.average_score // "n/a")."' "$json"

# --- Pull request comment: one comment, updated on every run --------------------------------
if [[ "${INPUT_COMMENT:-true}" == true && -n "${PR_NUMBER:-}" && -n "${REPOSITORY:-}" ]]; then
  body="${REPORT_DIR}/comment.md"
  if (($(wc -c <"$md") > 60000)); then
    { head -c 58000 "$md"; printf '\n\n</details>\n\n_Report truncated; see the job summary or the primitives-review artifact._\n'; } >"$body"
  else
    cp "$md" "$body"
  fi
  existing="$(gh api --paginate "repos/${REPOSITORY}/issues/${PR_NUMBER}/comments" \
    --jq ".[] | select(.user.type == \"Bot\" and (.body | startswith(\"${marker}\"))) | .id" 2>/dev/null | tail -n 1 || true)"
  if [[ -n "$existing" ]]; then
    gh api -X PATCH "repos/${REPOSITORY}/issues/comments/${existing}" -F "body=@${body}" >/dev/null &&
      echo "Updated the pull request comment." ||
      echo "::warning::Could not update the pull request comment (needs pull-requests: write; fork pull requests get a read-only token)."
  elif [[ "$(jq -r '.reviewed' "$json")" != 0 ]]; then
    gh api "repos/${REPOSITORY}/issues/${PR_NUMBER}/comments" -F "body=@${body}" >/dev/null &&
      echo "Posted the pull request comment." ||
      echo "::warning::Could not post the pull request comment (needs pull-requests: write; fork pull requests get a read-only token)."
  fi
fi

if [[ "$status" == failure ]]; then
  echo "::error::Primitives below grade ${threshold} or not reviewed: $(jq -r '[.primitives[] | select(.passed | not) | "\(.path) (\(if .grade == "?" then "not reviewed" else .grade end))"] | join(", ")' "$json")"
  exit 1
fi
