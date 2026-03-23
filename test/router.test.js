'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const Router = require('../lib/router');
const Transport = require('../lib/transport/base');

// Mock transport para testes
class MockTransport extends Transport {
  constructor(name, opts = {}) {
    super(name, { enabled: true, priority: opts.priority || 99 });
    this._shouldFail = opts.shouldFail || false;
    this._available = opts.available !== false;
    this.sentMessages = [];
  }

  async send(destination, message) {
    if (this._shouldFail) throw new Error(`${this.name} falhou`);
    this.sentMessages.push({ destination, message });
    this._countSent();
    return { delivered: true };
  }

  async receive() { return []; }

  async healthCheck() {
    return { ok: !this._shouldFail, channel: this.name };
  }

  async broadcast(message) {
    return this.send('broadcast', message);
  }
}

describe('Router', () => {
  let router;

  beforeEach(() => {
    router = new Router();
  });

  describe('register/unregister', () => {
    it('registra transport', () => {
      const t = new MockTransport('test');
      router.register(t);
      assert.equal(router.get('test'), t);
    });

    it('remove transport', () => {
      router.register(new MockTransport('test'));
      router.unregister('test');
      assert.equal(router.get('test'), undefined);
    });
  });

  describe('send', () => {
    it('envia pelo transport de maior prioridade', async () => {
      const t1 = new MockTransport('high', { priority: 1 });
      const t2 = new MockTransport('low', { priority: 2 });
      router.register(t1).register(t2);

      const result = await router.send('dest', 'msg');
      assert.equal(result.ok, true);
      assert.equal(result.channel, 'high');
      assert.equal(t1.sentMessages.length, 1);
      assert.equal(t2.sentMessages.length, 0);
    });

    it('faz fallback quando o primeiro falha', async () => {
      const t1 = new MockTransport('fail', { priority: 1, shouldFail: true });
      const t2 = new MockTransport('ok', { priority: 2 });
      router.register(t1).register(t2);

      const result = await router.send('dest', 'msg');
      assert.equal(result.ok, true);
      assert.equal(result.channel, 'ok');
    });

    it('retorna erro quando todos falham', async () => {
      const t1 = new MockTransport('fail1', { priority: 1, shouldFail: true });
      const t2 = new MockTransport('fail2', { priority: 2, shouldFail: true });
      router.register(t1).register(t2);

      const result = await router.send('dest', 'msg');
      assert.equal(result.ok, false);
      assert.equal(result.errors.length, 2);
    });

    it('respeita preferChannel', async () => {
      const t1 = new MockTransport('high', { priority: 1 });
      const t2 = new MockTransport('preferred', { priority: 2 });
      router.register(t1).register(t2);

      const result = await router.send('dest', 'msg', { preferChannel: 'preferred' });
      assert.equal(result.channel, 'preferred');
    });

    it('retorna erro sem transports', async () => {
      const result = await router.send('dest', 'msg');
      assert.equal(result.ok, false);
      assert.ok(result.error);
    });
  });

  describe('broadcast', () => {
    it('envia para todos os transports', async () => {
      router.register(new MockTransport('a', { priority: 1 }));
      router.register(new MockTransport('b', { priority: 2 }));

      const results = await router.broadcast('hello');
      assert.equal(results.length, 2);
      assert.ok(results.every(r => r.ok));
    });
  });

  describe('healthCheckAll', () => {
    it('verifica todos os transports', async () => {
      router.register(new MockTransport('ok', { priority: 1 }));
      router.register(new MockTransport('fail', { priority: 2, shouldFail: true }));

      const results = await router.healthCheckAll();
      assert.ok(results.ok.ok);
      assert.ok(!results.fail.ok);
    });
  });

  describe('available', () => {
    it('filtra transports indisponíveis', () => {
      router.register(new MockTransport('up', { priority: 1, available: true }));
      router.register(new MockTransport('down', { priority: 2, available: false }));

      const avail = router.available();
      assert.equal(avail.length, 1);
      assert.equal(avail[0].name, 'up');
    });
  });
});
