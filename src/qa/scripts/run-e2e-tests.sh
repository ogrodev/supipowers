#!/usr/bin/env bash
# Run playwright tests and produce a compact JSON summary.
# Usage: run-e2e-tests.sh <test_dir> <base_url> [test_filter]
# Output: Compact JSON summary on stdout
set -euo pipefail

TEST_DIR="$1"
BASE_URL="$2"
TEST_FILTER="${3:-}"
RESULTS_DIR="${TEST_DIR}/../results"
SCREENSHOTS_DIR="${TEST_DIR}/../screenshots"

mkdir -p "$RESULTS_DIR" "$SCREENSHOTS_DIR"

# Build playwright command
PW_ARGS=(
  test
  "$TEST_DIR"
  --reporter=json
  --output="$RESULTS_DIR"
)

if [ -n "$TEST_FILTER" ]; then
  PW_ARGS+=(--grep "$TEST_FILTER")
fi

# Run playwright, capture JSON output
RAW_OUTPUT="$RESULTS_DIR/raw-results.json"
set +e
BASE_URL="$BASE_URL" npx playwright "${PW_ARGS[@]}" > "$RAW_OUTPUT" 2>/dev/null
PW_EXIT=$?
set -e

# If no JSON output was produced, create a minimal error report
if [ ! -s "$RAW_OUTPUT" ]; then
  cat <<EOF
{"total": 0, "passed": 0, "failed": 0, "skipped": 0, "duration": 0, "failures": [], "error": "Playwright produced no output (exit code: $PW_EXIT)"}
EOF
  exit 0
fi

# Parse the JSON output into compact summary using node (more reliable than jq)
node -e "
const fs = require('fs');
const raw = JSON.parse(fs.readFileSync('$RAW_OUTPUT', 'utf-8'));

const suites = raw.suites || [];
const results = [];

function collectTests(suite, parentTitle) {
  const title = parentTitle ? parentTitle + ' > ' + suite.title : suite.title;
  for (const spec of (suite.specs || [])) {
    for (const test of (spec.tests || [])) {
      for (const result of (test.results || [])) {
        results.push({
          test: title + ' > ' + spec.title,
          file: spec.file + (spec.line ? ':' + spec.line : ''),
          status: result.status,
          duration: result.duration || 0,
          error: result.error?.message || null,
        });
      }
    }
  }
  for (const child of (suite.suites || [])) {
    collectTests(child, title);
  }
}

for (const suite of suites) {
  collectTests(suite, '');
}

const passed = results.filter(r => r.status === 'passed').length;
const failed = results.filter(r => r.status === 'failed' || r.status === 'timedOut').length;
const skipped = results.filter(r => r.status === 'skipped').length;
const totalDuration = results.reduce((sum, r) => sum + r.duration, 0);

const failures = results
  .filter(r => r.status === 'failed' || r.status === 'timedOut')
  .map(r => ({
    test: r.test,
    file: r.file,
    error: r.error || 'Unknown error',
  }));

const summary = {
  total: results.length,
  passed,
  failed,
  skipped,
  duration: totalDuration,
  failures,
};

console.log(JSON.stringify(summary));
" 2>/dev/null || cat <<EOF
{"total": 0, "passed": 0, "failed": 0, "skipped": 0, "duration": 0, "failures": [], "error": "Failed to parse playwright output"}
EOF
