const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const logger = require('../utils/logger');

const recordingSessions = new Map();

async function startRecording(roomId, startedBy, io, rooms) {
    logger.info(`[Recording] Starting FFmpeg audio recording for room: ${roomId}`);
    
    const dir = path.join(__dirname, '..', '..', 'recordings', roomId);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const recordingId = `${roomId}-${Date.now()}`;
    const outputPath = path.join(dir, `${recordingId}.wav`);
    
    try {
        // Use FFmpeg to record a silent audio stream as a placeholder for a robust server-side recording
        const ffmpegProcess = spawn('ffmpeg', [
            '-f', 'lavfi',
            '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
            '-t', '3600', // 1 hour max
            '-y',
            outputPath
        ]);

        ffmpegProcess.on('error', (err) => {
            logger.error(`[Recording] FFmpeg error: ${err.message}`);
        });

        recordingSessions.set(roomId, {
            process: ffmpegProcess,
            outputPath,
            recordingId,
            startedAt: new Date().toISOString(),
            startedBy
        });

        return { recordingId, status: 'started' };
    } catch (error) {
        logger.error('[Recording] Failed to start FFmpeg:', error);
        throw error;
    }
}

const { saveRoomDetails, uploadFileToS3 } = require('./aws.service');

async function stopRecording(roomId) {
    const session = recordingSessions.get(roomId);
    if (!session) return;

    try {
        logger.info(`[Recording] Stopping recording for room ${roomId}`);
        session.process.kill('SIGINT');
        
        // Wait for file to be finalized
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        const stats = fs.statSync(session.outputPath);
        logger.info(`[Recording] File generated: ${session.outputPath} (${stats.size} bytes)`);
        
        let s3Url = null;
        if (process.env.S3_BUCKET_NAME) {
            const dateStr = new Date().toISOString().split('T')[0];
            const timeStr = new Date().getTime();
            const s3Key = `recordings/${roomId}/${dateStr}/${timeStr}.wav`;
            
            s3Url = await uploadFileToS3(session.outputPath, s3Key);
            fs.unlinkSync(session.outputPath);
        }

        const result = {
            recordingId: session.recordingId,
            roomId,
            s3Url,
            size: stats.size,
            completedAt: new Date().toISOString()
        };

        await saveRoomDetails({
            roomId,
            lastRecording: result,
            type: 'RECORDING_COMPLETED'
        });

        recordingSessions.delete(roomId);
        return result;
    } catch (error) {
        logger.error('[Recording] Failed to stop FFmpeg recording:', error);
        throw error;
    }
}

module.exports = {
    startRecording,
    stopRecording,
    recordingSessions
};
