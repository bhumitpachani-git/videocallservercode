const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const recordingSessions = new Map();

/**
 * Start recording for a single peer using FFmpeg
 */
async function startRecordingForPeer(roomId, peerId, peer, session, rooms) {
  try {
    const room = rooms.get(roomId);
    if (!room) {
      console.error(`[Recording] Room not found: ${roomId}`);
      return;
    }

    const audioProducer = [...peer.producers.values()].find(p => p.kind === 'audio');
    const videoProducer = [...peer.producers.values()].find(p => p.kind === 'video');

    if (!audioProducer && !videoProducer) {
      console.warn(`[Recording] Peer ${peer.username} has no producers`);
      return;
    }

    console.log(`[Recording] Starting FFmpeg recording for ${peer.username}...`);

    const safe = peer.username.replace(/[^a-z0-9]/gi, '_');
    const base = path.join(session.outputDir, `${safe}-${session.timestamp}`);
    const outPath = `${base}.mp4`;
    const sdpPath = `${base}.sdp`;

    // Create plain transports
    const transportOpts = {
      listenIp: { ip: '127.0.0.1', announcedIp: null },
      rtcpMux: true,
      comedia: false,
      enableSrtp: false,
      enableSctp: false
    };

    const transports = {};
    const consumers = {};
    let videoPort, audioPort;
    let videoCodec, audioCodec;

    // VIDEO TRANSPORT
    if (videoProducer) {
      try {
        transports.video = await room.router.createPlainTransport(transportOpts);
        videoPort = transports.video.tuple.localPort;
        
        console.log(`[Recording] Video: MediaSoup → 127.0.0.1:${videoPort}`);
        
        await transports.video.connect({
          ip: '127.0.0.1',
          port: videoPort
        });
        
        consumers.video = await transports.video.consume({
          producerId: videoProducer.id,
          rtpCapabilities: room.router.rtpCapabilities,
          paused: false
        });
        
        // Get codec info
        videoCodec = consumers.video.rtpParameters.codecs[0];
        console.log(`[Recording] Video codec: ${videoCodec.mimeType}, PT: ${videoCodec.payloadType}`);
        
      } catch (err) {
        console.error(`[Recording] Video setup error:`, err.message);
      }
    }

    // AUDIO TRANSPORT
    if (audioProducer) {
      try {
        transports.audio = await room.router.createPlainTransport(transportOpts);
        audioPort = transports.audio.tuple.localPort;
        
        console.log(`[Recording] Audio: MediaSoup → 127.0.0.1:${audioPort}`);
        
        await transports.audio.connect({
          ip: '127.0.0.1',
          port: audioPort
        });
        
        consumers.audio = await transports.audio.consume({
          producerId: audioProducer.id,
          rtpCapabilities: room.router.rtpCapabilities,
          paused: false
        });
        
        // Get codec info
        audioCodec = consumers.audio.rtpParameters.codecs[0];
        console.log(`[Recording] Audio codec: ${audioCodec.mimeType}, PT: ${audioCodec.payloadType}`);
        
      } catch (err) {
        console.error(`[Recording] Audio setup error:`, err.message);
      }
    }

    if (!videoPort && !audioPort) {
      console.error(`[Recording] No valid ports for ${peer.username}`);
      return;
    }

    // Create SDP file for FFmpeg
    const sdp = createSdpFile({
      video: videoPort ? {
        port: videoPort,
        codec: videoCodec?.mimeType?.split('/')[1] || 'VP8',
        payloadType: videoCodec?.payloadType || 96,
        clockRate: videoCodec?.clockRate || 90000
      } : null,
      audio: audioPort ? {
        port: audioPort,
        codec: audioCodec?.mimeType?.split('/')[1] || 'opus',
        payloadType: audioCodec?.payloadType || 111,
        clockRate: audioCodec?.clockRate || 48000,
        channels: audioCodec?.channels || 2
      } : null
    });
    
    fs.writeFileSync(sdpPath, sdp);
    console.log(`[Recording] SDP file created: ${sdpPath}`);

    // Build FFmpeg command
    const ffmpegArgs = [
      '-protocol_whitelist', 'file,rtp,udp',
      '-i', sdpPath,
      '-map', '0:v?',
      '-map', '0:a?',
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-tune', 'zerolatency',
      '-b:v', '800k',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-movflags', '+faststart',
      '-y',
      outPath
    ];

    console.log(`[FFmpeg] Command: ffmpeg ${ffmpegArgs.join(' ')}`);

    // Launch FFmpeg
    const ffmpeg = spawn('ffmpeg', ffmpegArgs, {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdoutBuffer = '';
    let stderrBuffer = '';
    let hasReceivedData = false;

    ffmpeg.stdout?.on('data', (data) => {
      stdoutBuffer += data.toString();
    });

    ffmpeg.stderr?.on('data', (data) => {
      const text = data.toString();
      stderrBuffer += text;
      
      // Log important messages
      if (text.includes('frame=') || text.includes('time=')) {
        if (!hasReceivedData) {
          console.log(`[FFmpeg ${peer.username}] ✓ Receiving data...`);
          hasReceivedData = true;
        }
      } else if (text.includes('error') || text.includes('Error')) {
        console.error(`[FFmpeg ${peer.username}] ERROR: ${text.trim()}`);
      }
    });

    ffmpeg.on('error', (err) => {
      console.error(`[Recording] FFmpeg spawn error for ${peer.username}:`, err.message);
    });

    ffmpeg.on('exit', (code, signal) => {
      console.log(`[Recording] FFmpeg exited for ${peer.username}: code=${code}, signal=${signal}`);
      
      if (fs.existsSync(outPath)) {
        const stats = fs.statSync(outPath);
        console.log(`[Recording] Output: ${outPath} (${stats.size} bytes)`);
      } else {
        console.error(`[Recording] Output file NOT created: ${outPath}`);
      }
      
      // Clean up SDP
      if (fs.existsSync(sdpPath)) {
        fs.unlinkSync(sdpPath);
      }
    });

    session.participants.set(peerId, {
      ffmpeg,
      transports,
      consumers,
      outputFile: outPath,
      sdpPath,
      username: peer.username,
      videoPort,
      audioPort,
      started: Date.now()
    });

    console.log(`[Recording] ✓ STARTED → ${peer.username}`);
    
  } catch (err) {
    console.error(`[Recording] Fatal error for ${peer.username}:`, err);
    throw err;
  }
}

/**
 * Create SDP file for FFmpeg
 */
function createSdpFile({ video, audio }) {
  const now = Math.floor(Date.now() / 1000);
  let sdp = `v=0
o=- ${now} ${now} IN IP4 127.0.0.1
s=MediaSoup Recording
c=IN IP4 127.0.0.1
t=0 0\n`;

  if (video) {
    sdp += `m=video ${video.port} RTP/AVP ${video.payloadType}
c=IN IP4 127.0.0.1
a=rtpmap:${video.payloadType} ${video.codec}/${video.clockRate}
a=recvonly
a=rtcp-mux\n`;
  }

  if (audio) {
    sdp += `m=audio ${audio.port} RTP/AVP ${audio.payloadType}
c=IN IP4 127.0.0.1
a=rtpmap:${audio.payloadType} ${audio.codec}/${audio.clockRate}/${audio.channels}
a=recvonly
a=rtcp-mux\n`;
  }

  return sdp;
}

/**
 * Start recording for entire room
 */
async function startRecording(roomId, startedBy, io, rooms) {
  console.log(`\n[Recording] ========== START RECORDING ==========`);
  console.log(`[Recording] Room: ${roomId}, Started by: ${startedBy}`);
  
  const room = rooms.get(roomId);
  if (!room) {
    throw new Error(`Room not found: ${roomId}`);
  }

  const dir = path.join(__dirname, 'recordings', roomId);
  fs.mkdirSync(dir, { recursive: true });
  console.log(`[Recording] Output directory: ${dir}`);

  const session = {
    recordingId: `${roomId}-${Date.now()}`,
    outputDir: dir,
    timestamp: Date.now(),
    participants: new Map(),
    transcripts: [],
    startedBy: startedBy,
    startedAt: new Date().toISOString()
  };

  recordingSessions.set(roomId, session);

  const peers = Array.from(room.peers.entries());
  console.log(`[Recording] Found ${peers.length} peers to record`);

  // Start recording for each peer
  for (const [peerId, peer] of peers) {
    try {
      await startRecordingForPeer(roomId, peerId, peer, session, rooms);
      // Small delay between starting recordings
      await new Promise(resolve => setTimeout(resolve, 500));
    } catch (err) {
      console.error(`[Recording] Error starting for ${peer.username}:`, err.message);
    }
  }

  console.log(`[Recording] ========== INITIALIZED ==========\n`);
  return session;
}

/**
 * Stop recording for entire room
 */
async function stopRecording(roomId) {
  console.log(`\n[Recording] ========== STOP RECORDING ==========`);
  console.log(`[Recording] Room: ${roomId}`);
  
  const session = recordingSessions.get(roomId);
  if (!session) {
    throw new Error(`No active recording session for room: ${roomId}`);
  }

  const files = [];
  const participants = Array.from(session.participants.entries());
  console.log(`[Recording] Stopping ${participants.length} recordings...`);

  for (const [peerId, p] of participants) {
    try {
      console.log(`[Recording] Stopping ${p.username}...`);
      
      // Send 'q' to FFmpeg for graceful shutdown
      if (p.ffmpeg && !p.ffmpeg.killed) {
        try {
          p.ffmpeg.stdin?.write('q');
          p.ffmpeg.stdin?.end();
        } catch (err) {
          // Stdin might be closed
        }
        
        // Wait for graceful shutdown
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        if (!p.ffmpeg.killed) {
          p.ffmpeg.kill('SIGTERM');
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
        
        if (!p.ffmpeg.killed) {
          p.ffmpeg.kill('SIGKILL');
        }
      }

      // Close consumers
      if (p.consumers) {
        Object.values(p.consumers).forEach(consumer => {
          try {
            consumer.close();
          } catch (err) {}
        });
      }

      // Close transports
      if (p.transports) {
        Object.values(p.transports).forEach(transport => {
          try {
            transport.close();
          } catch (err) {}
        });
      }

      // Wait for file to be fully written
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Check output file
      if (fs.existsSync(p.outputFile)) {
        const stats = fs.statSync(p.outputFile);
        if (stats.size > 100) { // At least 100 bytes
          files.push({
            username: p.username,
            file: path.basename(p.outputFile),
            size: stats.size,
            path: p.outputFile,
            duration: Math.floor((Date.now() - p.started) / 1000)
          });
          console.log(`[Recording] ✓ ${p.username}: ${stats.size} bytes`);
        } else {
          console.warn(`[Recording] ⚠ ${p.username}: file too small (${stats.size} bytes)`);
        }
      } else {
        console.error(`[Recording] ✗ ${p.username}: file not found`);
      }

      // Clean up SDP
      if (p.sdpPath && fs.existsSync(p.sdpPath)) {
        fs.unlinkSync(p.sdpPath);
      }

    } catch (err) {
      console.error(`[Recording] Error stopping ${p.username}:`, err.message);
    }
  }

  // Save metadata
  const metadata = {
    recordingId: session.recordingId,
    roomId: roomId,
    startedBy: session.startedBy,
    startedAt: session.startedAt,
    endedAt: new Date().toISOString(),
    participants: files.map(f => f.username),
    transcripts: session.transcripts || [],
    files: files
  };

  const metadataPath = path.join(session.outputDir, `${session.recordingId}-metadata.json`);
  fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
  console.log(`[Recording] Metadata: ${metadataPath}`);

  recordingSessions.delete(roomId);
  console.log(`[Recording] ========== COMPLETED ==========\n`);

  return {
    recordingId: session.recordingId,
    files: files
  };
}

module.exports = {
  recordingSessions,
  startRecording,
  stopRecording,
  startRecordingForPeer
};