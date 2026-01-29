const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const logger = require('../utils/logger');
const config = require('../config');
const { saveRoomDetails, uploadFileToS3 } = require('./aws.service');

const recordingSessions = new Map();

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

async function createPlainTransport(router, remoteRtpPort) {
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
    
    logger.info(`[Recording] Created consumer for ${producer.kind} producer ${producer.id}, port ${transport.tuple.localPort}`);
    return consumer;
}

function createGStreamerPipeline(audioInfo, videoInfo, outputPath) {
    let pipeline = '';
    
    if (videoInfo) {
        const videoCodec = videoInfo.codecInfo.mimeType.split('/')[1].toLowerCase();
        pipeline += `udpsrc port=${videoInfo.port} caps="application/x-rtp,media=video,clock-rate=${videoInfo.codecInfo.clockRate},payload=${videoInfo.codecInfo.payloadType},encoding-name=${videoCodec.toUpperCase()}" ! `;
        
        if (videoCodec === 'vp8') {
            pipeline += 'rtpvp8depay ! vp8dec ! videoconvert ! x264enc tune=zerolatency speed-preset=ultrafast ! video/x-h264,profile=baseline ! ';
        } else if (videoCodec === 'vp9') {
            pipeline += 'rtpvp9depay ! vp9dec ! videoconvert ! x264enc tune=zerolatency speed-preset=ultrafast ! video/x-h264,profile=baseline ! ';
        } else if (videoCodec === 'h264') {
            pipeline += 'rtph264depay ! h264parse ! ';
        }
        
        pipeline += 'queue name=videoqueue ! mux. ';
    }
    
    if (audioInfo) {
        const audioCodec = audioInfo.codecInfo.mimeType.split('/')[1].toLowerCase();
        pipeline += `udpsrc port=${audioInfo.port} caps="application/x-rtp,media=audio,clock-rate=${audioInfo.codecInfo.clockRate},payload=${audioInfo.codecInfo.payloadType},encoding-name=${audioCodec.toUpperCase()}" ! `;
        
        if (audioCodec === 'opus') {
            pipeline += 'rtpopusdepay ! opusdec ! audioconvert ! audioresample ! avenc_aac ! ';
        } else if (audioCodec === 'pcma' || audioCodec === 'pcmu') {
            pipeline += `rtp${audioCodec}depay ! ${audioCodec}dec ! audioconvert ! audioresample ! avenc_aac ! `;
        }
        
        pipeline += 'queue name=audioqueue ! mux. ';
    }
    
    pipeline += `mp4mux name=mux faststart=true ! filesink location="${outputPath}"`;
    
    return pipeline;
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
    const outputPath = path.join(dir, `${recordingId}.webm`);

    const session = {
        recordingId,
        roomId,
        outputPath,
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

        for (const [producerId, producer] of peer.producers.entries()) {
            const transport = await createPlainTransport(router);
            const consumer = await createRecordingConsumer(router, transport, producer);
            
            const codecInfo = getCodecInfo(consumer.rtpParameters);
            const port = transport.tuple.localPort;

            session.transports.set(transport.id, transport);
            session.consumers.set(consumer.id, consumer);

            if (producer.kind === 'audio') {
                peerRecording.audioTransport = transport;
                peerRecording.audioConsumer = consumer;
                audioInfo = { port, codecInfo, consumer, transport };
            } else if (producer.kind === 'video') {
                peerRecording.videoTransport = transport;
                peerRecording.videoConsumer = consumer;
                videoInfo = { port, codecInfo, consumer, transport };
            }
        }

        if (!audioInfo && !videoInfo) {
            logger.warn(`[Recording] No producers found for peer ${peerId}`);
            return;
        }

        const safeUsername = (peer.username || 'unknown').replace(/[^a-zA-Z0-9]/g, '_');
        const outputPath = path.join(recordingDir, `${session.recordingId}-${safeUsername}-${peerId.substring(0, 8)}.webm`);
        peerRecording.outputPath = outputPath;

        let gstArgs;
        
        if (videoInfo && audioInfo) {
            gstArgs = [
                'udpsrc', `port=${videoInfo.port}`,
                `caps=application/x-rtp,media=video,clock-rate=${videoInfo.codecInfo.clockRate},payload=${videoInfo.codecInfo.payloadType}`,
                '!', 'rtpvp8depay', '!', 'webmmux', 'name=mux',
                '!', 'filesink', `location=${outputPath}`,
                'udpsrc', `port=${audioInfo.port}`,
                `caps=application/x-rtp,media=audio,clock-rate=${audioInfo.codecInfo.clockRate},payload=${audioInfo.codecInfo.payloadType}`,
                '!', 'rtpopusdepay', '!', 'mux.'
            ];
        } else if (videoInfo) {
            gstArgs = [
                'udpsrc', `port=${videoInfo.port}`,
                `caps=application/x-rtp,media=video,clock-rate=${videoInfo.codecInfo.clockRate},payload=${videoInfo.codecInfo.payloadType}`,
                '!', 'rtpvp8depay', '!', 'webmmux',
                '!', 'filesink', `location=${outputPath}`
            ];
        } else if (audioInfo) {
            const audioOutputPath = outputPath.replace('.webm', '.ogg');
            peerRecording.outputPath = audioOutputPath;
            gstArgs = [
                'udpsrc', `port=${audioInfo.port}`,
                `caps=application/x-rtp,media=audio,clock-rate=${audioInfo.codecInfo.clockRate},payload=${audioInfo.codecInfo.payloadType}`,
                '!', 'rtpopusdepay', '!', 'oggmux',
                '!', 'filesink', `location=${audioOutputPath}`
            ];
        }

        logger.info(`[Recording] Starting GStreamer for ${peerId}: gst-launch-1.0 ${gstArgs.join(' ')}`);

        const gstProcess = spawn('gst-launch-1.0', gstArgs);
        peerRecording.process = gstProcess;
        session.processes.set(peerId, gstProcess);

        gstProcess.stdout.on('data', (data) => {
            logger.debug(`[Recording] GStreamer stdout for ${peerId}: ${data.toString()}`);
        });

        gstProcess.stderr.on('data', (data) => {
            const msg = data.toString();
            if (msg.includes('ERROR') || msg.includes('error')) {
                logger.error(`[Recording] GStreamer error for ${peerId}: ${msg}`);
            } else {
                logger.debug(`[Recording] GStreamer stderr for ${peerId}: ${msg}`);
            }
        });

        gstProcess.on('error', (err) => {
            logger.error(`[Recording] GStreamer spawn error for ${peerId}: ${err.message}`);
        });

        gstProcess.on('close', (code) => {
            logger.info(`[Recording] GStreamer closed for ${peerId} with code ${code}`);
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

    for (const [peerId, process] of session.processes.entries()) {
        if (process && !process.killed) {
            process.kill('SIGINT');
            await new Promise(resolve => setTimeout(resolve, 500));
            if (!process.killed) {
                process.kill('SIGTERM');
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

    logger.info(`[Recording] Adding new ${producer.kind} producer for ${peerId} during active recording`);
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
