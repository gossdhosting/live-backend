#!/bin/bash

# Test script for deep link verification

echo "=========================================="
echo "Deep Link Configuration Test"
echo "=========================================="
echo ""

# Color codes
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

BASE_URL="https://panel.rexstream.net"

echo "Testing .well-known files..."
echo ""

# Test assetlinks.json
echo "1. Testing Android App Links (assetlinks.json):"
RESPONSE=$(curl -s -o /dev/null -w "%{http_code}|%{content_type}" "$BASE_URL/.well-known/assetlinks.json")
HTTP_CODE=$(echo $RESPONSE | cut -d'|' -f1)
CONTENT_TYPE=$(echo $RESPONSE | cut -d'|' -f2)

if [ "$HTTP_CODE" == "200" ]; then
    echo -e "   ${GREEN}✓${NC} HTTP Status: $HTTP_CODE (OK)"
else
    echo -e "   ${RED}✗${NC} HTTP Status: $HTTP_CODE (Expected 200)"
fi

if [[ "$CONTENT_TYPE" == *"application/json"* ]]; then
    echo -e "   ${GREEN}✓${NC} Content-Type: $CONTENT_TYPE"
else
    echo -e "   ${RED}✗${NC} Content-Type: $CONTENT_TYPE (Expected: application/json)"
fi

# Check for placeholder
CONTENT=$(curl -s "$BASE_URL/.well-known/assetlinks.json")
if [[ "$CONTENT" == *"SHA256_CERT_FINGERPRINT_HERE"* ]]; then
    echo -e "   ${YELLOW}⚠${NC}  Warning: Placeholder SHA256 fingerprint detected"
    echo "      Please update with actual certificate fingerprint"
else
    echo -e "   ${GREEN}✓${NC} SHA256 fingerprint configured"
fi

echo ""

# Test apple-app-site-association
echo "2. Testing iOS Universal Links (apple-app-site-association):"
RESPONSE=$(curl -s -o /dev/null -w "%{http_code}|%{content_type}" "$BASE_URL/.well-known/apple-app-site-association")
HTTP_CODE=$(echo $RESPONSE | cut -d'|' -f1)
CONTENT_TYPE=$(echo $RESPONSE | cut -d'|' -f2)

if [ "$HTTP_CODE" == "200" ]; then
    echo -e "   ${GREEN}✓${NC} HTTP Status: $HTTP_CODE (OK)"
else
    echo -e "   ${RED}✗${NC} HTTP Status: $HTTP_CODE (Expected 200)"
fi

if [[ "$CONTENT_TYPE" == *"application/json"* ]]; then
    echo -e "   ${GREEN}✓${NC} Content-Type: $CONTENT_TYPE"
else
    echo -e "   ${RED}✗${NC} Content-Type: $CONTENT_TYPE (Expected: application/json)"
fi

# Check for placeholder
CONTENT=$(curl -s "$BASE_URL/.well-known/apple-app-site-association")
if [[ "$CONTENT" == *"TEAM_ID"* ]]; then
    echo -e "   ${YELLOW}⚠${NC}  Warning: Placeholder TEAM_ID detected"
    echo "      Please update with actual Apple Developer Team ID"
else
    echo -e "   ${GREEN}✓${NC} Team ID configured"
fi

echo ""
echo "=========================================="
echo "Validation Links:"
echo "=========================================="
echo ""
echo "Android:"
echo "https://digitalassetlinks.googleapis.com/v1/statements:list?source.web.site=$BASE_URL&relation=delegate_permission/common.handle_all_urls"
echo ""
echo "iOS:"
echo "https://search.developer.apple.com/appsearch-validation-tool/"
echo ""
echo "=========================================="
echo "Next Steps:"
echo "=========================================="
echo ""

if [[ "$CONTENT" == *"SHA256_CERT_FINGERPRINT_HERE"* ]] || [[ "$CONTENT" == *"TEAM_ID"* ]]; then
    echo "1. Update placeholders in .well-known files:"
    echo "   - assetlinks.json: Add SHA256 certificate fingerprint"
    echo "   - apple-app-site-association: Add Apple Team ID"
    echo ""
    echo "2. Restart the backend server"
    echo ""
    echo "3. Run this script again to verify"
else
    echo "All configuration looks good!"
    echo ""
    echo "Test deep links:"
    echo "  Android: adb shell am start -a android.intent.action.VIEW -d \"$BASE_URL/app/oauth-callback?platform=youtube&success=true\""
    echo "  iOS: Open link in Safari or Notes app"
fi

echo ""
