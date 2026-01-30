const { TranscribeStreamingClient, StartStreamTranscriptionCommand } = require('@aws-sdk/client-transcribe-streaming');
const { PassThrough } = require('stream');
const config = require('../config');
const { translateText } = require('./translation.service');
const { saveTranscription } = require('./aws.service');

const transcribeClient = new TranscribeStreamingClient(config.AWS);

const LANGUAGE_CODE_MAP = {
  'auto': 'auto',
  'en': 'en-US',
  'es': 'es-US',
  'fr': 'fr-FR',
  'de': 'de-DE',
  'it': 'it-IT',
  'pt': 'pt-BR',
  'zh': 'zh-CN',
  'ja': 'ja-JP',
  'ko': 'ko-KR',
  'ar': 'ar-SA',
  'hi': 'hi-IN',
  'gu': 'gu-IN',
  'mr': 'mr-IN',
  'ta': 'ta-IN',
  'te': 'te-IN',
  'ru': 'ru-RU',
};

const AWS_TO_SHORT_CODE = Object.fromEntries(
  Object.entries(LANGUAGE_CODE_MAP).map(([k, v]) => [v, k])
);

const transcriptionSessions = new Map();

async function handleTranscription(socket, io, rooms, recordingSessions, { roomId, username, targetLanguage = 'en', speakingLanguage = 'en' }) {

  const actualSpeakingLanguage = speakingLanguage === 'auto' ? 'en' : speakingLanguage;
  console.log(`[Transcription] Starting for ${username} in room ${roomId}, speaking: ${actualSpeakingLanguage}, target: ${targetLanguage}`);

  const room = rooms.get(roomId);
  if (!room) {
    socket.emit('transcription-error', { error: 'Room not found' });
    return;
  }

  const audioStream = new PassThrough();

  const session = {
    socketId: socket.id,
    roomId,
    username,
    targetLanguage,
    speakingLanguage: actualSpeakingLanguage,
    audioStream,
    isActive: true,
  };

  transcriptionSessions.set(socket.id, session);

  try {
    const awsLanguageCode = LANGUAGE_CODE_MAP[actualSpeakingLanguage] || 'en-US';
    
    const transcribeParams = {
      MediaEncoding: 'pcm',
      MediaSampleRateHertz: 16000,
      AudioStream: (async function* () {
        for await (const chunk of audioStream) {
          if (transcriptionSessions.get(socket.id)?.isActive) {
            yield { AudioEvent: { AudioChunk: chunk } };
          }
        }
      })(),
      LanguageCode: awsLanguageCode
    };

    const command = new StartStreamTranscriptionCommand(transcribeParams);
    const response = await transcribeClient.send(command);

    for await (const event of response.TranscriptResultStream) {
      const currentSession = transcriptionSessions.get(socket.id);
      if (!currentSession || !currentSession.isActive) break;

      if (!event.TranscriptEvent) continue;

      const results = event.TranscriptEvent.Transcript.Results || [];

      for (const result of results) {
        if (!result.Alternatives?.length) continue;

        const transcript = result.Alternatives[0].Transcript;
        const isFinal = !result.IsPartial;

        if (!transcript || transcript.trim() === '') continue;

        const speakerLanguage = currentSession.speakingLanguage;

        for (const [peerId, peer] of room.peers.entries()) {
          const peerSession = transcriptionSessions.get(peerId);
          const peerTargetLang = peerSession?.targetLanguage || 'en';

          let translatedText = transcript;
          let shouldTranslate = false;

          if (peerId !== socket.id && peerTargetLang !== 'auto' && peerTargetLang !== speakerLanguage) {
            shouldTranslate = true;
            try {
              translatedText = await translateText(
                transcript,
                speakerLanguage,
                peerTargetLang
              );
              console.log(`[Translation] ${speakerLanguage} → ${peerTargetLang} for ${peer.username}: "${translatedText}"`);
            } catch (error) {
              console.error('[Translation] Error:', error);
              translatedText = transcript;
              shouldTranslate = false;
            }
          }

          const finalDisplayedText = (peerId === socket.id) ? transcript : (shouldTranslate ? translatedText : transcript);

          if (isFinal && peerId === socket.id) {
            saveTranscription(roomId, room.sessionId, {
              socketId: socket.id,
              username,
              transcript,
              language: speakerLanguage
            }).catch(err => console.error('[AWS] Live transcription save failed:', err));
          }

          const transcriptionPayload = {
            id: `${socket.id}-${Date.now()}-${Math.random()}`,
            socketId: socket.id,
            username,
            originalText: transcript,
            translatedText: (peerId === socket.id) ? undefined : (shouldTranslate && translatedText !== transcript ? translatedText : undefined),
            displayedText: finalDisplayedText,
            originalLanguage: speakerLanguage,
            targetLanguage: (peerId === socket.id) ? speakerLanguage : peerTargetLang,
            isFinal,
            timestamp: new Date().toISOString(),
          };

          const recordingSession = recordingSessions.get(roomId);
          if (recordingSession && isFinal && peerId === socket.id) {
            if (!recordingSession.transcripts) recordingSession.transcripts = [];
            recordingSession.transcripts.push({
              ...transcriptionPayload,
              translatedText: undefined,
            });
          }

          io.to(peerId).emit('transcription', transcriptionPayload);
        }
      }
    }
  } catch (error) {
    console.error('[Transcription] Error:', error);
    socket.emit('transcription-error', {
      error: error.message || 'Transcription failed',
    });
  } finally {
    const sessionToClose = transcriptionSessions.get(socket.id);
    if (sessionToClose) {
      sessionToClose.isActive = false;
    }
  }
}

module.exports = { handleTranscription, transcriptionSessions };
