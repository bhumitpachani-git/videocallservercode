# Video Server (MediaSoup WebRTC)

## Overview
A video server application using MediaSoup and Socket.IO for real-time video streaming with WebRTC. Features AWS Transcribe for live transcription and AWS Translate for real-time translation.

## Project Structure
- `server.js` - Main Express server with MediaSoup WebRTC, Socket.IO, and AWS integration
- `recording-service.js` - Recording functionality for video sessions
- `package.json` - Node.js dependencies

## Running the Server
The server runs on port 5000 and includes:
- WebRTC media server via MediaSoup
- Socket.IO for signaling
- REST health check endpoint at `/health`

## Environment Variables
- `PORT` - Server port (default: 5000)
- `AWS_REGION` - AWS region for transcription/translation services
- `ANNOUNCED_IP` - Public IP for WebRTC transport

## Dependencies
- mediasoup - WebRTC SFU
- socket.io - Real-time communication
- express - Web framework
- @aws-sdk/client-transcribe-streaming - Live transcription
- @aws-sdk/client-translate - Translation
- puppeteer - Recording capabilities
