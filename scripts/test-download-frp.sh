#!/usr/bin/env bash
# Test suite for download-frp.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOWNLOAD_SCRIPT="$SCRIPT_DIR/download-frp.sh"
TEST_DIR="$(mktemp -d)"
trap 'rm -rf "$TEST_DIR"' EXIT

PASSED=0
FAILED=0

pass() { echo "✓ $1"; PASSED=$((PASSED + 1)); }
fail() { echo "✗ $1"; FAILED=$((FAILED + 1)); }

echo "=== download-frp.sh test suite ==="
echo "Test directory: $TEST_DIR"
echo ""

# Test 1: Script exists and is executable
echo "Test 1: Script exists and is executable"
if [[ -x "$DOWNLOAD_SCRIPT" ]]; then
  pass "Script is executable"
else
  fail "Script not found or not executable"
fi

# Test 2: Usage error with no arguments
echo "Test 2: Usage error with no arguments"
OUTPUT=$("$DOWNLOAD_SCRIPT" 2>&1 || true)
if echo "$OUTPUT" | grep -q "Usage:"; then
  pass "Shows usage on empty args"
else
  fail "No usage message on empty args: $OUTPUT"
fi

# Test 3: Error on unsupported version/arch
echo "Test 3: Error on unsupported version/arch"
OUTPUT_DIR="$TEST_DIR/test3"
mkdir -p "$OUTPUT_DIR"
OUTPUT=$("$DOWNLOAD_SCRIPT" "9.99.99" "invalid_arch" "$OUTPUT_DIR" 2>&1 || true)
if echo "$OUTPUT" | grep -q "No pinned checksum"; then
  pass "Rejects unknown version/arch"
else
  fail "Did not reject unknown version/arch: $OUTPUT"
fi

# Test 4: Checksum verification - corrupted file rejected (static check)
echo "Test 4: Checksum verification - corrupted file rejected"
CACHE_DIR="$TEST_DIR/cache4"
OUTPUT_DIR="$TEST_DIR/test4"
mkdir -p "$CACHE_DIR" "$OUTPUT_DIR"
# Create a corrupt cached file
echo "corrupt data" > "$CACHE_DIR/frp_0.71.1_linux_amd64.tar.gz"
# Use timeout to avoid waiting for network; we just need to see it detect corruption
OUTPUT=$(timeout 2 bash -c "FRP_DOWNLOAD_TEST_MODE=1 '$DOWNLOAD_SCRIPT' '0.71.1' 'linux_amd64' '$OUTPUT_DIR' '$CACHE_DIR'" 2>&1 || true)
if echo "$OUTPUT" | grep -q "Checksum mismatch\|corrupted"; then
  pass "Detects corrupted cache and handles appropriately"
else
  fail "Did not detect corrupted cache: $OUTPUT"
fi

# Test 5: Supported architectures are documented
echo "Test 5: Supported architectures listed"
SUPPORTED=$(grep -c "0.71.1_" "$DOWNLOAD_SCRIPT" | head -1)
if (( SUPPORTED >= 4 )); then
  pass "Has checksums for 4+ platform variants"
else
  fail "Missing platform checksums"
fi

# Test 6: Retry logic present
echo "Test 6: Retry logic present"
if grep -q "MAX_RETRIES" "$DOWNLOAD_SCRIPT" && grep -q "attempt.*MAX_RETRIES" "$DOWNLOAD_SCRIPT"; then
  pass "Retry logic implemented"
else
  fail "Retry logic missing"
fi

# Test 7: Timeout settings present
echo "Test 7: Timeout settings present"
if grep -q "CONNECT_TIMEOUT" "$DOWNLOAD_SCRIPT" && grep -q "MAX_TIME" "$DOWNLOAD_SCRIPT"; then
  pass "Timeout settings present"
else
  fail "Timeout settings missing"
fi

# Test 8: Error diagnostics include stage and host
echo "Test 8: Error diagnostics include stage and host"
if grep -q "hostname" "$DOWNLOAD_SCRIPT" && grep -q "Stage:" "$DOWNLOAD_SCRIPT"; then
  pass "Error diagnostics include host and stage"
else
  fail "Error diagnostics missing host/stage info"
fi

# Test 9: Cache directory creation
echo "Test 9: Cache directory creation"
if grep -q "mkdir -p.*CACHE_DIR" "$DOWNLOAD_SCRIPT"; then
  pass "Creates cache directory"
else
  fail "Does not create cache directory"
fi

# Test 10: Cleanup on failure
echo "Test 10: Cleanup on failure"
if grep -q "trap.*rm" "$DOWNLOAD_SCRIPT"; then
  pass "Has cleanup trap"
else
  fail "Missing cleanup trap"
fi

echo ""
echo "=== Results ==="
echo "Passed: $PASSED"
echo "Failed: $FAILED"

if (( FAILED > 0 )); then
  exit 1
fi
exit 0
