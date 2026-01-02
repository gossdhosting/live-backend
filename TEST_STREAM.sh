#!/bin/bash

# Test script to verify FFmpeg can process a YouTube stream

set -e

echo "=========================================="
echo "FFmpeg YouTube Stream Test"
echo "=========================================="
echo ""

# Check FFmpeg
if ! command -v ffmpeg &> /dev/null; then
  echo "Error: FFmpeg not found"
  exit 1
fi

# Get YouTube URL from user
echo "Enter YouTube Live URL to test:"
read -p "URL: " YOUTUBE_URL

if [ -z "$YOUTUBE_URL" ]; then
  echo "Error: No URL provided"
  exit 1
fi

# Create test output directory
TEST_DIR="./test_output"
mkdir -p $TEST_DIR

echo ""
echo "Testing FFmpeg with YouTube stream..."
echo "Output: $TEST_DIR/index.m3u8"
echo ""
echo "Press Ctrl+C to stop"
echo ""

# Run FFmpeg
ffmpeg -re \
  -i "$YOUTUBE_URL" \
  -c copy \
  -f hls \
  -hls_time 4 \
  -hls_list_size 6 \
  -hls_flags delete_segments \
  -hls_segment_filename "$TEST_DIR/segment_%03d.ts" \
  "$TEST_DIR/index.m3u8"

echo ""
echo "Test completed!"
echo "Check output files in: $TEST_DIR/"
