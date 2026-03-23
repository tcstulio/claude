'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const protocol = require('../lib/protocol');

describe('protocol', () => {
  describe('createMessage', () => {
    it('cria mensagem válida com campos obrigatórios', () => {
      const msg = protocol.createMessage('PING', {}, null);
      assert.equal(msg.v, 1);
      assert.equal(msg.type, 'PING');
      assert.ok(msg.id);
      assert.ok(msg.from.nodeId);
      assert.ok(msg.timestamp);
      assert.equal(msg.ttl, 300);
    });

    it('rejeita tipo inválido', () => {
      assert.throws(() => protocol.createMessage('INVALID', {}), /Tipo inválido/);
    });

    it('aceita opções de canal e replyTo', () => {
      const msg = protocol.createMessage('MSG', { text: 'oi' }, null, {
        channel: 'whatsapp',
        replyTo: 'msg-123',
        ttl: 60,
      });
      assert.equal(msg.channel, 'whatsapp');
      assert.equal(msg.replyTo, 'msg-123');
      assert.equal(msg.ttl, 60);
    });
  });

  describe('helpers', () => {
    it('ping cria mensagem PING', () => {
      const msg = protocol.ping({ nodeId: 'n1' });
      assert.equal(msg.type, 'PING');
      assert.equal(msg.to.nodeId, 'n1');
    });

    it('pong cria mensagem com replyTo', () => {
      const msg = protocol.pong('orig-id', { nodeId: 'n2' });
      assert.equal(msg.type, 'PONG');
      assert.equal(msg.replyTo, 'orig-id');
    });

    it('discover inclui capabilities', () => {
      const msg = protocol.discover(['hub', 'relay']);
      assert.equal(msg.type, 'DISCOVER');
      assert.deepEqual(msg.payload.capabilities, ['hub', 'relay']);
    });

    it('announce inclui capabilities e channels', () => {
      const msg = protocol.announce(['hub'], ['whatsapp', 'telegram']);
      assert.equal(msg.type, 'ANNOUNCE');
      assert.deepEqual(msg.payload.channels, ['whatsapp', 'telegram']);
    });

    it('msg cria mensagem de texto', () => {
      const msg = protocol.msg('Olá mundo', { nodeId: 'n3' });
      assert.equal(msg.type, 'MSG');
      assert.equal(msg.payload.text, 'Olá mundo');
    });
  });

  describe('validate', () => {
    it('valida mensagem correta', () => {
      const msg = protocol.ping();
      assert.ok(protocol.validate(msg));
    });

    it('rejeita null', () => {
      assert.ok(!protocol.validate(null));
    });

    it('rejeita versão errada', () => {
      const msg = protocol.ping();
      msg.v = 2;
      assert.ok(!protocol.validate(msg));
    });

    it('rejeita tipo inválido', () => {
      const msg = protocol.ping();
      msg.type = 'BOGUS';
      assert.ok(!protocol.validate(msg));
    });

    it('rejeita sem id', () => {
      const msg = protocol.ping();
      msg.id = null;
      assert.ok(!protocol.validate(msg));
    });
  });

  describe('serialize/parse', () => {
    it('serializa e desserializa mensagem', () => {
      const original = protocol.msg('teste', { nodeId: 'n1' });
      const json = protocol.serialize(original);
      assert.equal(typeof json, 'string');

      const parsed = protocol.parse(json);
      assert.deepEqual(parsed, original);
    });

    it('parse retorna null para JSON inválido', () => {
      assert.equal(protocol.parse('not json'), null);
    });

    it('parse retorna null para mensagem inválida', () => {
      assert.equal(protocol.parse('{"v":2}'), null);
    });

    it('parse aceita objeto direto', () => {
      const msg = protocol.ping();
      const parsed = protocol.parse(msg);
      assert.deepEqual(parsed, msg);
    });
  });
});
