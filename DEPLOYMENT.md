# AWS EC2 Deployment Guide

To deploy your video server professionally on AWS EC2, follow these steps:

## 1. EC2 Instance Requirements
- **Instance Type**: Minimum `t3.medium` (Puppeteer recording and MediaSoup require decent CPU/RAM).
- **Security Group**:
  - Inbound TCP `5000` (Signaling/UI)
  - Inbound UDP/TCP `10000-10100` (MediaSoup WebRTC)
  - Inbound TCP `80`, `443` (If using a reverse proxy)

## 2. Server Setup
```bash
# Install Docker and Docker Compose
sudo apt-get update
sudo apt-get install -y docker.io docker-compose
sudo usermod -aG docker $USER
```

## 3. Configuration
Create a `.env` file on the server:
```env
PUBLIC_IP=YOUR_EC2_PUBLIC_IP
AWS_ACCESS_KEY_ID=your_key
AWS_SECRET_ACCESS_KEY=your_secret
AWS_REGION=us-east-1
```

## 4. Run
```bash
docker-compose up -d --build
```

The server will be available at `http://your-ec2-ip:5000`.
