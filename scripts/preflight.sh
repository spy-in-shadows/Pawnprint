#!/usr/bin/env bash
# preflight.sh - checks a change set before it is committed, pushed or opened as a PR.
# Usage: bash scripts/preflight.sh <A|B|C> [--staged|--branch] [--allow <glob>]...
#   (no mode)  checks the working tree (modified + untracked files)
#   --staged   checks what is staged for the next commit
#   --branch   checks every commit on this branch compared with origin/main
#   --allow    permits an extra path pattern (used for cross-owner edits named in a prompt)
set -u
ROLE="${1:-}"; shift || true
MODE="working"; ALLOW=()
while [ $# -gt 0 ]; do
  case "$1" in
    --staged) MODE="staged" ;;
    --branch) MODE="branch" ;;
    --allow) shift; ALLOW+=("${1:-}") ;;
    *) echo "unknown option: $1"; exit 2 ;;
  esac
  shift
done
case "$ROLE" in A|B|C) ;; *) echo "usage: preflight.sh <A|B|C> [--staged|--branch] [--allow glob]..."; exit 2 ;; esac

FAIL=0
TRACE_FILE_RE="(^|/)cl""aude\.md$|(^|/)\.cl""aude/|(^|/)agents\.md$|(^|/)gem""ini\.md$|\.cursor|copi""lot-instructions"
# wording that must not appear anywhere in the repository (split so this file does not match itself)
TRACE_RE="cl""aude|anthr""opic|chat""gpt|open""ai|copi""lot|gem""ini|as an a""i|language mod""el|a""i-generated|generated (by|with)|co-authored-""by"
fail() { echo "FAIL: $*"; FAIL=1; }
ok()   { echo "ok:   $*"; }
warn() { echo "warn: $*"; }

COMMON=("docs/DEV_LOG.md" "REPORT.md")
OWN_A=("docker-compose.yml" ".env.example" ".github/workflows/*" "src/config/*" "src/utils/logger.js" "prisma/*"
  "src/chess/pgnParser.js" "src/ingest/*" "src/repositories/moveBulk.repo.js" "src/services/import.service.js"
  "scripts/benchmarkInsert.js" "scripts/importPuzzles.js" "scripts/README.md" "docs/benchmarks/insert.md"
  "tests/config.test.js" "tests/logger.test.js" "tests/schema.*" "tests/seed.test.js" "tests/db.test.js"
  "tests/parser.test.js" "tests/moveBulk.test.js" "tests/import.service.test.js" "tests/importPuzzles.test.js" "tests/fixtures/*")
OWN_B=("package.json" "package-lock.json" "vitest.config.js" ".gitignore" "DESIGN.md" "ENGINEERING.md" "README.md" "docs/CONTRACTS.md"
  ".github/pull_request_template.md" ".github/CODEOWNERS" "scripts/preflight.sh"
  "src/app.js" "src/server.js" "src/worker.js" "src/utils/errors.js" "src/middleware/errorHandler.js" "src/routes/v1/index.js"
  "src/chess/evalMath.js" "src/chess/phase.js" "src/chess/fen.js" "src/chess/stockfishClient.js" "src/chess/motifs.js" "src/workers/*"
  "scripts/benchmarkThroughput.js" "scripts/dataQuality.js" "docs/benchmarks/throughput.md"
  "tests/app.test.js" "tests/evalMath.test.js" "tests/phase.test.js" "tests/fen.test.js" "tests/jobQueue.test.js" "tests/poisonJobs.test.js"
  "tests/claim.concurrency.test.js" "tests/stockfish*.test.js" "tests/gameAnalyzer.test.js" "tests/jobRunner.test.js"
  "tests/dataQuality.test.js" "tests/motifs.test.js" "tests/crashRecovery.test.js" "tests/integration.test.js")
OWN_C=("src/routes/*" "src/controllers/*" "src/services/auth.service.js" "src/services/analytics.service.js" "src/services/training.service.js"
  "src/services/summary.service.js" "src/services/health.service.js" "src/services/account.service.js" "src/services/upload.service.js"
  "src/services/games.service.js" "src/services/drill.js" "src/repositories/analytics.repo.js" "src/repositories/game.repo.js"
  "src/repositories/training.repo.js" "src/repositories/user.repo.js" "src/middleware/authenticate.js" "src/middleware/requestLogger.js"
  "src/middleware/rateLimit.js" "client/*" "docs/explain/*" "docs/benchmarks/queries.md" "docs/DEMO.md" "README.md"
  "scripts/benchmarkQueries.js" "scripts/explainAnalytics.js"
  "tests/auth.test.js" "tests/games.test.js" "tests/accounts.test.js" "tests/uploads.test.js" "tests/analytics.test.js" "tests/summary.test.js"
  "tests/training.test.js" "tests/drill.test.js" "tests/health.test.js" "tests/rateLimit.test.js" "tests/static.test.js")

case "$ROLE" in A) OWN=("${OWN_A[@]}");; B) OWN=("${OWN_B[@]}");; C) OWN=("${OWN_C[@]}");; esac

matches() { # matches <file> <pattern>...
  local f="$1"; shift
  local p
  for p in "$@"; do
    [ -z "$p" ] && continue
    # shellcheck disable=SC2254
    case "$f" in $p) return 0 ;; esac
  done
  return 1
}

case "$MODE" in
  staged) FILES=$(git diff --cached --name-only --diff-filter=ACMRD) ;;
  branch) FILES=$(git diff --name-only --diff-filter=ACMRD origin/main...HEAD 2>/dev/null) ;;
  *)      FILES=$(git status --porcelain -uall | sed -E 's/^...//; s/^.* -> //') ;;
esac

if [ -z "$FILES" ]; then
  echo "No changed files to check (mode: $MODE)."
else
  echo "Checking $(echo "$FILES" | wc -l | tr -d ' ') changed file(s), role $ROLE, mode $MODE"
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    if matches "$f" "${OWN[@]}" "${COMMON[@]}" "${ALLOW[@]+"${ALLOW[@]}"}"; then :; else
      fail "$f is outside Person $ROLE's area (add --allow only if the prompt names this cross-owner edit)"
    fi
    if echo "$f" | grep -qiE "$TRACE_FILE_RE"; then fail "$f is a tool-specific file and must not be committed (use ENGINEERING.md)"; fi
    case "$f" in
      .env|*/.env|node_modules/*|*/node_modules/*|client/dist/*|.DS_Store|*/.DS_Store|*.log)
        fail "$f must never be committed" ;;
    esac
    if [ -f "$f" ]; then
      size=$(wc -c < "$f" | tr -d ' ')
      [ "$size" -gt 1048576 ] && fail "$f is larger than 1 MB ($size bytes)"
      if grep -qE '^(<<<<<<<|>>>>>>>) ' "$f" 2>/dev/null; then fail "$f contains merge conflict markers"; fi
      case "$f" in
        tests/*|*.test.js|*.test.jsx)
          if grep -qE '\b(it|test|describe)\.only\(|\bfdescribe\(|\bfit\(' "$f"; then fail "$f contains .only / focused tests"; fi ;;
      esac
      if [ "$f" != "scripts/preflight.sh" ] && grep -qiE "$TRACE_RE" "$f" 2>/dev/null; then
        fail "$f mentions an AI tool or assistant ($(grep -iEo "$TRACE_RE" "$f" | head -1)); rewrite it in neutral engineering language"
      fi
      case "$f" in
        .env.example|*.md) : ;;
        *) if grep -qE 'BEGIN (RSA|OPENSSH|EC) PRIVATE KEY|ghp_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,}' "$f" 2>/dev/null; then fail "$f looks like it contains a secret"; fi ;;
      esac
    fi
  done <<< "$FILES"
fi

if git ls-files --error-unmatch .env >/dev/null 2>&1; then fail ".env is tracked by git"; fi

# commit subjects (branch mode): conventional commits
if [ "$MODE" = "branch" ]; then
  RE='^(feat|fix|chore|docs|test|perf|refactor|ci|build)(\([a-z0-9_.-]+\))?: .+'
  while IFS= read -r s; do
    [ -z "$s" ] && continue
    echo "$s" | grep -qE "$RE" || fail "commit subject not in conventional format: $s"
  done < <(git log --format=%s origin/main..HEAD 2>/dev/null)
  if git log --format=%B origin/main..HEAD 2>/dev/null | grep -qiE "$TRACE_RE"; then fail "a commit message contains an AI tool name or a trailer line (Co-authored-by, Generated with); rewrite those commits"; fi
  if git merge-base --is-ancestor origin/main HEAD 2>/dev/null; then ok "branch contains the latest origin/main"; else fail "branch is behind origin/main: run git fetch origin && git rebase origin/main"; fi
fi

# debug leftovers in added lines (warning only)
case "$MODE" in staged) DIFF=$(git diff --cached -U0 -- src client/src 2>/dev/null);; branch) DIFF=$(git diff -U0 origin/main...HEAD -- src client/src 2>/dev/null);; *) DIFF=$(git diff -U0 -- src client/src 2>/dev/null);; esac
if echo "$DIFF" | grep -E '^\+' | grep -vE '^\+\+\+' | grep -qE 'debugger|TODO|FIXME|XXX'; then warn "added lines contain debugger/TODO/FIXME (remove or justify)"; fi

if [ "$FAIL" -eq 0 ]; then echo "PREFLIGHT PASSED"; else echo "PREFLIGHT FAILED"; fi
exit "$FAIL"
