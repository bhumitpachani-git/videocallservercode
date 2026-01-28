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
        ffmpeg_Path: null, // Uses system ffmpeg
        videoFrame: {
            width: 1920,
            height: 1080,
        },
        aspectRatio: '16:9',
    };

    try {
        const browser = await puppeteer.launch({
            headless: "new",
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--use-fake-ui-for-media-stream',
                '--use-fake-device-for-media-stream',
                '--allow-file-access-from-files',
                '--disable-web-security'
            ]
        });

        const page = await browser.newPage();
        await page.setViewport({ width: 1920, height: 1080 });

        // Join room as a silent recorder bot
        const domain = process.env.REPLIT_DEV_DOMAIN || 'localhost:5000';
        const protocol = domain.includes('localhost') ? 'http' : 'https';
        const joinUrl = `${protocol}://${domain}/room/${roomId}?recorder=true`;
        
        await page.goto(joinUrl, { waitUntil: 'networkidle2' });

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

async function stopRecording(roomId) {
    const session = recordingSessions.get(roomId);
    if (!session) return;

    try {
        await session.recorder.stop();
        await session.browser.close();
        
        const stats = fs.statSync(session.outputPath);
        const result = {
            recordingId: session.recordingId,
            file: path.basename(session.outputPath),
            size: stats.size,
            path: session.outputPath
        };

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
