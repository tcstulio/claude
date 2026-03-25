// © 2026 Tulio Silva — Tulipa Platform. Proprietary and confidential.

import { describe, it, expect } from 'vitest';
import * as protocol from '../lib-ts/protocol.js';

describe('protocol', () => {
  describe('createMessage', () => {
    it('cria mensagem válida com campos obrigatórios', () => {
      const msg = protocol.createMessage('PING', {}, null);
      expect(msg.v).toBe(1);
      expect(msg.type).toBe('PING');
      expect(msg.id).toBeTruthy();
      expect(msg.from.nodeId).toBeTruthy();
      expect(msg.timestamp).toBeTruthy();
      expect(msg.ttl).toBe(300);
    });

    it('rejeita tipo inválido', () => {
      expect(() => protocol.createMessage('INVALID', {})).toThrow(/Tipo inválido/);
    });

    it('aceita opções de canal e replyTo', () => {
      const msg = protocol.createMessage('MSG', { text: 'oi' }, null, {
        channel: 'whatsapp',
        replyTo: 'msg-123',
        ttl: 60,
      });
      expect(msg.channel).toBe('whatsapp');
      expect(msg.replyTo).toBe('msg-123');
      expect(msg.ttl).toBe(60);
    });
  });

  describe('helpers', () => {
    it('ping cria mensagem PING', () => {
      const msg = protocol.ping({ nodeId: 'n1' });
      expect(msg.type).toBe('PING');
      expect(msg.to.nodeId).toBe('n1');
    });

    it('pong cria mensagem com replyTo', () => {
      const msg = protocol.pong('orig-id', { nodeId: 'n2' });
      expect(msg.type).toBe('PONG');
      expect(msg.replyTo).toBe('orig-id');
    });

    it('discover inclui capabilities', () => {
      const msg = protocol.discover(['hub', 'relay']);
      expect(msg.type).toBe('DISCOVER');
      expect(msg.payload.capabilities).toEqual(['hub', 'relay']);
    });

    it('announce inclui capabilities e channels', () => {
      const msg = protocol.announce(['hub'], ['whatsapp', 'telegram']);
      expect(msg.type).toBe('ANNOUNCE');
      expect(msg.payload.channels).toEqual(['whatsapp', 'telegram']);
    });

    it('msg cria mensagem de texto', () => {
      const msg = protocol.msg('Olá mundo', { nodeId: 'n3' });
      expect(msg.type).toBe('MSG');
      expect(msg.payload.text).toBe('Olá mundo');
    });
  });

  describe('validate', () => {
    it('valida mensagem correta', () => {
      const msg = protocol.ping();
      expect(protocol.validate(msg)).toBeTruthy();
    });

    it('rejeita null', () => {
      expect(protocol.validate(null)).not.toBeTruthy();
    });

    it('rejeita versão errada', () => {
      const msg = protocol.ping();
      msg.v = 2;
      expect(protocol.validate(msg)).not.toBeTruthy();
    });

    it('rejeita tipo inválido', () => {
      const msg = protocol.ping();
      msg.type = 'BOGUS';
      expect(protocol.validate(msg)).not.toBeTruthy();
    });

    it('rejeita sem id', () => {
      const msg = protocol.ping();
      msg.id = null;
      expect(protocol.validate(msg)).not.toBeTruthy();
    });
  });

  describe('serialize/parse', () => {
    it('serializa e desserializa mensagem', () => {
      const original = protocol.msg('teste', { nodeId: 'n1' });
      const json = protocol.serialize(original);
      expect(typeof json).toBe('string');

      const parsed = protocol.parse(json);
      expect(parsed).toEqual(original);
    });

    it('parse retorna null para JSON inválido', () => {
      expect(protocol.parse('not json')).toBe(null);
    });

    it('parse retorna null para mensagem inválida', () => {
      expect(protocol.parse('{"v":2}')).toBe(null);
    });

    it('parse aceita objeto direto', () => {
      const msg = protocol.ping();
      const parsed = protocol.parse(msg);
      expect(parsed).toEqual(msg);
    });
  });
});
