#!/bin/bash

# Multi-Channel Streaming Platform - Backend Setup Script
# This script helps set up the backend on Ubuntu/Debian systems

set -e

echo "=========================================="
echo "Backend Setup Script"
echo "=========================================="
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if running as root
if [ "$EUID" -eq 0 ]; then
  echo -e "${RED}Please do not run this script as root${NC}"
  exit 1
fi

# Check Node.js
echo -n "Checking Node.js... "
if command -v node &> /dev/null; then
  NODE_VERSION=$(node --version)
  echo -e "${GREEN}Found $NODE_VERSION${NC}"
else
  echo -e "${RED}Not found${NC}"
  echo "Please install Node.js 18+ first:"
  echo "  curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -"
  echo "  sudo apt install -y nodejs"
  exit 1
fi

# Check FFmpeg
echo -n "Checking FFmpeg... "
if command -v ffmpeg &> /dev/null; then
  echo -e "${GREEN}Found${NC}"
else
  echo -e "${RED}Not found${NC}"
  echo "Please install FFmpeg first:"
  echo "  sudo apt install -y ffmpeg"
  exit 1
fi

echo ""

# Install dependencies
echo "Installing npm dependencies..."
npm install

# Setup .env file
if [ ! -f .env ]; then
  echo ""
  echo "Creating .env file..."
  cp .env.example .env

  # Generate JWT secret
  JWT_SECRET=$(openssl rand -base64 32)

  # Update .env with generated secret
  if command -v sed &> /dev/null; then
    sed -i "s/your-super-secret-jwt-key-change-this-in-production/$JWT_SECRET/" .env
    echo -e "${GREEN}.env file created with secure JWT_SECRET${NC}"
  else
    echo -e "${YELLOW}Please manually update JWT_SECRET in .env${NC}"
  fi
else
  echo -e "${YELLOW}.env already exists, skipping${NC}"
fi

# Create required directories
echo ""
echo "Creating required directories..."

mkdir -p data
mkdir -p logs
mkdir -p var/hls

echo -e "${GREEN}Directories created${NC}"

# Check if /var/www/hls should be used
echo ""
echo "HLS output directory options:"
echo "1) Use local directory (./var/hls) - Good for development"
echo "2) Use system directory (/var/www/hls) - Better for production"
read -p "Choose option [1]: " HLS_OPTION
HLS_OPTION=${HLS_OPTION:-1}

if [ "$HLS_OPTION" == "2" ]; then
  echo "Setting up /var/www/hls..."
  sudo mkdir -p /var/www/hls
  sudo chown -R $USER:$USER /var/www/hls
  sudo chmod -R 755 /var/www/hls

  # Update .env
  sed -i "s|HLS_BASE_PATH=.*|HLS_BASE_PATH=/var/www/hls|" .env

  echo -e "${GREEN}System HLS directory configured${NC}"
fi

# Test database initialization
echo ""
echo "Testing database initialization..."
node -e "import('./src/models/database.js').then(() => console.log('Database initialized')).catch(err => { console.error(err); process.exit(1); })"

if [ $? -eq 0 ]; then
  echo -e "${GREEN}Database ready${NC}"
else
  echo -e "${RED}Database initialization failed${NC}"
  exit 1
fi

echo ""
echo "=========================================="
echo -e "${GREEN}Setup Complete!${NC}"
echo "=========================================="
echo ""
echo "Next steps:"
echo ""
echo "1. Review and update .env file:"
echo "   nano .env"
echo ""
echo "2. Start development server:"
echo "   npm run dev"
echo ""
echo "3. Or start with PM2 (production):"
echo "   npm run pm2:start"
echo ""
echo "4. Access admin panel at:"
echo "   http://localhost:3000"
echo ""
echo "Default credentials:"
echo "   Email: admin@example.com"
echo "   Password: admin123"
echo ""
echo -e "${YELLOW}⚠️  Change the default password after first login!${NC}"
echo ""
