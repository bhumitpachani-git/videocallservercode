# Video Server (MediaSoup WebRTC)

## Overview
A video server application using MediaSoup and Socket.IO for real-time video streaming with WebRTC. Features AWS Transcribe for live transcription and AWS Translate for real-time translation.

## Project Architecture
- `server.js`: Main entry point, sets up Express and Socket.IO.
- `src/config/`: Application configuration and media settings.
- `src/services/`: Core business logic (transcription, translation).
- `recording-service.js`: Specialized service for video recording.

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
