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
      'x-google-start-bitrate': 800
    }
  }
];

const webRtcTransportOptions = {
  listenIps: [
    {
      ip: "0.0.0.0",
      announcedIp: process.env.ANNOUNCED_IP || "127.0.0.1"
    }
  ],
  initialAvailableOutgoingBitrate: 2000000, // Doubled for faster initial ramp
  minimumAvailableOutgoingBitrate: 1000000,
  maxSctpMessageSize: 262144,
  enableUdp: true,
  enableTcp: false, // Force UDP only for lowest latency
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
    listenIp: { ip: '127.0.0.1', announcedIp: null },
    rtcpMux: false,
    comedia: true
  }
};
