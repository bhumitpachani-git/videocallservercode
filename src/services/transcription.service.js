const { TranscribeStreamingClient, StartStreamTranscriptionCommand } = require('@aws-sdk/client-transcribe-streaming');
const { PassThrough } = require('stream');
const config = require('../config');
const { translateText } = require('./translation.service');

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
  'ru': 'ru-RU',
};

const AWS_TO_SHORT_CODE = Object.fromEntries(
  Object.entries(LANGUAGE_CODE_MAP).map(([k, v]) => [v, k])
);

async function handleTranscription(socket, io, rooms, recordingSessions, { roomId, username, targetLanguage = 'en', speakingLanguage = 'auto' }) {
  const room = rooms.get(roomId);
  if (!room) return;

  const audioStream = new PassThrough();
  const session = {
    socketId: socket.id,
    roomId,
    username,
    targetLanguage,
    speakingLanguage,
    audioStream,
    isActive: true,
  };

  try {
    const transcribeParams = {
      MediaEncoding: 'pcm',
      MediaSampleRateHertz: 16000,
      AudioStream: (async function* () {
        for await (const chunk of audioStream) {
          if (session.isActive) yield { AudioEvent: { AudioChunk: chunk } };
        }
      })(),
    };

    if (speakingLanguage === 'auto') {
      transcribeParams.IdentifyLanguage = true;
      transcribeParams.LanguageOptions = Object.values(LANGUAGE_CODE_MAP).filter(v => v !== 'auto').join(',');
    } else {
      transcribeParams.LanguageCode = LANGUAGE_CODE_MAP[speakingLanguage] || 'en-US';
    }

    const command = new StartStreamTranscriptionCommand(transcribeParams);
    const response = await transcribeClient.send(command);

    for await (const event of response.TranscriptResultStream) {
      if (!session.isActive || !event.TranscriptEvent) continue;

      const results = event.TranscriptEvent.Transcript.Results || [];
      for (const result of results) {
        if (!result.Alternatives?.length) continue;

        const transcript = result.Alternatives[0].Transcript;
        const isFinal = !result.IsPartial;
        const detectedLanguage = AWS_TO_SHORT_CODE[result.LanguageCode] || 'en';
        const actualLanguage = speakingLanguage !== 'auto' ? speakingLanguage : detectedLanguage;

        for (const [peerId, peer] of room.peers.entries()) {
          let translatedText = transcript;
          if (peerId !== socket.id && targetLanguage !== 'auto' && targetLanguage !== actualLanguage) {
            translatedText = await translateText(transcript, actualLanguage, targetLanguage);
          }

          const payload = {
            id: `${socket.id}-${Date.now()}`,
            socketId: socket.id,
            username,
            originalText: transcript,
            translatedText: translatedText !== transcript ? translatedText : undefined,
            originalLanguage: actualLanguage,
            isFinal,
            timestamp: new Date().toISOString(),
          };

          io.to(peerId).emit('transcription', payload);
        }
      }
    }
  } catch (error) {
    console.error('[Transcription] Error:', error.message);
  } finally {
    session.isActive = false;
  }
  return session;
}

module.exports = { handleTranscription };
