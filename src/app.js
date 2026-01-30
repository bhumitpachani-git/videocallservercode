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
const compression = require('compression');

const app = express();
app.set('trust proxy', 1);
app.use(compression()); // Compress responses for faster signaling
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
  pingTimeout: 10000,
  pingInterval: 2000,
  transports: ['websocket'],
  allowEIO3: true,
  perMessageDeflate: false
});

socketHandler(io, roomManager);

async function bootstrap() {
  try {
    const workers = [];
    const numWorkers = config.mediasoup.numWorkers || 1;
    
    logger.info(`Starting ${numWorkers} MediaSoup workers...`);
    
    for (let i = 0; i < numWorkers; i++) {
      const worker = await mediasoup.createWorker(config.mediasoup.workerSettings);
      
      worker.on('died', () => {
        logger.error(`MediaSoup worker ${i} died, exiting...`);
        process.exit(1);
      });
      
      workers.push(worker);
    }

    await roomManager.initialize(workers);

    server.listen(config.PORT, '0.0.0.0', () => {
      logger.info(`🚀 Production-Ready Backend running on port ${config.PORT}`);
    });
  } catch (error) {
    logger.error(`Bootstrap failed: ${error.message}`);
    process.exit(1);
  }
}

bootstrap();
