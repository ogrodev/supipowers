#!/usr/bin/env bash
# Run playwright tests via playwright-cli and produce a compact JSON summary.
# Usage: run-e2e-tests.sh <test_dir> <base_url> [test_filter]
# Output: Compact JSON summary on stdout
# Exit: non-zero when any test fails or playwright-cli errors
set -euo pipefail

TEST_DIR="$1"
BASE_URL="$2"
TEST_FILTER="${3:-}"
RESULTS_DIR="${TEST_DIR}/../results"

mkdir -p "$RESULTS_DIR"

# Build playwright-cli command
PW_ARGS=(
  test
  "$TEST_DIR"
  --reporter=json
  --output="$RESULTS_DIR"
)

if [ -n "$TEST_FILTER" ]; then
  PW_ARGS+=(--grep "$TEST_FILTER")
fi

# Run playwright-cli, capture JSON output
RAW_OUTPUT="$RESULTS_DIR/raw-results.json"
set +e
BASE_URL="$BASE_URL" playwright-cli "${PW_ARGS[@]}" > "$RAW_OUTPUT" 2>/dev/null
PW_EXIT=$?
set -e

# If no JSON output was produced, emit error summary and exit
if [ ! -s "$RAW_OUTPUT" ]; then
  cat <<EOF
{"total": 0, "passed": 0, "failed": 0, "skipped": 0, "duration": 0, "failures": [], "error": "playwright-cli produced no output (exit code: $PW_EXIT)"}
EOF
  exit 1
fi

# Parse the JSON output into compact summary using node.
# Writes summary to file and prints it to stdout. Prints nothing on failure.
SUMMARY_OUTPUT="$RESULTS_DIR/summary.json"
set +e
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

const json = JSON.stringify(summary);
fs.writeFileSync('$SUMMARY_OUTPUT', json);
console.log(json);
" 2>/dev/null
NODE_EXIT=$?
set -e

# If parsing failed, emit error and exit
if [ "$NODE_EXIT" -ne 0 ] || [ ! -s "$SUMMARY_OUTPUT" ]; then
  echo '{"total": 0, "passed": 0, "failed": 0, "skipped": 0, "duration": 0, "failures": [], "error": "Failed to parse playwright-cli output"}'
  exit 1
fi

# Exit non-zero if any tests failed
node -e "const s=JSON.parse(require('fs').readFileSync('$SUMMARY_OUTPUT','utf-8'));process.exit(s.failed>0?1:0)" 2>/dev/null
