const mediaCodecs = [
  {
    kind: 'audio',
    mimeType: 'audio/opus',
    clockRate: 48000,
    channels: 2,
    parameters: {
      'sprop-stereo': 1,
      'usedtx': 1,
      'maxaveragebitrate': 128000
    }
  },
  {
    kind: 'video',
    mimeType: 'video/VP8',
    clockRate: 90000,
    parameters: {
      'x-google-start-bitrate': 800
    }
  },
  {
    kind: 'video',
    mimeType: 'video/H264',
    clockRate: 90000,
    parameters: {
      'packetization-mode': 1,
      'profile-level-id': '42e01f',
      'level-asymmetry-allowed': 1,
      'x-google-start-bitrate': 2000 // Increased for 1080p
    }
  }
];

const webRtcTransportOptions = {
  listenIps: [
    {
      ip: "0.0.0.0",
      announcedIp: process.env.ANNOUNCED_IP
    }
  ],
  initialAvailableOutgoingBitrate: 4000000, // 4Mbps for 1080p
  minimumAvailableOutgoingBitrate: 2000000, // 2Mbps min
  maxSctpMessageSize: 262144,
  enableUdp: true,
  enableTcp: true,
  preferUdp: true,
  disableIceLite: false,
};

module.exports = {
  PORT: process.env.PORT || 5000,
  AWS: {
    region: process.env.AWS_REGION || 'us-east-1',
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    }
  },
  mediaCodecs,
  webRtcTransportOptions,
  plainTransportOptions: {
    listenIp: { ip: '0.0.0.0.0', announcedIp: process.env.ANNOUNCED_IP },
    rtcpMux: false,
    comedia: true
  },
  mediasoup: {
    numWorkers: Object.keys(require('os').cpus()).length,
    workerSettings: {
      logLevel: 'warn',
      logTags: ['info', 'ice', 'dtls', 'rtp', 'srtp', 'rtcp'],
      rtcMinPort: process.env.RTC_MIN_PORT || 10000,
      rtcMaxPort: process.env.RTC_MAX_PORT || 10100,
    }
  }
};
