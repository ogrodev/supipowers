#!/usr/bin/env bash
# Run playwright tests and produce a compact JSON summary.
# Requires playwright-cli installed globally (npm install -g @playwright/cli@latest).
# Usage: run-e2e-tests.sh <test_dir> <base_url> [test_filter]
# Output: Compact JSON summary on stdout
# Exit: 0 = all tests passed, 2 = test failures, 1 = script/playwright error
set -euo pipefail

TEST_DIR="$1"
BASE_URL="$2"
TEST_FILTER="${3:-}"
RESULTS_DIR="${TEST_DIR}/../results"

mkdir -p "$RESULTS_DIR"

# Resolve playwright-cli binary
if command -v playwright-cli &>/dev/null; then
  PW_BIN="$(command -v playwright-cli)"
elif [ -x "./node_modules/.bin/playwright-cli" ]; then
  PW_BIN="./node_modules/.bin/playwright-cli"
else
  cat <<EOF
{"total": 0, "passed": 0, "failed": 0, "skipped": 0, "duration": 0, "failures": [], "error": "playwright not found. Install with: npm install -g @playwright/cli@latest"}
EOF
  exit 1
fi

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

# Run playwright, capture JSON output and stderr separately
RAW_OUTPUT="$RESULTS_DIR/raw-results.json"
PW_STDERR="$RESULTS_DIR/playwright-stderr.log"
set +e
BASE_URL="$BASE_URL" "$PW_BIN" "${PW_ARGS[@]}" > "$RAW_OUTPUT" 2>"$PW_STDERR"
PW_EXIT=$?
set -e

# If no JSON output was produced, emit error summary and exit
if [ ! -s "$RAW_OUTPUT" ]; then
  cat <<EOF
{"total": 0, "passed": 0, "failed": 0, "skipped": 0, "duration": 0, "failures": [], "error": "playwright produced no output (exit code: $PW_EXIT). See $PW_STDERR for details."}
EOF
  exit 1
fi

# Parse the JSON output into compact summary using node.
# Writes summary to file, prints to stdout, exits non-zero if tests failed.
SUMMARY_OUTPUT="$RESULTS_DIR/summary.json"
NODE_STDERR="$RESULTS_DIR/node-parse-stderr.log"
set +e
RAW_OUTPUT="$RAW_OUTPUT" SUMMARY_OUTPUT="$SUMMARY_OUTPUT" node -e "
const fs = require('fs');
const raw = JSON.parse(fs.readFileSync(process.env.RAW_OUTPUT, 'utf-8'));

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
fs.writeFileSync(process.env.SUMMARY_OUTPUT, json);
console.log(json);
process.exit(failed > 0 ? 2 : 0);
" 2>"$NODE_STDERR"
NODE_EXIT=$?
set -e

# If parsing failed (not a test-failure exit), emit error and exit
if [ ! -s "$SUMMARY_OUTPUT" ]; then
  cat <<EOF
{"total": 0, "passed": 0, "failed": 0, "skipped": 0, "duration": 0, "failures": [], "error": "Failed to parse playwright output. See $NODE_STDERR for details."}
EOF
  exit 1
fi

# Propagate the node exit code (0 = all passed, 2 = test failures)
exit "$NODE_EXIT"
