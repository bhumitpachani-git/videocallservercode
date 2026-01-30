# Video Server - Real-time Video Conferencing Platform

## Overview

This is a professional video conferencing server built with Node.js that provides real-time video/audio streaming, recording, transcription, and translation capabilities. The server uses MediaSoup for WebRTC-based media handling, Socket.IO for real-time signaling, and integrates with AWS services for storage and AI features.

**Core capabilities:**
- WebRTC video/audio streaming via MediaSoup SFU (Selective Forwarding Unit)
- Real-time recording with FFmpeg to WebM format
- Live transcription using AWS Transcribe Streaming
- Real-time translation using AWS Translate
- Room-based collaboration with host controls, whiteboard, notes, and polls
- Professional recording with S3 upload and DynamoDB metadata storage

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

### Server Framework
- **Express.js** serves as the HTTP server foundation with security middleware (Helmet, rate limiting)
- **Socket.IO** handles all real-time WebSocket communication for signaling and feature events
- Entry point is `src/app.js` which bootstraps MediaSoup workers and initializes all services

### Media Pipeline (WebRTC)
- **MediaSoup** provides the SFU architecture for efficient multi-party video routing
- Each room gets a dedicated router from a pre-warmed router pool for instant room creation
- Transport types: WebRTC transports for client connections, PlainRTP transports for recording
- Codec support: VP8/H264 for video, Opus for audio with configurable quality settings

### Recording System
- Uses PlainRTP transports to consume media streams and pipe to FFmpeg
- FFmpeg processes multiple audio/video streams into a combined WebM file
- Recordings are uploaded to S3 with metadata stored in DynamoDB
- Located in `src/services/recording.service.js`

### Room Management
- Rooms are managed in-memory with a Map structure in `src/services/room.service.js`
- Each room tracks: peers, producers, consumers, host, settings, whiteboard state, notes, polls
- Automatic cleanup timer removes empty rooms after inactivity period
- Router pool pre-creates routers for instant room joining

### Real-time Features
- **Chat**: Messages broadcast to room with optional S3 transcript persistence
- **Whiteboard**: Drawing strokes synced in real-time across participants
- **Notes**: Collaborative note-taking synced to all room members
- **Polls**: Host can create polls, all members can vote, results broadcast live
- **Transcription**: Audio streams sent to AWS Transcribe, results broadcast with speaker attribution
- **Translation**: Transcribed text translated via AWS Translate to each user's target language

### Configuration
- `src/config/index.js` defines MediaSoup codecs, transport options, and quality presets
- Environment variables control ports, AWS credentials, and announced IPs
- RTC port range defaults to 10000-10100 for UDP/RTP traffic

## External Dependencies

### AWS Services (Required for full functionality)
- **AWS S3**: Stores recording files and chat transcripts
- **AWS DynamoDB**: Stores room metadata, user join logs, and recording details
- **AWS Transcribe Streaming**: Real-time speech-to-text for live captions
- **AWS Translate**: Translates transcribed text to user's preferred language

### Core NPM Packages
- **mediasoup**: WebRTC SFU for video/audio routing (requires native compilation)
- **socket.io**: WebSocket server for real-time signaling
- **express**: HTTP server framework
- **ffmpeg-static**: Pre-built FFmpeg binary for recording processing
- **zod**: Request validation schemas

### Infrastructure Requirements
- Node.js 16+ required
- FFmpeg must be available (provided by ffmpeg-static)
- UDP ports 10000-10100 must be accessible for RTC traffic
- Environment variables needed: AWS credentials, ANNOUNCED_IP for WebRTC