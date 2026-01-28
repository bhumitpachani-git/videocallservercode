const Joi = require('joi');

const joinRoomSchema = Joi.object({
  roomId: Joi.string().alphanum().min(3).max(30).required(),
  username: Joi.string().min(2).max(20).required(),
  password: Joi.string().allow('', null),
  recorder: Joi.boolean().default(false)
});

const transportSchema = Joi.object({
  roomId: Joi.string().required()
});

const recordingSchema = Joi.object({
  roomId: Joi.string().required()
});

const whiteboardSchema = Joi.object({
  roomId: Joi.string().required(),
  stroke: Joi.object().required()
});

const pollSchema = Joi.object({
  roomId: Joi.string().required(),
  poll: Joi.object({
    question: Joi.string().required(),
    options: Joi.array().items(Joi.string()).min(2).required()
  }).required()
});

module.exports = {
  joinRoomSchema,
  transportSchema,
  recordingSchema,
  whiteboardSchema,
  pollSchema
};
