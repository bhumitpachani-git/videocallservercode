# Video Server (MediaSoup WebRTC)

## Overview
A video server application using MediaSoup and Socket.IO for real-time video streaming with WebRTC. Features AWS Transcribe for live transcription and AWS Translate for real-time translation.

## Project Architecture
- `src/app.js`: Main entry point, sets up Express and Socket.IO.
- `src/config/`: Application configuration and media settings.
- `src/services/`: Core business logic
  - `socket.handler.js`: All Socket.IO event handlers
  - `room.service.js`: Room management with RoomManager class
  - `transcription.service.js`: AWS Transcribe integration
  - `translation.service.js`: AWS Translate integration
  - `recording.service.js`: Video recording with Puppeteer
  - `aws.service.js`: DynamoDB and S3 integrations
- `src/utils/`: Utilities (logger, validation)
- `src/routes/`: REST API routes
- `src/controllers/`: Request handlers

## Socket.IO Events
### Room Events
- `join-room` - Join a room with username/password
- `disconnect` - Handle user disconnection with host migration

### Host Controls
- `mute-participant` - Host can mute participants

### WebRTC Transport
- `create-transport` - Create WebRTC transport
- `connect-transport` - Connect transport with DTLS
- `produce` - Start producing media
- `consume` - Consume remote media
- `resume-consumer` - Resume paused consumer
- `get-producers` - Get list of active producers

### Screen Sharing
- `mark-screen-share` - Notify screen share started
- `screen-share-stopped` - Notify screen share ended

### Transcription
- `start-transcription` - Start AWS Transcribe
- `audio-chunk` - Send audio data for transcription
- `stop-transcription` - Stop transcription
- `set-target-language` - Set translation target language

### Recording
- `start-recording` - Start room recording
- `stop-recording` - Stop and save recording

### Chat
- `chat-message` - Send chat message
- `send-chat-message` - Alternative chat event

### Peer Status
- `peer-track-status` - Notify track enabled/disabled

### Polls
- `create-poll` - Create a new poll
- `submit-vote` - Vote on a poll
- `close-poll` - Close a poll (creator only)

### Whiteboard
- `whiteboard-draw` - Draw on whiteboard
- `whiteboard-clear` - Clear whiteboard
- `whiteboard-undo` - Undo last stroke
- `whiteboard-present` - Toggle presentation mode

### Notes
- `notes-update` - Update shared notes
- `notes-present` - Toggle notes presentation

## Running the Server
The server runs on port 5000 and includes:
- WebRTC media server via MediaSoup
- Socket.IO for signaling
- REST health check endpoint at `/health`

## Environment Variables
- `PORT` - Server port (default: 5000)
- `AWS_REGION` - AWS region for transcription/translation services
- `AWS_ACCESS_KEY_ID` - AWS access key
- `AWS_SECRET_ACCESS_KEY` - AWS secret key
- `ANNOUNCED_IP` - Public IP for WebRTC transport
- `S3_BUCKET_NAME` - S3 bucket for recordings (optional)

## Dependencies
- mediasoup - WebRTC SFU
- socket.io - Real-time communication
- express - Web framework
- @aws-sdk/client-transcribe-streaming - Live transcription
- @aws-sdk/client-translate - Translation
- @aws-sdk/client-dynamodb - DynamoDB integration
- @aws-sdk/client-s3 - S3 storage
- puppeteer - Recording capabilities
- winston - Logging
