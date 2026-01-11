#!/bin/bash
cd /var/www/live-backend

# Pull latest changes
echo "📥 Pulling latest changes..."
git pull origin master

# Stop PM2
echo "🛑 Stopping PM2..."
pm2 delete ecosystem.config.js 2>/dev/null || true

# Start with new config
echo "🚀 Starting with new config..."
pm2 start ecosystem.config.cjs

# Save PM2 config
echo "💾 Saving PM2 config..."
pm2 save

# Show status
echo "📊 PM2 Status:"
pm2 status

# Show logs
echo "📋 Recent logs:"
pm2 logs streaming-backend --lines 20 --nostream
