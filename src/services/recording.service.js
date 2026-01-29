const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const logger = require('../utils/logger');
const config = require('../config');
const { saveRoomDetails, uploadFileToS3 } = require('./aws.service');

const recordingSessions = new Map();

function generateSdpForConsumer(consumer, transport, kind) {
    const rtpParameters = consumer.rtpParameters;
    const codec = rtpParameters.codecs[0];
    const payloadType = codec.payloadType;
    const clockRate = codec.clockRate;
    const localPort = transport.tuple.localPort;
    
    let sdp = `v=0
o=- 0 0 IN IP4 127.0.0.1
s=Recording
c=IN IP4 127.0.0.1
t=0 0
`;

    if (kind === 'audio') {
        const channels = codec.channels || 1;
        sdp += `m=audio ${localPort} RTP/AVP ${payloadType}
a=rtpmap:${payloadType} ${codec.mimeType.split('/')[1]}/${clockRate}/${channels}
`;
    } else {
        sdp += `m=video ${localPort} RTP/AVP ${payloadType}
a=rtpmap:${payloadType} ${codec.mimeType.split('/')[1]}/${clockRate}
`;
        if (codec.parameters) {
            const fmtpParams = Object.entries(codec.parameters)
                .map(([k, v]) => `${k}=${v}`)
                .join(';');
            if (fmtpParams) {
                sdp += `a=fmtp:${payloadType} ${fmtpParams}
`;
            }
        }
    }

    return sdp;
}

async function createPlainTransport(router) {
    const transport = await router.createPlainTransport({
        listenIp: { ip: '127.0.0.1', announcedIp: null },
        rtcpMux: true,
        comedia: false
    });
    return transport;
}

async function createRecordingConsumer(router, transport, producer) {
    const consumer = await transport.consume({
        producerId: producer.id,
        rtpCapabilities: router.rtpCapabilities,
        paused: false
    });
    
    logger.info(`[Recording] Created consumer for ${producer.kind} producer ${producer.id}`);
    return consumer;
}

async function startRecording(roomId, startedBy, io, rooms) {
    logger.info(`[Recording] Starting recording for room: ${roomId}`);
    
    const room = rooms.get(roomId);
    if (!room) {
        throw new Error('Room not found');
    }

    if (recordingSessions.has(roomId)) {
        throw new Error('Recording already in progress');
    }

    const dir = path.join(__dirname, '..', '..', 'recordings', roomId);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const recordingId = `${roomId}-${Date.now()}`;
    const outputPath = path.join(dir, `${recordingId}.mp4`);

    const session = {
        recordingId,
        roomId,
        outputPath,
        startedAt: new Date().toISOString(),
        startedBy,
        transports: new Map(),
        consumers: new Map(),
        ffmpegProcesses: new Map(),
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
        const peerRecording = {
            peerId,
            username: peer.username || 'unknown',
            audioTransport: null,
            videoTransport: null,
            audioConsumer: null,
            videoConsumer: null,
            ffmpegProcess: null,
            outputPath: null,
            sdpPaths: []
        };

        let audioPort, videoPort;
        let audioConsumer, videoConsumer;
        let audioTransport, videoTransport;

        for (const [producerId, producer] of peer.producers.entries()) {
            const transport = await createPlainTransport(router);
            const consumer = await createRecordingConsumer(router, transport, producer);
            
            const port = transport.tuple.localPort;
            
            await transport.connect({
                ip: '127.0.0.1',
                port: port
            });

            if (producer.kind === 'audio') {
                peerRecording.audioTransport = transport;
                peerRecording.audioConsumer = consumer;
                audioPort = port;
                audioConsumer = consumer;
                audioTransport = transport;
            } else if (producer.kind === 'video') {
                peerRecording.videoTransport = transport;
                peerRecording.videoConsumer = consumer;
                videoPort = port;
                videoConsumer = consumer;
                videoTransport = transport;
            }

            session.transports.set(transport.id, transport);
            session.consumers.set(consumer.id, consumer);
        }

        if (!audioPort && !videoPort) {
            logger.warn(`[Recording] No producers found for peer ${peerId}`);
            return;
        }

        const safeUsername = (peer.username || 'unknown').replace(/[^a-zA-Z0-9]/g, '_');
        const outputPath = path.join(recordingDir, `${session.recordingId}-${safeUsername}-${peerId.substring(0, 8)}.mp4`);
        peerRecording.outputPath = outputPath;

        const ffmpegArgs = ['-loglevel', 'warning', '-protocol_whitelist', 'file,udp,rtp,pipe'];

        if (videoConsumer && videoTransport) {
            const videoSdpPath = path.join(recordingDir, `${peerId}-video.sdp`);
            const videoSdp = generateSdpForConsumer(videoConsumer, videoTransport, 'video');
            fs.writeFileSync(videoSdpPath, videoSdp);
            peerRecording.sdpPaths.push(videoSdpPath);
            ffmpegArgs.push('-i', videoSdpPath);
        }

        if (audioConsumer && audioTransport) {
            const audioSdpPath = path.join(recordingDir, `${peerId}-audio.sdp`);
            const audioSdp = generateSdpForConsumer(audioConsumer, audioTransport, 'audio');
            fs.writeFileSync(audioSdpPath, audioSdp);
            peerRecording.sdpPaths.push(audioSdpPath);
            ffmpegArgs.push('-i', audioSdpPath);
        }

        ffmpegArgs.push(
            '-c:v', 'libx264',
            '-preset', 'ultrafast',
            '-tune', 'zerolatency',
            '-c:a', 'aac',
            '-ar', '48000',
            '-ac', '2',
            '-f', 'mp4',
            '-movflags', '+frag_keyframe+empty_moov+default_base_moof',
            '-y',
            outputPath
        );

        logger.info(`[Recording] Starting FFmpeg for ${peerId}: ffmpeg ${ffmpegArgs.join(' ')}`);

        const ffmpeg = spawn('ffmpeg', ffmpegArgs);
        peerRecording.ffmpegProcess = ffmpeg;
        session.ffmpegProcesses.set(peerId, ffmpeg);

        ffmpeg.stderr.on('data', (data) => {
            const msg = data.toString();
            if (msg.includes('error') || msg.includes('Error')) {
                logger.error(`[Recording] FFmpeg error for ${peerId}: ${msg}`);
            }
        });

        ffmpeg.on('error', (err) => {
            logger.error(`[Recording] FFmpeg spawn error for ${peerId}: ${err.message}`);
        });

        ffmpeg.on('close', (code) => {
            logger.info(`[Recording] FFmpeg closed for ${peerId} with code ${code}`);
        });

        session.peerRecordings.set(peerId, peerRecording);
        logger.info(`[Recording] Started recording for peer ${peerId} (${peer.username})`);

    } catch (error) {
        logger.error(`[Recording] Failed to start recording for peer ${peerId}: ${error.message}`);
    }
}

async function stopRecording(roomId) {
    const session = recordingSessions.get(roomId);
    if (!session) {
        throw new Error('No recording in progress for this room');
    }

    logger.info(`[Recording] Stopping recording for room ${roomId}`);

    for (const [peerId, ffmpeg] of session.ffmpegProcesses.entries()) {
        if (ffmpeg && !ffmpeg.killed) {
            ffmpeg.stdin.write('q');
            await new Promise(resolve => setTimeout(resolve, 500));
            if (!ffmpeg.killed) {
                ffmpeg.kill('SIGTERM');
            }
        }
    }

    await new Promise(resolve => setTimeout(resolve, 2000));

    for (const consumer of session.consumers.values()) {
        try {
            consumer.close();
        } catch (e) {}
    }

    for (const transport of session.transports.values()) {
        try {
            transport.close();
        } catch (e) {}
    }

    const files = [];
    for (const [peerId, peerRecording] of session.peerRecordings.entries()) {
        if (peerRecording.outputPath && fs.existsSync(peerRecording.outputPath)) {
            try {
                const stats = fs.statSync(peerRecording.outputPath);
                let s3Url = null;
                
                if (process.env.S3_BUCKET_NAME && stats.size > 0) {
                    const dateStr = new Date().toISOString().split('T')[0];
                    const s3Key = `recordings/${roomId}/${dateStr}/${path.basename(peerRecording.outputPath)}`;
                    s3Url = await uploadFileToS3(peerRecording.outputPath, s3Key);
                }

                files.push({
                    peerId,
                    username: peerRecording.username,
                    file: path.basename(peerRecording.outputPath),
                    size: stats.size,
                    s3Url
                });
            } catch (err) {
                logger.error(`[Recording] Error processing file for ${peerId}: ${err.message}`);
            }
        }

        for (const sdpPath of peerRecording.sdpPaths || []) {
            try {
                if (fs.existsSync(sdpPath)) fs.unlinkSync(sdpPath);
            } catch (e) {}
        }
    }

    const metadataPath = path.join(session.recordingDir, `${session.recordingId}-metadata.json`);
    const metadata = {
        recordingId: session.recordingId,
        roomId,
        startedAt: session.startedAt,
        endedAt: new Date().toISOString(),
        startedBy: session.startedBy,
        files,
        transcripts: session.transcripts || []
    };
    
    fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));

    if (process.env.S3_BUCKET_NAME) {
        const dateStr = new Date().toISOString().split('T')[0];
        const s3Key = `recordings/${roomId}/${dateStr}/${session.recordingId}-metadata.json`;
        await uploadFileToS3(metadataPath, s3Key);
    }

    await saveRoomDetails({
        roomId,
        lastRecording: metadata,
        type: 'RECORDING_COMPLETED'
    });

    recordingSessions.delete(roomId);

    logger.info(`[Recording] Completed for room ${roomId}. Files: ${files.length}`);

    return {
        recordingId: session.recordingId,
        files,
        metadata,
        completedAt: new Date().toISOString()
    };
}

async function addProducerToRecording(roomId, peerId, producer, router) {
    const session = recordingSessions.get(roomId);
    if (!session) return;

    let peerRecording = session.peerRecordings.get(peerId);
    if (!peerRecording) {
        peerRecording = {
            peerId,
            username: 'Unknown',
            audioTransport: null,
            videoTransport: null,
            audioConsumer: null,
            videoConsumer: null,
            ffmpegProcess: null,
            outputPath: null,
            sdpPaths: []
        };
        session.peerRecordings.set(peerId, peerRecording);
    }

    try {
        const transport = await createPlainTransport(router);
        const consumer = await createRecordingConsumer(router, transport, producer);
        
        const port = transport.tuple.localPort;
        
        await transport.connect({
            ip: '127.0.0.1',
            port
        });

        if (producer.kind === 'audio') {
            peerRecording.audioTransport = transport;
            peerRecording.audioConsumer = consumer;
        } else {
            peerRecording.videoTransport = transport;
            peerRecording.videoConsumer = consumer;
        }

        session.transports.set(transport.id, transport);
        session.consumers.set(consumer.id, consumer);

        logger.info(`[Recording] Added ${producer.kind} producer for ${peerId} to recording`);
    } catch (error) {
        logger.error(`[Recording] Failed to add producer to recording: ${error.message}`);
    }
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
    startRecordingForPeer,
    addProducerToRecording,
    addTranscript,
    recordingSessions
};
