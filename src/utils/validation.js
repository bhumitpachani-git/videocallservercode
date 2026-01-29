const { z } = require('zod');

const joinRoomSchema = z.object({
  roomId: z.string().min(1).max(100),
  username: z.string().min(2).max(20),
  password: z.string().optional().nullable(),
  recorder: z.boolean().default(false)
});

const transportSchema = z.object({
  roomId: z.string()
});

const recordingSchema = z.object({
  roomId: z.string()
});

const whiteboardSchema = z.object({
  roomId: z.string(),
  stroke: z.object({}).passthrough()
});

const pollSchema = z.object({
  roomId: z.string(),
  poll: z.object({
    question: z.string(),
    options: z.array(z.string()).min(2)
  })
});

module.exports = {
  joinRoomSchema,
  transportSchema,
  recordingSchema,
  whiteboardSchema,
  pollSchema
};
