# Video Server API & WebSocket Documentation

This document provides technical details for the Video Server backend to help frontend developers integrate WebRTC, Socket.IO, and Admin features.

## 🚀 Server Information
- **Base URL**: `https://<your-replit-domain>`
- **API Prefix**: `/api`
- **Socket.IO Namespace**: Root (`/`)

---

## 📡 WebSocket API (Socket.IO)

### Room Connection
- **`join-room`**: (Send) `{ roomId, username, password }`
- **`sync-state`**: (Receive) Current room state (whiteboard, notes, polls)
- **`active-producers`**: (Receive) List of current media streams in the room

### WebRTC Transport (MediaSoup)
- **`create-transport`**: (Send) `{ direction: 'send' | 'recv' }`
- **`connect-transport`**: (Send) `{ transportId, dtlsParameters }`
- **`produce`**: (Send) `{ transportId, kind, rtpParameters, appData }`
- **`consume`**: (Send) `{ transportId, producerId, rtpCapabilities }`

### Features
- **`chat-message`**: (Send/Receive) `{ text, username }`
- **`whiteboard-draw`**: (Send/Receive) Real-time drawing data
- **`create-poll`**: (Send/Receive) `{ question, options }`
- **`submit-vote`**: (Send) `{ pollId, optionIndex }`

---

## 🛠 REST API Endpoints

### 1. Health Check
`GET /health`
- **Description**: Verify server is running.
- **Response**: `{ status: "ok", uptime: 1234 }`

### 2. Get Room Info
`GET /api/rooms/:roomId`
- **Description**: Check if a room exists and its settings.
- **Response**: `{ roomId, hasPassword, settings, activeParticipants }`

### 3. Update Room Settings
`POST /api/rooms/:roomId/settings`
- **Body**: `{ video: { res, fps, bitrate }, audio: { rate, channels } }`
- **Description**: Update media quality for the room.

### 4. Admin Dashboard API
`GET /api/rooms/:roomId/admin`
- **Description**: Get comprehensive room status and historical logs from DynamoDB.
- **Response**:
  ```json
  {
    "roomId": "room123",
    "isLive": true,
    "liveDetails": { "activeParticipants": 5, "participants": [...] },
    "history": [ { "type": "USER_JOIN", "timestamp": "...", "details": {...} } ]
  }
  ```

---

## 📊 Database (DynamoDB)
The server automatically logs:
1. **Room Creation**: When a new room is initialized.
2. **User Joins**: Every time a participant enters.
3. **Chat Transcripts**: Periodically saved to the database.
4. **Meeting Metadata**: Room lifecycle tracking.

---

## 📝 Admin Interface
Access the built-in control panel at:
`GET /admin.html`
- Allows monitoring live rooms and reviewing past meeting data from DynamoDB.