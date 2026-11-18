#!/usr/bin/env bash
# ==============================================================================
# scripts/smoke_test.sh
#
# Automated post-deployment smoke test suite for Stellar Freelance Platform.
# Validates backend API health, indexer status, CORS policies, security headers,
# and public taxonomy endpoints against a deployed staging or production target.
#
# Usage:
#   ./scripts/smoke_test.sh [--url <api_url>] [--cors <origin>]
#
# Options:
#   --url   Base URL of backend API (default: http://localhost:3000)
#   --cors  Frontend origin to test CORS headers against (default: http://localhost:5173)
#   -h, --help Show this help message
# ==============================================================================

set -euo pipefail

# ANSI color codes
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

API_URL="${BACKEND_URL:-http://localhost:3000}"
CORS_ORIGIN="${CORS_ORIGIN:-http://localhost:5173}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --url)
      API_URL="${2%/}"
      shift 2
      ;;
    --cors)
      CORS_ORIGIN="$2"
      shift 2
      ;;
    -h|--help)
      echo "Usage: ./scripts/smoke_test.sh [--url <api_url>] [--cors <origin>]"
      echo ""
      echo "Options:"
      echo "  --url   Backend API base URL (default: http://localhost:3000)"
      echo "  --cors  Origin for CORS preflight tests (default: http://localhost:5173)"
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

# Strip trailing slash if present
API_URL="${API_URL%/}"

echo -e "${BLUE}=================================================================${NC}"
echo -e "${BLUE}  Stellar Freelance Platform — Post-Deployment Smoke Tests       ${NC}"
echo -e "${BLUE}=================================================================${NC}"
echo "Target API:     $API_URL"
echo "Testing Origin: $CORS_ORIGIN"
echo ""

PASSED=0
FAILED=0

assert_test() {
  local name="$1"
  local status="$2"
  local details="$3"

  if [ "$status" -eq 0 ]; then
    echo -e "  [${GREEN}PASS${NC}] $name"
    PASSED=$((PASSED + 1))
  else
    echo -e "  [${RED}FAIL${NC}] $name: $details"
    FAILED=$((FAILED + 1))
  fi
}

# ------------------------------------------------------------------------------
# Test 1: GET /health (Database & Indexer connectivity)
# ------------------------------------------------------------------------------
echo -e "${YELLOW}1. Checking Service Health & Infrastructure...${NC}"
HEALTH_BODY=$(curl -sS -m 10 "$API_URL/health" 2>/dev/null || true)
HEALTH_HTTP=$(curl -sS -o /dev/null -w "%{http_code}" -m 10 "$API_URL/health" 2>/dev/null || echo "000")

if [ "$HEALTH_HTTP" = "200" ] && echo "$HEALTH_BODY" | grep -q '"status":"ok"'; then
  assert_test "GET /health responds with 200 and status ok" 0 ""
else
  assert_test "GET /health responds with 200 and status ok" 1 "HTTP $HEALTH_HTTP, response: $HEALTH_BODY"
fi

if echo "$HEALTH_BODY" | grep -q '"db":true'; then
  assert_test "PostgreSQL database connection is healthy" 0 ""
else
  assert_test "PostgreSQL database connection is healthy" 1 "Database check returned unhealthy"
fi

if echo "$HEALTH_BODY" | grep -q '"indexer":true'; then
  assert_test "Soroban event indexer is running and active" 0 ""
else
  assert_test "Soroban event indexer is running and active" 1 "Indexer reported false or degraded"
fi

# ------------------------------------------------------------------------------
# Test 2: Public Taxonomy (GET /api/jobs/tags)
# ------------------------------------------------------------------------------
echo -e "\n${YELLOW}2. Checking Public Taxonomy & Market APIs...${NC}"
TAGS_HTTP=$(curl -sS -o /dev/null -w "%{http_code}" -m 10 "$API_URL/api/jobs/tags" 2>/dev/null || echo "000")
TAGS_BODY=$(curl -sS -m 10 "$API_URL/api/jobs/tags" 2>/dev/null || true)

if [ "$TAGS_HTTP" = "200" ] && echo "$TAGS_BODY" | grep -q "web-development"; then
  assert_test "GET /api/jobs/tags returns curated skill taxonomy" 0 ""
else
  assert_test "GET /api/jobs/tags returns curated skill taxonomy" 1 "HTTP $TAGS_HTTP"
fi

# ------------------------------------------------------------------------------
# Test 3: OpenAPI Documentation (GET /api/docs/openapi.json)
# ------------------------------------------------------------------------------
echo -e "\n${YELLOW}3. Checking OpenAPI Documentation & Spec...${NC}"
DOCS_HTTP=$(curl -sS -o /dev/null -w "%{http_code}" -m 10 "$API_URL/api/docs/openapi.json" 2>/dev/null || echo "000")
DOCS_BODY=$(curl -sS -m 10 "$API_URL/api/docs/openapi.json" 2>/dev/null || true)

if [ "$DOCS_HTTP" = "200" ] && echo "$DOCS_BODY" | grep -q '"openapi":"3.0.3"'; then
  assert_test "GET /api/docs/openapi.json serves valid OpenAPI 3.0 specification" 0 ""
else
  assert_test "GET /api/docs/openapi.json serves valid OpenAPI 3.0 specification" 1 "HTTP $DOCS_HTTP"
fi

# ------------------------------------------------------------------------------
# Test 4: CORS Configuration & Preflight Headers
# ------------------------------------------------------------------------------
echo -e "\n${YELLOW}4. Validating CORS Configuration & Security Headers...${NC}"
CORS_HEADERS=$(curl -sS -I -X OPTIONS "$API_URL/api/jobs" \
  -H "Origin: $CORS_ORIGIN" \
  -H "Access-Control-Request-Method: GET" \
  -m 10 2>/dev/null || true)

if echo "$CORS_HEADERS" | grep -qi "Access-Control-Allow-Origin"; then
  assert_test "CORS preflight allows configured frontend origin ($CORS_ORIGIN)" 0 ""
else
  assert_test "CORS preflight allows configured frontend origin" 1 "Missing Access-Control-Allow-Origin header"
fi

# ------------------------------------------------------------------------------
# Test 5: Helmet Security Headers
# ------------------------------------------------------------------------------
SECURITY_HEADERS=$(curl -sS -I "$API_URL/health" -m 10 2>/dev/null || true)

if echo "$SECURITY_HEADERS" | grep -qi "X-Content-Type-Options: nosniff"; then
  assert_test "X-Content-Type-Options: nosniff header is enforced" 0 ""
else
  assert_test "X-Content-Type-Options: nosniff header is enforced" 1 "Header missing"
fi

# ------------------------------------------------------------------------------
# Test 6: Rate Limiter Response Headers
# ------------------------------------------------------------------------------
if echo "$SECURITY_HEADERS" | grep -qi "RateLimit-"; then
  assert_test "Rate limit headers are present on API responses" 0 ""
else
  assert_test "Rate limit headers are present on API responses" 1 "Rate limit headers not found"
fi

# ------------------------------------------------------------------------------
# Summary
# ------------------------------------------------------------------------------
echo ""
echo -e "${BLUE}=================================================================${NC}"
TOTAL=$((PASSED + FAILED))
echo "Smoke Test Summary: $PASSED / $TOTAL checks passed"
echo -e "${BLUE}=================================================================${NC}"

if [ "$FAILED" -eq 0 ]; then
  echo -e "${GREEN}All smoke tests passed successfully! Deployment is operational.${NC}"
  exit 0
else
  echo -e "${RED}$FAILED smoke test(s) failed. Investigate backend logs before traffic shift.${NC}"
  exit 1
fi
