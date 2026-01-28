# Media Caching System for AWS S3

## Overview

The media caching system reduces AWS S3 costs by caching video files locally on the server. When a video is first streamed, it's downloaded from S3 and cached. Subsequent streams use the cached file, eliminating repeated S3 data transfer costs.

## Cost Savings

### Without Caching
- **Scenario**: 10 concurrent streams running 24/7, each streaming a 2GB video
- **Monthly Data Transfer**: 10 streams × 2GB × 24 hours × 30 days = 14,400 GB
- **AWS Cost**: 14,400 GB × $0.09/GB = **$1,296/month** 💸

### With Caching
- **First Stream**: Downloads 2GB from S3 (one-time cost)
- **Subsequent Streams**: Uses cached file (zero S3 cost)
- **Monthly Cost**: ~$0 for repeated streams ✅

## How It Works

1. **First Use**: When a channel starts streaming a video:
   - Checks if file is in cache
   - If not, downloads from S3 to `/var/www/backend/cache/media/`
   - Saves file with sanitized S3 key as filename

2. **Subsequent Uses**:
   - Immediately uses cached file
   - No S3 API calls or data transfer
   - Updates "last accessed" timestamp

3. **Cache Management**:
   - **LRU Eviction**: When cache is full, removes least recently used files
   - **Configurable Size**: Default 50GB, adjustable via environment variable
   - **Automatic Cleanup**: Frees 10% extra space when evicting

## Configuration

### Environment Variables

Add to `.env` or `ecosystem.config.cjs`:

```env
# Media cache directory (default: ./cache/media)
MEDIA_CACHE_DIR=/var/www/backend/cache/media

# Maximum cache size in GB (default: 50)
MAX_CACHE_SIZE_GB=50
```

### Recommended Cache Sizes

- **Small Server** (1-5 channels): 20-30 GB
- **Medium Server** (5-20 channels): 50-100 GB
- **Large Server** (20+ channels): 100-200 GB

## Cache Management API

### Get Cache Statistics
```bash
GET /api/cache/stats
Authorization: Bearer <admin_token>

Response:
{
  "totalFiles": 15,
  "currentSize": 31457280000,
  "currentSizeMB": 30000,
  "currentSizeGB": 29.3,
  "maxSize": 53687091200,
  "maxSizeGB": 50,
  "utilizationPercent": 59,
  "files": [
    {
      "key": "media_3_1234567890-abcde.mp4",
      "sizeMB": 2048,
      "lastAccessed": "2026-01-27T10:30:00.000Z",
      "downloading": false
    }
  ]
}
```

### Clear Entire Cache
```bash
POST /api/cache/clear
Authorization: Bearer <admin_token>

Response:
{
  "message": "Cache cleared successfully"
}
```

### Remove Specific File
```bash
DELETE /api/cache/:s3Key
Authorization: Bearer <admin_token>

Response:
{
  "message": "File removed from cache successfully"
}
```

## Monitoring

### Check Cache Usage
```bash
# Via API
curl -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  https://streaming.rexstream.net/api/cache/stats

# Via filesystem
du -sh /var/www/backend/cache/media
```

### View Cache Contents
```bash
ls -lh /var/www/backend/cache/media
```

## Cache Behavior

### When Files Are Downloaded
- First time a video is streamed
- After cache is cleared
- After file is manually removed from cache

### When Files Are Evicted
- Cache reaches maximum size limit
- Least recently used files are removed first
- Currently downloading files are never evicted
- 10% extra space is freed to reduce frequent evictions

### Signed URL Expiry (Not an Issue)
- Cached files are stored locally, no expiry
- Only initial download uses signed URL (1 hour expiry)
- Streams can run indefinitely using cached file

## Technical Details

### File Naming
- S3 key: `media/3/1234567890-abcde.mp4`
- Cache filename: `media_3_1234567890-abcde.mp4` (slashes replaced with underscores)

### Concurrency Handling
- If multiple channels request same video simultaneously
- First request downloads, others wait
- All use cached file once download completes
- Timeout: 5 minutes for download

### Cache Persistence
- Survives server restarts
- Metadata rebuilt from filesystem on startup
- Cache directory must not be deleted during streams

## Troubleshooting

### Cache Not Working
1. Check if cache directory exists:
   ```bash
   ls -la /var/www/backend/cache/media
   ```

2. Check permissions:
   ```bash
   sudo chown -R root:root /var/www/backend/cache
   sudo chmod -R 755 /var/www/backend/cache
   ```

3. Check logs:
   ```bash
   pm2 logs streaming-backend | grep -i cache
   ```

### Cache Full
If cache fills up frequently:
1. Increase `MAX_CACHE_SIZE_GB` in environment
2. Or clear cache manually: `POST /api/cache/clear`
3. Or remove unused videos from S3

### Download Failures
- Check S3 credentials are valid
- Check network connectivity to S3
- Check available disk space: `df -h`
- Check logs for specific errors

## Best Practices

1. **Set Appropriate Cache Size**
   - Calculate: (average video size) × (concurrent streams) × 2
   - Example: 2GB video × 10 streams × 2 = 40GB minimum

2. **Monitor Cache Usage**
   - Set up alerts when cache reaches 80% capacity
   - Regularly check cache statistics

3. **Regular Cleanup**
   - Remove deleted videos from cache
   - Clear cache when changing S3 bucket

4. **Backup Strategy**
   - Cache is temporary, S3 is source of truth
   - Don't backup cache directory
   - Can safely delete cache, will rebuild

## Cost Comparison Example

### Scenario: 5 Popular Videos Streamed Repeatedly

**Videos**:
- Video A (2GB) - streamed 100 times/month
- Video B (1.5GB) - streamed 80 times/month
- Video C (3GB) - streamed 60 times/month
- Video D (2.5GB) - streamed 40 times/month
- Video E (1GB) - streamed 20 times/month

**Without Cache**:
- Total: (2×100 + 1.5×80 + 3×60 + 2.5×40 + 1×20) = 540 GB
- Cost: 540 GB × $0.09/GB = **$48.60/month**

**With Cache**:
- First downloads: 2 + 1.5 + 3 + 2.5 + 1 = 10 GB
- Cost: 10 GB × $0.09/GB = **$0.90/month**
- **Savings: $47.70/month (98% reduction)**

## Migration from Direct S3 Streaming

The caching system is **automatically enabled**. No migration needed:

1. Existing local files: Continue working as before
2. S3 files: Automatically cached on first stream
3. Mixed storage: Both work seamlessly

## Security Considerations

- Cache directory is not publicly accessible
- Only authenticated admin users can clear cache
- Cached files have same permissions as application
- S3 credentials never stored in cache

## Conclusion

The media caching system provides:
- ✅ 90-99% cost reduction for repeated streams
- ✅ Faster stream startup (local access vs S3)
- ✅ No signed URL expiry issues
- ✅ Automatic cache management
- ✅ Zero configuration required (works out of the box)
- ✅ Admin-friendly management API

For 24/7 streaming operations with repeated content, this system can save **thousands of dollars per month** in AWS costs.
