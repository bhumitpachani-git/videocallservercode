const puppeteer = require('puppeteer');
const { PuppeteerScreenRecorder } = require('puppeteer-screen-recorder');
const path = require('path');
const fs = require('fs');

const recordingSessions = new Map();

async function startRecording(roomId, startedBy, io, rooms) {
    console.log(`[Recording] Starting professional recording for room: ${roomId}`);
    
    const dir = path.join(__dirname, 'recordings', roomId);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const recordingId = `${roomId}-${Date.now()}`;
    const outputPath = path.join(dir, `${recordingId}.mp4`);
    
    // Professional Recording Config
    const Config = {
        followNewTab: true,
        fps: 30,
        ffmpeg_Path: process.env.FFMPEG_PATH || null, 
        videoFrame: {
            width: 1920,
            height: 1080,
        },
        aspectRatio: '16:9',
        videoBitrate: '8000k', // Enterprise quality bitrate
        audioBitrate: '192k'
    };

    try {
        const browser = await puppeteer.launch({
            headless: true,
            executablePath: process.env.CHROME_PATH || 'chromium',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--use-fake-ui-for-media-stream',
                '--use-fake-device-for-media-stream',
                '--allow-file-access-from-files',
                '--disable-web-security',
                '--autoplay-policy=no-user-gesture-required',
                '--window-size=1920,1080',
                '--force-device-scale-factor=1',
                '--high-dpi-support=1'
            ]
        });

        const page = await browser.newPage();
        await page.setViewport({ width: 1920, height: 1080 });

        // Join room as a silent recorder bot
        const domain = process.env.REPLIT_DEV_DOMAIN || 'localhost:5000';
        const protocol = domain.includes('localhost') ? 'http' : 'https';
        const joinUrl = `${protocol}://${domain}/room/${roomId}?recorder=true`;
        
        await page.goto(joinUrl, { waitUntil: 'networkidle2', timeout: 60000 });
        
        // Ensure UI is clean for recording
        await page.evaluate(() => {
            const style = document.createElement('style');
            style.innerHTML = `
                #recorder-controls, .recording-ignore { display: none !important; }
                body { overflow: hidden !important; }
            `;
            document.head.appendChild(style);
        });

        const recorder = new PuppeteerScreenRecorder(page, Config);
        await recorder.start(outputPath);

        recordingSessions.set(roomId, {
            browser,
            page,
            recorder,
            outputPath,
            recordingId,
            startedAt: new Date().toISOString(),
            startedBy
        });

        return { recordingId, status: 'started' };
    } catch (error) {
        console.error('[Recording] Failed to start:', error);
        throw error;
    }
}

const { saveRoomDetails, uploadFileToS3 } = require('./aws.service');

async function stopRecording(roomId) {
    const session = recordingSessions.get(roomId);
    if (!session) return;

    try {
        await session.recorder.stop();
        await session.browser.close();
        
        const stats = fs.statSync(session.outputPath);
        
        // Upload to S3 if configured
        let s3Url = null;
        if (process.env.S3_BUCKET_NAME) {
            const s3Key = `recordings/${roomId}/${session.recordingId}.mp4`;
            s3Url = await uploadFileToS3(session.outputPath, s3Key);
        }

        const result = {
            recordingId: session.recordingId,
            file: path.basename(session.outputPath),
            size: stats.size,
            path: session.outputPath,
            s3Url
        };

        // Update DynamoDB with recording info
        await saveRoomDetails({
            roomId,
            lastRecordingId: session.recordingId,
            lastRecordingUrl: s3Url,
            lastRecordingSize: stats.size
        });

        recordingSessions.delete(roomId);
        return result;
    } catch (error) {
        console.error('[Recording] Failed to stop:', error);
        throw error;
    }
}

module.exports = {
    startRecording,
    stopRecording,
    recordingSessions
};
