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
        peerRecordings: new Map(),
        transcripts: [],
        recordingDir: dir,
        ffmpegProcess: null,
        ffmpegIn: null
    };

    recordingSessions.set(roomId, session);

    // Setup combined FFmpeg process
    const outputPath = path.join(dir, `${recordingId}-combined.webm`);
    session.outputPath = outputPath;

    const peers = Array.from(room.peers.values()).filter(p => !p.isRecorder);
    const audioPeers = [];
    const videoPeers = [];

    for (const peer of peers) {
        const audioProducer = Array.from(peer.producers.values()).find(p => p.kind === 'audio');
        const videoProducer = Array.from(peer.producers.values()).find(p => p.kind === 'video');

        if (audioProducer) audioPeers.push({ peer, producer: audioProducer });
        if (videoProducer) videoPeers.push({ peer, producer: videoProducer });
    }

    const sdpLines = [
        'v=0',
        'o=- 0 0 IN IP4 127.0.0.1',
        's=Mediasoup Room Recording',
        'c=IN IP4 127.0.0.1',
        't=0 0'
    ];

    const basePort = 30000 + Math.floor(Math.random() * 10000);
    let portOffset = 0;

    const streamMappings = [];

    for (let i = 0; i < audioPeers.length; i++) {
        const port = basePort + portOffset;
        portOffset += 2;
        audioPeers[i].ffmpegPort = port;
        sdpLines.push(
            `m=audio ${port} RTP/AVP 111`,
            `a=rtpmap:111 opus/48000/2`,
            'a=recvonly'
        );
        streamMappings.push({ type: 'audio', index: i, peerId: audioPeers[i].peer.id });
    }

    for (let i = 0; i < videoPeers.length; i++) {
        const port = basePort + portOffset;
        portOffset += 2;
        videoPeers[i].ffmpegPort = port;
        sdpLines.push(
            `m=video ${port} RTP/AVP 96`,
            `a=rtpmap:96 VP8/90000`,
            'a=recvonly'
        );
        streamMappings.push({ type: 'video', index: i, peerId: videoPeers[i].peer.id });
    }

    const sdp = sdpLines.join('\n') + '\n';

    let ffmpegArgs = [
        '-y',
        '-loglevel', 'warning',
        '-protocol_whitelist', 'pipe,udp,rtp,file,crypto',
        '-thread_queue_size', '1024',
        '-f', 'sdp',
        '-i', 'pipe:0'
    ];

    // Build filter_complex for layout
    let filterComplex = '';
    const videoCount = videoPeers.length;
    const audioCount = audioPeers.length;

    if (videoCount > 0) {
        // Simple grid for video
        const cols = Math.ceil(Math.sqrt(videoCount));
        const rows = Math.ceil(videoCount / cols);
        const width = 1280;
        const height = 720;
        const cellW = Math.floor(width / cols);
        const cellH = Math.floor(height / rows);

        for (let i = 0; i < videoCount; i++) {
            filterComplex += `[0:v:${i}]scale=${cellW}:${cellH}:force_original_aspect_ratio=decrease,pad=${cellW}:${cellH}:(ow-iw)/2:(oh-ih)/2[v${i}];`;
        }

        let xStack = '';
        for (let r = 0; r < rows; r++) {
            let rowInputs = '';
            let rowCols = 0;
            for (let c = 0; c < cols; c++) {
                const idx = r * cols + c;
                if (idx < videoCount) {
                    rowInputs += `[v${idx}]`;
                    rowCols++;
                } else {
                    // Placeholder for empty cells
                    filterComplex += `color=s=${cellW}x${cellH}:c=black[vblack${idx}];`;
                    rowInputs += `[vblack${idx}]`;
                    rowCols++;
                }
            }
            if (rowCols > 1) {
                filterComplex += `${rowInputs}hstack=inputs=${rowCols}[row${r}];`;
                xStack += `[row${r}]`;
            } else {
                filterComplex += `${rowInputs}null[row${r}];`;
                xStack += `[row${r}]`;
            }
        }
        if (rows > 1) {
            filterComplex += `${xStack}vstack=inputs=${rows}[vfinal]`;
        } else {
            filterComplex += `${xStack}null[vfinal]`;
        }
    }

    if (audioCount > 0) {
        if (filterComplex) filterComplex += ';';
        let audioInputs = '';
        for (let i = 0; i < audioCount; i++) {
            audioInputs += `[0:a:${i}]`;
        }
        if (audioCount > 1) {
            filterComplex += `${audioInputs}amix=inputs=${audioCount}[afinal]`;
        } else {
            filterComplex += `${audioInputs}anull[afinal]`;
        }
    }

    if (filterComplex) {
        ffmpegArgs.push('-filter_complex', filterComplex);
        if (videoCount > 0) ffmpegArgs.push('-map', '[vfinal]');
        if (audioCount > 0) ffmpegArgs.push('-map', '[afinal]');
    }

    ffmpegArgs.push(
        '-c:v', 'libvpx', 
        '-deadline', 'realtime',
        '-cpu-used', '8',
        '-b:v', '1M',
        '-c:a', 'libopus', 
        '-b:a', '128k',
        '-f', 'webm', 
        outputPath
    );

    logger.info(`[Recording] FFmpeg combined command: ffmpeg ${ffmpegArgs.join(' ')}`);

    const ffmpegProcess = spawn('ffmpeg', ffmpegArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
    session.ffmpegProcess = ffmpegProcess;
    session.ffmpegIn = ffmpegProcess.stdin;

    ffmpegProcess.on('error', (err) => {
        logger.error(`[Recording] FFmpeg process error for room ${roomId}: ${err.message}`);
        stopRecording(roomId).catch(() => {});
    });

    ffmpegProcess.on('exit', (code, signal) => {
        if (code !== 0 && code !== null) {
            logger.error(`[Recording] FFmpeg exited unexpectedly for room ${roomId} with code ${code}`);
        }
    });

    ffmpegProcess.stderr.on('data', (data) => {
        logger.info(`[FFmpeg Room] ${data.toString().trim()}`);
    });

    ffmpegProcess.stdin.write(sdp);
    ffmpegProcess.stdin.end();

    // Connect transports
    for (const item of audioPeers) {
        const transport = await createPlainTransport(room.router, false);
        const consumer = await createRecordingConsumer(room.router, transport, item.producer);
        
        session.transports.set(transport.id, transport);
        session.consumers.set(consumer.id, consumer);

        await transport.connect({ ip: '127.0.0.1', port: item.ffmpegPort });
        await consumer.resume();
        logger.info(`[Recording] Audio peer ${item.peer.id} connected to combined recorder on port ${item.ffmpegPort}`);
    }

    for (const item of videoPeers) {
        const transport = await createPlainTransport(room.router, true);
        const consumer = await createRecordingConsumer(room.router, transport, item.producer);
        
        session.transports.set(transport.id, transport);
        session.consumers.set(consumer.id, consumer);

        await transport.connect({ ip: '127.0.0.1', port: item.ffmpegPort });
        await consumer.resume();
        logger.info(`[Recording] Video peer ${item.peer.id} connected to combined recorder on port ${item.ffmpegPort}`);
    }

    logger.info(`[Recording] Started combined recording for room ${roomId}, recording ID: ${recordingId}`);
    return session;
}

async function stopRecording(roomId) {
    const session = recordingSessions.get(roomId);
    if (!session) {
        throw new Error('No recording in progress for this room');
    }

    logger.info(`[Recording] ==================== Stopping recording for room ${roomId} ====================`);

    // Pause consumers
    for (const consumer of session.consumers.values()) {
        try { if (!consumer.closed && !consumer.paused) await consumer.pause(); } catch {}
    }

    await new Promise(r => setTimeout(r, 2000));

    // Stop FFmpeg
    if (session.ffmpegProcess && !session.ffmpegProcess.killed) {
        try {
            session.ffmpegProcess.stdin.write('q\n');
            session.ffmpegProcess.stdin.end();
        } catch {}
        await new Promise(r => setTimeout(r, 3000));
        if (!session.ffmpegProcess.killed) session.ffmpegProcess.kill('SIGTERM');
    }

    await new Promise(r => setTimeout(r, 2000));

    // Close mediasoup objects
    for (const consumer of session.consumers.values()) {
        try { if (!consumer.closed) consumer.close(); } catch {}
    }
    for (const transport of session.transports.values()) {
        try { if (!transport.closed) transport.close(); } catch {}
    }

    const files = [];
    if (fs.existsSync(session.outputPath)) {
        const stats = fs.statSync(session.outputPath);
        logger.info(`Combined file for ${roomId}: ${path.basename(session.outputPath)} - ${stats.size} bytes`);

        let s3Url = null;
        if (stats.size > 0 && process.env.S3_BUCKET_NAME) {
            const dateStr = new Date().toISOString().split('T')[0];
            const s3Key = `recordings/${roomId}/${dateStr}/${path.basename(session.outputPath)}`;
            s3Url = await uploadFileToS3(session.outputPath, s3Key).catch(e => logger.error(e));
            if (s3Url) fs.unlinkSync(session.outputPath);
        }

        files.push({
            peerId: 'combined',
            username: 'Room Recording',
            file: path.basename(session.outputPath),
            size: stats.size,
            s3Url
        });
    }

    // Metadata saving
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

    recordingSessions.delete(roomId);

    logger.info(`[Recording] Completed. Combined file processed.`);
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