#!/usr/bin/env bash
# Behavioral test suite for download-frp.sh with mocked curl/tar
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOWNLOAD_SCRIPT="$SCRIPT_DIR/download-frp.sh"
TEST_DIR="$(mktemp -d)"
MOCK_BIN="$TEST_DIR/mock-bin"
trap 'rm -rf "$TEST_DIR"' EXIT

mkdir -p "$MOCK_BIN"

PASSED=0
FAILED=0

pass() { echo "✓ PASS: $1"; PASSED=$((PASSED + 1)); }
fail() { echo "✗ FAIL: $1"; FAILED=$((FAILED + 1)); }

# Valid test archive content (minimal tar.gz with frpc)
create_valid_archive() {
  local dir="$1"
  local version="${2:-0.71.1}"
  local asset="${3:-linux_amd64}"
  local archive_dir="$dir/frp_${version}_${asset}"
  mkdir -p "$archive_dir"
  echo '#!/bin/sh' > "$archive_dir/frpc"
  echo 'echo "frpc mock"' >> "$archive_dir/frpc"
  chmod +x "$archive_dir/frpc"
  tar -czf "$dir/archive.tar.gz" -C "$dir" "frp_${version}_${asset}"
  rm -rf "$archive_dir"
  echo "$dir/archive.tar.gz"
}

# Get expected hash for linux_amd64
EXPECTED_HASH="1d9875210972a5d1a62b2dc4c48df45ab0af05d3ca1b5e494a014428259df803"

echo "=== Behavioral Tests for download-frp.sh ==="
echo "Test directory: $TEST_DIR"
echo ""

# ============================================================
# Test 1: Transient 503 then success - correct retry attempts
# ============================================================
echo "Test 1: Transient 503 then success invokes correct attempts"
TEST1_DIR="$TEST_DIR/test1"
TEST1_OUT="$TEST_DIR/test1-out"
TEST1_CACHE="$TEST_DIR/test1-cache"
TEST1_CURL_COUNT="$TEST_DIR/test1-curl-count"
mkdir -p "$TEST1_DIR" "$TEST1_OUT" "$TEST1_CACHE"
echo "0" > "$TEST1_CURL_COUNT"

# Create valid archive
VALID_ARCHIVE=$(create_valid_archive "$TEST1_DIR")
VALID_HASH=$(sha256sum "$VALID_ARCHIVE" | cut -d' ' -f1)

# Mock curl that fails twice then succeeds
cat > "$MOCK_BIN/curl" << 'MOCK_CURL'
#!/bin/bash
COUNT_FILE="$TEST1_CURL_COUNT"
count=$(<"$COUNT_FILE")
count=$((count + 1))
echo "$count" > "$COUNT_FILE"
if (( count < 3 )); then
  echo "curl: (22) The requested URL returned error: 503" >&2
  exit 22
fi
# Find output arg
for arg in "$@"; do
  if [[ "$prev" == "--output" || "$prev" == "-o" ]]; then
    cp "$VALID_ARCHIVE_PATH" "$arg"
    exit 0
  fi
  prev="$arg"
done
exit 1
MOCK_CURL
chmod +x "$MOCK_BIN/curl"
sed -i "s|\$TEST1_CURL_COUNT|$TEST1_CURL_COUNT|g" "$MOCK_BIN/curl"
sed -i "s|\$VALID_ARCHIVE_PATH|$VALID_ARCHIVE|g" "$MOCK_BIN/curl"

# Patch the script to use our expected hash for testing
TEST1_SCRIPT="$TEST1_DIR/download-frp-test.sh"
sed "s/$EXPECTED_HASH/$VALID_HASH/g" "$DOWNLOAD_SCRIPT" > "$TEST1_SCRIPT"
chmod +x "$TEST1_SCRIPT"

PATH="$MOCK_BIN:$PATH" RUNNER_TEMP="$TEST1_CACHE" FRP_DOWNLOAD_TEST_MODE=1 \
  bash "$TEST1_SCRIPT" "0.71.1" "linux_amd64" "$TEST1_OUT" "$TEST1_CACHE" > "$TEST1_DIR/output.log" 2>&1 || true

CURL_CALLS=$(<"$TEST1_CURL_COUNT")
if (( CURL_CALLS == 3 )) && [[ -f "$TEST1_OUT/frpc" ]]; then
  pass "Retried correctly and succeeded on attempt 3"
else
  fail "Expected 3 curl calls, got $CURL_CALLS, frpc exists: $(test -f "$TEST1_OUT/frpc" && echo yes || echo no)"
  cat "$TEST1_DIR/output.log" 2>/dev/null || true
fi

# ============================================================
# Test 2: Repeated failure exits finite
# ============================================================
echo "Test 2: Repeated failure exits after MAX_RETRIES"
TEST2_DIR="$TEST_DIR/test2"
TEST2_OUT="$TEST_DIR/test2-out"
TEST2_CACHE="$TEST_DIR/test2-cache"
TEST2_CURL_COUNT="$TEST_DIR/test2-curl-count"
mkdir -p "$TEST2_DIR" "$TEST2_OUT" "$TEST2_CACHE"
echo "0" > "$TEST2_CURL_COUNT"

# Mock curl that always fails
cat > "$MOCK_BIN/curl" << MOCK_CURL
#!/bin/bash
count=\$(<"$TEST2_CURL_COUNT")
count=\$((count + 1))
echo "\$count" > "$TEST2_CURL_COUNT"
echo "curl: (22) The requested URL returned error: 503" >&2
exit 22
MOCK_CURL
chmod +x "$MOCK_BIN/curl"

START_TIME=$(date +%s)
set +e
PATH="$MOCK_BIN:$PATH" RUNNER_TEMP="$TEST2_CACHE" FRP_DOWNLOAD_TEST_MODE=1 \
  bash "$DOWNLOAD_SCRIPT" "0.71.1" "linux_amd64" "$TEST2_OUT" "$TEST2_CACHE" > "$TEST2_DIR/output.log" 2>&1
EXIT_CODE=$?
set -e
END_TIME=$(date +%s)
DURATION=$((END_TIME - START_TIME))

CURL_CALLS=$(<"$TEST2_CURL_COUNT")
if (( EXIT_CODE != 0 )) && (( CURL_CALLS == 3 )) && (( DURATION < 30 )); then
  pass "Exited with failure after exactly 3 attempts in bounded time"
else
  fail "Expected exit!=0, 3 calls, <30s; got exit=$EXIT_CODE, calls=$CURL_CALLS, duration=${DURATION}s"
fi

# ============================================================
# Test 3: Checksum mismatch never extracts/executes
# ============================================================
echo "Test 3: Checksum mismatch never extracts or executes"
TEST3_DIR="$TEST_DIR/test3"
TEST3_OUT="$TEST_DIR/test3-out"
TEST3_CACHE="$TEST_DIR/test3-cache"
mkdir -p "$TEST3_DIR" "$TEST3_OUT" "$TEST3_CACHE"

# Create archive with wrong content (different hash)
BAD_ARCHIVE=$(create_valid_archive "$TEST3_DIR")
echo "extra junk" >> "$BAD_ARCHIVE"  # Modify to change hash

# Mock curl that returns the bad archive
cat > "$MOCK_BIN/curl" << MOCK_CURL
#!/bin/bash
for arg in "\$@"; do
  if [[ "\$prev" == "--output" || "\$prev" == "-o" ]]; then
    cp "$BAD_ARCHIVE" "\$arg"
    exit 0
  fi
  prev="\$arg"
done
exit 1
MOCK_CURL
chmod +x "$MOCK_BIN/curl"

set +e
PATH="$MOCK_BIN:$PATH" RUNNER_TEMP="$TEST3_CACHE" FRP_DOWNLOAD_TEST_MODE=1 \
  bash "$DOWNLOAD_SCRIPT" "0.71.1" "linux_amd64" "$TEST3_OUT" "$TEST3_CACHE" > "$TEST3_DIR/output.log" 2>&1
EXIT_CODE=$?
set -e

if (( EXIT_CODE != 0 )) && [[ ! -f "$TEST3_OUT/frpc" ]]; then
  if grep -q "Checksum mismatch\|checksum" "$TEST3_DIR/output.log"; then
    pass "Rejected bad checksum, did not extract frpc"
  else
    fail "Exited but no checksum error message"
  fi
else
  fail "Should have failed; exit=$EXIT_CODE, frpc exists: $(test -f "$TEST3_OUT/frpc" && echo yes || echo no)"
fi

# ============================================================
# Test 4: Corrupt restored cache triggers redownload/verify
# ============================================================
echo "Test 4: Corrupt cached archive triggers redownload and verification"
TEST4_DIR="$TEST_DIR/test4"
TEST4_OUT="$TEST_DIR/test4-out"
TEST4_CACHE="$TEST_DIR/test4-cache"
TEST4_DOWNLOAD_COUNT="$TEST_DIR/test4-download-count"
mkdir -p "$TEST4_DIR" "$TEST4_OUT" "$TEST4_CACHE"
echo "0" > "$TEST4_DOWNLOAD_COUNT"

# Pre-populate cache with corrupt file
echo "corrupt data" > "$TEST4_CACHE/frp_0.71.1_linux_amd64.tar.gz"

# Create valid archive for download
VALID_ARCHIVE4=$(create_valid_archive "$TEST4_DIR")
VALID_HASH4=$(sha256sum "$VALID_ARCHIVE4" | cut -d' ' -f1)

# Mock curl that tracks calls and returns valid archive
cat > "$MOCK_BIN/curl" << MOCK_CURL
#!/bin/bash
count=\$(<"$TEST4_DOWNLOAD_COUNT")
count=\$((count + 1))
echo "\$count" > "$TEST4_DOWNLOAD_COUNT"
for arg in "\$@"; do
  if [[ "\$prev" == "--output" || "\$prev" == "-o" ]]; then
    cp "$VALID_ARCHIVE4" "\$arg"
    exit 0
  fi
  prev="\$arg"
done
exit 1
MOCK_CURL
chmod +x "$MOCK_BIN/curl"

# Patch script with correct hash
TEST4_SCRIPT="$TEST4_DIR/download-frp-test.sh"
sed "s/$EXPECTED_HASH/$VALID_HASH4/g" "$DOWNLOAD_SCRIPT" > "$TEST4_SCRIPT"
chmod +x "$TEST4_SCRIPT"

PATH="$MOCK_BIN:$PATH" RUNNER_TEMP="$TEST4_CACHE" FRP_DOWNLOAD_TEST_MODE=1 \
  bash "$TEST4_SCRIPT" "0.71.1" "linux_amd64" "$TEST4_OUT" "$TEST4_CACHE" > "$TEST4_DIR/output.log" 2>&1
EXIT_CODE=$?

DOWNLOAD_COUNT=$(<"$TEST4_DOWNLOAD_COUNT")
if (( EXIT_CODE == 0 )) && (( DOWNLOAD_COUNT >= 1 )) && [[ -f "$TEST4_OUT/frpc" ]]; then
  if grep -q "corrupted\|Checksum mismatch\|removing" "$TEST4_DIR/output.log"; then
    pass "Detected corrupt cache, redownloaded, verified, extracted"
  else
    pass "Redownloaded and succeeded (cache invalid)"
  fi
else
  fail "Expected success with redownload; exit=$EXIT_CODE, downloads=$DOWNLOAD_COUNT"
  cat "$TEST4_DIR/output.log" 2>/dev/null || true
fi

# ============================================================
# Test 5: Clean cached archive avoids network
# ============================================================
echo "Test 5: Valid cached archive avoids network download"
TEST5_DIR="$TEST_DIR/test5"
TEST5_OUT="$TEST_DIR/test5-out"
TEST5_CACHE="$TEST_DIR/test5-cache"
TEST5_CURL_COUNT="$TEST_DIR/test5-curl-count"
mkdir -p "$TEST5_DIR" "$TEST5_OUT" "$TEST5_CACHE"
echo "0" > "$TEST5_CURL_COUNT"

# Create valid archive and pre-populate cache
VALID_ARCHIVE5=$(create_valid_archive "$TEST5_DIR")
VALID_HASH5=$(sha256sum "$VALID_ARCHIVE5" | cut -d' ' -f1)
cp "$VALID_ARCHIVE5" "$TEST5_CACHE/frp_0.71.1_linux_amd64.tar.gz"

# Mock curl that counts calls (should not be called)
cat > "$MOCK_BIN/curl" << MOCK_CURL
#!/bin/bash
count=\$(<"$TEST5_CURL_COUNT")
count=\$((count + 1))
echo "\$count" > "$TEST5_CURL_COUNT"
echo "Network called unexpectedly" >&2
exit 1
MOCK_CURL
chmod +x "$MOCK_BIN/curl"

# Patch script with correct hash
TEST5_SCRIPT="$TEST5_DIR/download-frp-test.sh"
sed "s/$EXPECTED_HASH/$VALID_HASH5/g" "$DOWNLOAD_SCRIPT" > "$TEST5_SCRIPT"
chmod +x "$TEST5_SCRIPT"

PATH="$MOCK_BIN:$PATH" RUNNER_TEMP="$TEST5_CACHE" FRP_DOWNLOAD_TEST_MODE=1 \
  bash "$TEST5_SCRIPT" "0.71.1" "linux_amd64" "$TEST5_OUT" "$TEST5_CACHE" > "$TEST5_DIR/output.log" 2>&1
EXIT_CODE=$?

CURL_CALLS=$(<"$TEST5_CURL_COUNT")
if (( EXIT_CODE == 0 )) && (( CURL_CALLS == 0 )) && [[ -f "$TEST5_OUT/frpc" ]]; then
  pass "Used cached archive, no network call"
else
  fail "Expected no curl calls; got $CURL_CALLS, exit=$EXIT_CODE"
  cat "$TEST5_DIR/output.log" 2>/dev/null || true
fi

echo ""
echo "=== Behavioral Test Results ==="
echo "Passed: $PASSED"
echo "Failed: $FAILED"

if (( FAILED > 0 )); then
  exit 1
fi
exit 0
