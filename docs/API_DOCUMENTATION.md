# Professional Video Server API Documentation

## Overview
This server provides high-performance WebRTC video conferencing using MediaSoup, professional Puppeteer-based recording, and AWS-native storage (S3 + DynamoDB).

## Base URL
`https://[your-domain]`

---

## REST API Endpoints

### 1. Get Room Details
- **Endpoint**: `GET /api/rooms/:roomId`
- **Description**: Returns metadata and current status of a meeting room.
- **Response**:
```json
{
  "roomId": "room-123",
  "hasPassword": true,
  "settings": { "video": { "res": "720p" }, "audio": { "rate": 48000 } },
  "activeParticipants": 5,
  "createdAt": "2026-01-28T..."
}
```

### 2. Update Room Settings
- **Endpoint**: `POST /api/rooms/:roomId/settings`
- **Body**: `{ "video": { "res": "1080p", "fps": 60 } }`
- **Description**: Updates professional quality settings for the room.

### 3. Save Chat Transcript
- **Endpoint**: `POST /api/rooms/:roomId/transcript`
- **Body**: `{ "transcript": "Full chat text..." }`

---

## Socket.IO Events (Signaling)

### Client to Server
- `join-room`: `{ "roomId": "...", "username": "...", "password": "..." }`
- `create-transport`: `{ "roomId": "..." }`
- `start-recording`: `{ "roomId": "..." }`
- `stop-recording`: `{ "roomId": "..." }`
- `update-room-settings`: `{ "roomId": "...", "settings": { ... } }`

### Server to Client
- `user-joined`: `{ "socketId": "...", "username": "..." }`
- `recording-started`: `{ "recordingId": "..." }`
- `recording-stopped`: `{ "result": { "s3Url": "..." } }`
- `room-settings-updated`: `{ ...settings }`

---

## AWS Storage Structure
- **DynamoDB (Table: MeetingLogs)**:
  - `pk`: `ROOM#[roomId]`
  - `sk`: `JOIN#[socketId]#[timestamp]` or `METADATA`
- **S3 (Bucket: Recordings)**:
  - Path: `recordings/[roomId]/[recordingId].mp4`
