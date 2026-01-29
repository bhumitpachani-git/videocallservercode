const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const logger = require('../utils/logger');
const config = require('../config');
const { saveRoomDetails, uploadFileToS3 } = require('./aws.service');

const recordingSessions = new Map();

async function createPlainTransport(router) {
    const transport = await router.createPlainTransport({
        listenIp: { ip: '127.0.0.1', announcedIp: null },
        rtcpMux: false,
        comedia: true
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

function getFFmpegArgs(audioPort, audioRtcpPort, videoPort, videoRtcpPort, outputPath) {
    const args = [
        '-loglevel', 'warning',
        '-protocol_whitelist', 'file,udp,rtp',
        '-fflags', '+genpts',
    ];

    if (videoPort) {
        args.push(
            '-i', `rtp://127.0.0.1:${videoPort}?rtcpport=${videoRtcpPort}`
        );
    }

    if (audioPort) {
        args.push(
            '-i', `rtp://127.0.0.1:${audioPort}?rtcpport=${audioRtcpPort}`
        );
    }

    args.push(
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-tune', 'zerolatency',
        '-c:a', 'aac',
        '-strict', 'experimental',
        '-f', 'mp4',
        '-movflags', '+frag_keyframe+empty_moov+default_base_moof',
        '-y',
        outputPath
    );

    return args;
}

async function startRecording(roomId, startedBy, io, rooms) {
    logger.info(`[Recording] Starting professional recording for room: ${roomId}`);
    
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
        transcripts: []
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
            username: peer.username,
            audioTransport: null,
            videoTransport: null,
            audioConsumer: null,
            videoConsumer: null,
            ffmpegProcess: null,
            outputPath: null
        };

        let audioPort, audioRtcpPort, videoPort, videoRtcpPort;

        for (const [producerId, producer] of peer.producers.entries()) {
            const transport = await createPlainTransport(router);
            const consumer = await createRecordingConsumer(router, transport, producer);

            if (producer.kind === 'audio') {
                peerRecording.audioTransport = transport;
                peerRecording.audioConsumer = consumer;
                audioPort = transport.tuple.localPort;
                audioRtcpPort = transport.rtcpTuple?.localPort || audioPort + 1;
                
                await transport.connect({
                    ip: '127.0.0.1',
                    port: audioPort,
                    rtcpPort: audioRtcpPort
                });
            } else if (producer.kind === 'video') {
                peerRecording.videoTransport = transport;
                peerRecording.videoConsumer = consumer;
                videoPort = transport.tuple.localPort;
                videoRtcpPort = transport.rtcpTuple?.localPort || videoPort + 1;
                
                await transport.connect({
                    ip: '127.0.0.1',
                    port: videoPort,
                    rtcpPort: videoRtcpPort
                });
            }

            session.transports.set(transport.id, transport);
            session.consumers.set(consumer.id, consumer);
        }

        if (audioPort || videoPort) {
            const peerOutputPath = path.join(recordingDir, `${session.recordingId}-${peer.username || peerId}.mp4`);
            peerRecording.outputPath = peerOutputPath;

            const sdpContent = generateSdpForRecording(audioPort, audioRtcpPort, videoPort, videoRtcpPort);
            const sdpPath = path.join(recordingDir, `${session.recordingId}-${peerId}.sdp`);
            fs.writeFileSync(sdpPath, sdpContent);

            const ffmpegArgs = [
                '-loglevel', 'warning',
                '-protocol_whitelist', 'file,udp,rtp',
                '-fflags', '+genpts',
                '-i', sdpPath,
                '-c:v', 'libx264',
                '-preset', 'ultrafast',
                '-tune', 'zerolatency',
                '-c:a', 'aac',
                '-strict', 'experimental',
                '-f', 'mp4',
                '-movflags', '+frag_keyframe+empty_moov+default_base_moof',
                '-y',
                peerOutputPath
            ];

            const ffmpegProcess = spawn('ffmpeg', ffmpegArgs);
            
            ffmpegProcess.stderr.on('data', (data) => {
                logger.debug(`[Recording] FFmpeg ${peerId}: ${data.toString()}`);
            });

            ffmpegProcess.on('error', (err) => {
                logger.error(`[Recording] FFmpeg error for ${peerId}: ${err.message}`);
            });

            ffmpegProcess.on('close', (code) => {
                logger.info(`[Recording] FFmpeg process for ${peerId} closed with code ${code}`);
            });

            peerRecording.ffmpegProcess = ffmpegProcess;
            session.peerRecordings.set(peerId, peerRecording);
            session.ffmpegProcesses.set(peerId, ffmpegProcess);

            logger.info(`[Recording] Started recording for peer ${peer.username} (${peerId})`);
        }
    } catch (error) {
        logger.error(`[Recording] Failed to start recording for peer ${peerId}: ${error.message}`);
    }
}

function generateSdpForRecording(audioPort, audioRtcpPort, videoPort, videoRtcpPort) {
    let sdp = `v=0
o=- 0 0 IN IP4 127.0.0.1
s=Recording Session
c=IN IP4 127.0.0.1
t=0 0
`;

    if (videoPort) {
        sdp += `m=video ${videoPort} RTP/AVP 96
a=rtpmap:96 VP8/90000
a=recvonly
`;
    }

    if (audioPort) {
        sdp += `m=audio ${audioPort} RTP/AVP 111
a=rtpmap:111 opus/48000/2
a=recvonly
`;
    }

    return sdp;
}

async function stopRecording(roomId) {
    const session = recordingSessions.get(roomId);
    if (!session) {
        throw new Error('No active recording for this room');
    }

    logger.info(`[Recording] Stopping recording for room ${roomId}`);

    const files = [];

    for (const [peerId, peerRecording] of session.peerRecordings.entries()) {
        try {
            if (peerRecording.ffmpegProcess) {
                peerRecording.ffmpegProcess.stdin?.write('q');
                peerRecording.ffmpegProcess.kill('SIGINT');
            }

            if (peerRecording.audioConsumer) {
                peerRecording.audioConsumer.close();
            }
            if (peerRecording.videoConsumer) {
                peerRecording.videoConsumer.close();
            }
            if (peerRecording.audioTransport) {
                peerRecording.audioTransport.close();
            }
            if (peerRecording.videoTransport) {
                peerRecording.videoTransport.close();
            }
        } catch (err) {
            logger.error(`[Recording] Error closing resources for ${peerId}: ${err.message}`);
        }
    }

    await new Promise(resolve => setTimeout(resolve, 2000));

    for (const [peerId, peerRecording] of session.peerRecordings.entries()) {
        if (peerRecording.outputPath && fs.existsSync(peerRecording.outputPath)) {
            try {
                const stats = fs.statSync(peerRecording.outputPath);
                
                let s3Url = null;
                if (process.env.S3_BUCKET_NAME && stats.size > 0) {
                    const dateStr = new Date().toISOString().split('T')[0];
                    const s3Key = `recordings/${roomId}/${dateStr}/${path.basename(peerRecording.outputPath)}`;
                    
                    s3Url = await uploadFileToS3(peerRecording.outputPath, s3Key);
                    logger.info(`[Recording] Uploaded to S3: ${s3Url}`);
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
    }

    const metadataPath = path.join(path.dirname(session.outputPath), `${session.recordingId}-metadata.json`);
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
            outputPath: null
        };
        session.peerRecordings.set(peerId, peerRecording);
    }

    try {
        const transport = await createPlainTransport(router);
        const consumer = await createRecordingConsumer(router, transport, producer);
        
        const port = transport.tuple.localPort;
        const rtcpPort = transport.rtcpTuple?.localPort || port + 1;
        
        await transport.connect({
            ip: '127.0.0.1',
            port,
            rtcpPort
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

module.exports = {
    startRecording,
    stopRecording,
    startRecordingForPeer,
    addProducerToRecording,
    recordingSessions
};
