require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const mediasoup = require('mediasoup');
const cors = require('cors');

const config = require('./config');
const logger = require('./utils/logger');
const roomManager = require('./services/room.service');
const roomRoutes = require('./routes/room.routes');
const socketHandler = require('./services/socket.handler');

const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();
app.set('trust proxy', 1);
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100 });
app.use(limiter);

app.use('/api/rooms', roomRoutes);
app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

const server = http.createServer(app);
const io = socketIO(server, { 
  cors: { origin: '*' }, 
  pingTimeout: 60000, 
  pingInterval: 25000 
});

socketHandler(io, roomManager);

async function bootstrap() {
  try {
    const worker = await mediasoup.createWorker({
      logLevel: config.mediasoup?.logLevel || 'warn',
      rtcMinPort: parseInt(process.env.RTC_MIN_PORT) || 10000,
      rtcMaxPort: parseInt(process.env.RTC_MAX_PORT) || 10100,
    });

    await roomManager.initialize(worker);

    server.listen(config.PORT, '0.0.0.0', () => {
      logger.info(`🚀 Powerful Backend running on port ${config.PORT}`);
    });
  } catch (error) {
    logger.error(`Bootstrap failed: ${error.message}`);
    process.exit(1);
  }
}

bootstrap();
