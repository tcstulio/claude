'use strict';

const crypto = require('crypto');

const MSG_TYPES = ['PING', 'PONG', 'STATUS', 'ALERT', 'CMD', 'MSG', 'DISCOVER', 'ANNOUNCE'];

const NODE_ID = process.env.NODE_ID || `node-${crypto.randomBytes(4).toString('hex')}`;
const NODE_NAME = process.env.NODE_NAME || 'Tulipa #1';

function createMessage(type, payload, to, options = {}) {
  if (!MSG_TYPES.includes(type)) {
    throw new Error(`Tipo inválido: ${type}. Use: ${MSG_TYPES.join(', ')}`);
  }
  return {
    v: 1,
    type,
    id: crypto.randomUUID(),
    from: { nodeId: NODE_ID, name: NODE_NAME },
    to: to || { nodeId: '*', name: 'broadcast' },
    timestamp: new Date().toISOString(),
    channel: options.channel || null,
    payload: payload || {},
    ttl: options.ttl || 300,
    replyTo: options.replyTo || null,
  };
}

function ping(to, options) {
  return createMessage('PING', {}, to, options);
}

function pong(replyTo, to, options) {
  return createMessage('PONG', {}, to, { ...options, replyTo });
}

function status(payload, options) {
  return createMessage('STATUS', payload, null, options);
}

function alert(payload, options) {
  return createMessage('ALERT', payload, null, options);
}

function cmd(command, to, options) {
  return createMessage('CMD', { command }, to, options);
}

function msg(text, to, options) {
  return createMessage('MSG', { text }, to, options);
}

function discover(capabilities, options) {
  return createMessage('DISCOVER', { capabilities }, null, options);
}

function announce(capabilities, channels, options) {
  return createMessage('ANNOUNCE', { capabilities, channels }, null, options);
}

function validate(message) {
  if (!message || typeof message !== 'object') return false;
  if (message.v !== 1) return false;
  if (!MSG_TYPES.includes(message.type)) return false;
  if (!message.id || !message.from?.nodeId || !message.timestamp) return false;
  return true;
}

function serialize(message) {
  return JSON.stringify(message);
}

function parse(raw) {
  try {
    const msg = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return validate(msg) ? msg : null;
  } catch {
    return null;
  }
}

module.exports = {
  MSG_TYPES, NODE_ID, NODE_NAME,
  createMessage, ping, pong, status, alert, cmd, msg, discover, announce,
  validate, serialize, parse,
};
