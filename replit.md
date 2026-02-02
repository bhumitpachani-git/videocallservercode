# Video Server - Real-time Video Conferencing Platform

## Overview

This is a professional video conferencing server built with Node.js that provides real-time video/audio streaming, recording, transcription, and translation capabilities. The server uses MediaSoup for WebRTC-based media handling, Socket.IO for real-time signaling, and integrates with AWS services for storage and AI features.

**Core capabilities:**
- WebRTC video/audio streaming via MediaSoup SFU (Selective Forwarding Unit)
- Real-time recording with FFmpeg to WebM format
- Live transcription using **Browser Web Speech API** (FREE - no API costs!)
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

### Room Management & Session Lifecycle
- Rooms are managed in-memory with a Map structure in `src/services/room.service.js`
- Each room tracks: peers, producers, consumers, host, settings, whiteboard state, notes, polls
- Automatic cleanup timer removes empty rooms after 5 minutes of inactivity
- Router pool pre-creates routers for instant room joining
- **Session Management**: Each room maintains sessions with unique IDs
  - When all users leave, the current session is closed and all data is saved to DynamoDB
  - When users rejoin an empty room, a new session is automatically created
  - Session history includes: participant join/leave times, duration, all activity

### Real-time Features & Auto-Save
- **Chat**: Messages broadcast to room and **auto-saved to DynamoDB in real-time**
- **Whiteboard**: Drawing strokes synced in real-time and auto-saved
- **Notes**: Collaborative note-taking with debounced auto-save (2 second delay)
- **Polls**: Create/vote/close polls with **real-time saving of all poll state changes**
- **Transcription**: Uses browser's built-in Web Speech API (FREE), results broadcast to room and saved to DynamoDB
- **Translation**: Transcribed text translated via AWS Translate to each user's preferred language
- **User Events**: All join/leave events logged with timestamps and session duration

### History API (`/:roomId/history`)
- **Raw History**: `GET /api/room/:roomId/history` - returns all DynamoDB records
- **Organized History**: `GET /api/room/:roomId/history?organized=true` - returns data grouped by session with:
  - User joins and leaves with timestamps
  - Complete chat transcripts
  - All poll data with final results
  - Notes content
  - Transcription data
  - Session summary (duration, participant count, etc.)
- **Session-Specific**: `GET /api/room/:roomId/history?sessionId=SESS-xxx` - returns data for specific session

### Configuration
- `src/config/index.js` defines MediaSoup codecs, transport options, and quality presets
- Environment variables control ports, AWS credentials, and announced IPs
- RTC port range defaults to 10000-10100 for UDP/RTP traffic

## External Dependencies

### AWS Services (Required for full functionality)
- **AWS S3**: Stores recording files and chat transcripts
- **AWS DynamoDB**: Stores room metadata, user join logs, and recording details
- **AWS Translate**: Translates transcribed text to user's preferred language

### Browser-based Transcription (FREE)
- Uses the **Web Speech API** built into modern browsers (Chrome, Edge, Safari)
- No API costs - completely free speech-to-text
- Client does speech recognition, sends text to server via Socket.IO
- Server broadcasts transcriptions to all room participants
- Socket events: `start-transcription`, `browser-transcription`, `stop-transcription`

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