const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const logger = require('../utils/logger');
const config = require('../config');
const { saveRoomDetails, uploadFileToS3 } = require('./aws.service');

const recordingSessions = new Map();
const MAX_CONCURRENT_RECORDINGS = 5;

function getCodecInfo(rtpParameters) {
    const codec = rtpParameters.codecs[0];
    const mimeType = codec.mimeType.toLowerCase();

    return {
        mimeType,
        payloadType: codec.payloadType,
        clockRate: codec.clockRate,
        channels: codec.channels || 2,
        parameters: codec.parameters || {}
    };
}

async function createPlainTransport(router, isVideo = false) {
    const transport = await router.createPlainTransport({
        listenIp:       { ip: '127.0.0.1', announcedIp: null },
        rtcpMux:        true,
        comedia:        false,               // We use explicit connect()
        enableSrtp:     false,
        enableSctp:     false
    });

    logger.info(`[Recording] Created PlainTransport (explicit connect mode) on port ${transport.tuple.localPort} for ${isVideo ? 'video' : 'audio'}`);
    return transport;
}

async function createRecordingConsumer(router, transport, producer) {
    const consumer = await transport.consume({
        producerId: producer.id,
        rtpCapabilities: router.rtpCapabilities,
        paused: true
    });

    logger.info(`[Recording] Created consumer ${consumer.id} for ${producer.kind} producer ${producer.id}`);
    return consumer;
}

async function startRecording(roomId, startedBy, io, rooms) {
    logger.info(`[Recording] Starting recording for room: ${roomId}`);

    if (recordingSessions.size >= MAX_CONCURRENT_RECORDINGS) {
        throw new Error('Server recording capacity reached. Please try again later.');
    }

    const room = rooms.get(roomId);
    if (!room) throw new Error('Room not found');

    if (recordingSessions.has(roomId)) throw new Error('Recording already in progress');

    const dir = path.join(__dirname, '..', '..', 'recordings', roomId);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const recordingId = `${roomId}-${Date.now()}`;

    const session = {
        recordingId,
        roomId,
        startedAt: new Date().toISOString(),
        startedBy,
        transports: new Map(),
        consumers: new Map(),
        processes: new Map(),
        peerRecordings: new Map(),
        transcripts: [],
        recordingDir: dir
    };

    recordingSessions.set(roomId, session);

    for (const [peerId, peer] of room.peers.entries()) {
        if (peer.isRecorder) continue;
        await startRecordingForPeer(roomId, peerId, peer, room.router, session, dir);
    }

    logger.info(`[Recording] Started for room ${roomId}, recording ID: ${recordingId}`);
    return session;
}

async function startRecordingForPeer(roomId, peerId, peer, router, session, recordingDir) {
    try {
        logger.info(`[Recording] ==================== Starting recording for peer ${peerId} ====================`);

        const peerRecording = {
            peerId,
            username: peer.username || 'unknown',
            audioTransport: null,
            videoTransport: null,
            audioConsumer: null,
            videoConsumer: null,
            process: null,
            outputPath: null
        };

        let audioInfo = null;
        let videoInfo = null;

        if (peer.producers.size === 0) {
            logger.warn(`[Recording] Peer ${peerId} has no producers — skipping`);
            return;
        }

        for (const [producerId, producer] of peer.producers.entries()) {
            const transport = await createPlainTransport(router, producer.kind === 'video');
            const consumer = await createRecordingConsumer(router, transport, producer);

            const codecInfo = getCodecInfo(consumer.rtpParameters);
            const mediasoupPort = transport.tuple.localPort;

            session.transports.set(transport.id, transport);
            session.consumers.set(consumer.id, consumer);

            if (producer.kind === 'audio') {
                peerRecording.audioTransport = transport;
                peerRecording.audioConsumer = consumer;
                audioInfo = { mediasoupPort, codecInfo, consumer, transport };
            } else if (producer.kind === 'video') {
                peerRecording.videoTransport = transport;
                peerRecording.videoConsumer = consumer;
                videoInfo = { mediasoupPort, codecInfo, consumer, transport };
            }
        }

        const safeUsername = (peer.username || 'unknown').replace(/[^a-zA-Z0-9]/g, '_');
        const outputPath = path.join(recordingDir, `${session.recordingId}-${safeUsername}-${peerId.substring(0, 8)}.webm`);
        peerRecording.outputPath = outputPath;

        const basePort = 30000 + Math.floor(Math.random() * 20000);
        const ffmpegAudioPort = audioInfo ? basePort : null;
        const ffmpegVideoPort = videoInfo ? basePort + 2 : null;

        const sdpLines = [
            'v=0',
            'o=- 0 0 IN IP4 127.0.0.1',
            's=Mediasoup Peer Recording',
            'c=IN IP4 127.0.0.1',
            't=0 0'
        ];

        if (audioInfo) {
            sdpLines.push(
                `m=audio ${ffmpegAudioPort} RTP/AVP ${audioInfo.codecInfo.payloadType}`,
                `a=rtpmap:${audioInfo.codecInfo.payloadType} opus/48000/2`,
                'a=fmtp:111 minptime=10;useinbandfec=1;usedtx=1',
                'a=recvonly'
            );
        }

        if (videoInfo) {
            sdpLines.push(
                `m=video ${ffmpegVideoPort} RTP/AVP ${videoInfo.codecInfo.payloadType}`,
                `a=rtpmap:${videoInfo.codecInfo.payloadType} VP8/90000`,
                'a=fmtp:96 x-google-start-bitrate=1000',
                'a=recvonly'
            );
        }

        const sdp = sdpLines.join('\n') + '\n';

        let ffmpegArgs = [
            '-y',
            '-loglevel', 'info',
            '-protocol_whitelist', 'pipe,udp,rtp,file,crypto',
            '-analyzeduration', '20000000',
            '-probesize', '20000000',
            '-fflags', '+genpts+discardcorrupt+igndts',
            '-f', 'sdp',
            '-i', 'pipe:0'
        ];

        if (videoInfo && audioInfo) {
            ffmpegArgs = ffmpegArgs.concat([
                '-map', '0:v?', '-map', '0:a?',
                '-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '1M',
                '-c:a', 'libopus', '-b:a', '128k',
                '-f', 'webm', outputPath
            ]);
        } else if (videoInfo) {
            ffmpegArgs = ffmpegArgs.concat([
                '-an',
                '-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '1M',
                '-f', 'webm', outputPath
            ]);
        } else if (audioInfo) {
            const audioOutput = outputPath.replace('.webm', '.opus');
            peerRecording.outputPath = audioOutput;
            ffmpegArgs = ffmpegArgs.concat([
                '-vn',
                '-c:a', 'libopus', '-b:a', '128k',
                '-f', 'ogg', audioOutput
            ]);
        }

        const ffmpegProcess = spawn('ffmpeg', ffmpegArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
        peerRecording.process = ffmpegProcess;
        session.processes.set(peerId, ffmpegProcess);

        ffmpegProcess.stdin.write(sdp);
        ffmpegProcess.stdin.end();

        await new Promise(r => setTimeout(r, 3000));

        if (audioInfo) {
            await audioInfo.transport.connect({ ip: '127.0.0.1', port: ffmpegAudioPort });
            await audioInfo.consumer.resume();
        }

        if (videoInfo) {
            await videoInfo.transport.connect({ ip: '127.0.0.1', port: ffmpegVideoPort });
            await videoInfo.consumer.resume();
        }

        session.peerRecordings.set(peerId, peerRecording);
        logger.info(`[Recording][${peerId}] ✓ Peer recording setup complete`);

    } catch (error) {
        logger.error(`[Recording] Failed for peer ${peerId}:`, error);
    }
}

async function stopRecording(roomId) {
    const session = recordingSessions.get(roomId);
    if (!session) throw new Error('No recording in progress');

    logger.info(`[Recording] Stopping room ${roomId}`);

    for (const consumer of session.consumers.values()) {
        try { if (!consumer.closed && !consumer.paused) await consumer.pause(); } catch {}
    }

    await new Promise(r => setTimeout(r, 2000));

    for (const process of session.processes.values()) {
        if (process && !process.killed) {
            try { process.stdin.write('q\n'); process.stdin.end(); } catch {}
            await new Promise(r => setTimeout(r, 2000));
            if (!process.killed) process.kill('SIGTERM');
        }
    }

    await new Promise(r => setTimeout(r, 2000));

    for (const consumer of session.consumers.values()) {
        try { if (!consumer.closed) consumer.close(); } catch {}
    }
    for (const transport of session.transports.values()) {
        try { if (!transport.closed) transport.close(); } catch {}
    }

    const files = [];
    for (const rec of session.peerRecordings.values()) {
        if (fs.existsSync(rec.outputPath)) {
            const stats = fs.statSync(rec.outputPath);
            files.push({
                peerId: rec.peerId,
                username: rec.username,
                file: path.basename(rec.outputPath),
                size: stats.size
            });
        }
    }

    const metadataPath = path.join(session.recordingDir, `${session.recordingId}-metadata.json`);
    const metadata = {
        recordingId: session.recordingId,
        roomId,
        startedAt: session.startedAt,
        endedAt: new Date().toISOString(),
        files
    };

    fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
    recordingSessions.delete(roomId);

    return { recordingId: session.recordingId, files, metadata };
}


function addTranscript(roomId, transcript) {
    const session = recordingSessions.get(roomId);
    if (session && transcript) {
        session.transcripts.push({
            timestamp: new Date().toISOString(),
            ...transcript
        });
    }
}

module.exports = {
    startRecording,
    stopRecording,
    addTranscript,
    recordingSessions
};