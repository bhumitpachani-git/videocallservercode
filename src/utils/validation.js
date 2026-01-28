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

module.exports = {
  joinRoomSchema,
  transportSchema,
  recordingSchema
};
