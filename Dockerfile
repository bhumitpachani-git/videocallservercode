# Use Node 20 as base
FROM node:20-slim

# Install system dependencies for MediaSoup, Puppeteer, and FFmpeg
RUN apt-get update && apt-get install -y \
    python3 \
    build-essential \
    ffmpeg \
    libnss3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    librandr2 \
    libgbm1 \
    libpango-1.0-0 \
    libcairo2 \
    libasound2 \
    ca-certificates \
    fonts-liberation \
    libappindicator3-1 \
    lsb-release \
    xdg-utils \
    wget \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies (including production only)
RUN npm install --legacy-peer-deps

# Copy source code
COPY . .

# Environment defaults
ENV PORT=5000
ENV NODE_ENV=production

# Expose ports for WebRTC (Signaling + Media)
EXPOSE 5000
EXPOSE 10000-10100/udp
EXPOSE 10000-10100/tcp

# Startup script to handle EC2 networking
CMD ["node", "server.js"]
