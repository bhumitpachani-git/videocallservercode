const { translateText } = require('./translation.service');
const { saveTranscription, saveFullTranscription } = require('./aws.service');

const transcriptionSessions = new Map();

async function handleTranscription(socket, io, rooms, recordingSessions, { roomId, username, targetLanguage = 'en', speakingLanguage = 'en' }) {
  console.log(`[Transcription] Starting browser-based transcription for ${username} in room ${roomId}`);

  const room = rooms.get(roomId);
  if (!room) {
    socket.emit('transcription-error', { error: 'Room not found' });
    return;
  }

  const session = {
    socketId: socket.id,
    roomId,
    username,
    targetLanguage,
    speakingLanguage,
    isActive: true,
    fullTranscript: ''
  };

  transcriptionSessions.set(socket.id, session);

  socket.emit('transcription-ready', {
    message: 'Browser speech recognition enabled. Speak into your microphone.',
    method: 'browser-speech-api'
  });
}

async function handleBrowserTranscription(socket, io, rooms, { roomId, username, text, isFinal, targetLanguage, speakingLanguage }) {
  if (!text || text.trim() === '') return;

  const room = rooms.get(roomId);
  if (!room) return;

  const session = transcriptionSessions.get(socket.id);
  if (!session) return;

  let displayedText = text;
  
  if (targetLanguage && targetLanguage !== 'auto' && targetLanguage !== speakingLanguage) {
    try {
      displayedText = await translateText(text, speakingLanguage, targetLanguage);
    } catch (err) {
      console.error('[Translation] Failed:', err.message);
      displayedText = text;
    }
  }

  if (isFinal && session.fullTranscript !== undefined) {
    session.fullTranscript += text + ' ';
  }

  const transcriptionPayload = {
    id: `${socket.id}-${Date.now()}`,
    socketId: socket.id,
    username,
    originalText: text,
    displayedText,
    isFinal,
    timestamp: new Date().toISOString(),
    source: 'browser-speech-api'
  };

  io.to(roomId).emit('transcription', transcriptionPayload);

  if (isFinal) {
    saveTranscription(roomId, room.sessionId, {
      type: 'TRANSCRIPTION',
      username,
      text,
      translatedText: displayedText !== text ? displayedText : null,
      timestamp: new Date().toISOString()
    }).catch(err => console.error('[AWS] Transcription save failed:', err));
  }
}

function stopTranscription(socketId) {
  const session = transcriptionSessions.get(socketId);
  if (session) {
    session.isActive = false;
    
    if (session.fullTranscript && session.fullTranscript.trim()) {
      saveFullTranscription(session.roomId, null, session.fullTranscript)
        .catch(err => console.error('[AWS] Full transcription save failed:', err));
    }
    
    transcriptionSessions.delete(socketId);
    console.log(`[Transcription] Stopped for socket ${socketId}`);
  }
}

module.exports = { 
  handleTranscription, 
  handleBrowserTranscription,
  stopTranscription,
  transcriptionSessions 
};
