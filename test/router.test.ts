// © 2026 Tulio Silva — Tulipa Platform. Proprietary and confidential.

import { describe, it, beforeEach, expect } from 'vitest';
import Router from '../lib-ts/router.js';
import Transport from '../lib-ts/transport/base.js';

// Mock transport para testes
class MockTransport extends Transport {
  _shouldFail: boolean;
  _available: boolean;
  sentMessages: Array<{ destination: string; message: string }>;

  constructor(name: string, opts: any = {}) {
    super(name, { enabled: true, priority: opts.priority || 99 });
    this._shouldFail = opts.shouldFail || false;
    this._available = opts.available !== false;
    this.sentMessages = [];
  }

  async send(destination: string, message: string) {
    if (this._shouldFail) throw new Error(`${this.name} falhou`);
    this.sentMessages.push({ destination, message });
    this._countSent();
    return { delivered: true };
  }

  async receive() { return []; }

  async healthCheck() {
    return { ok: !this._shouldFail, channel: this.name };
  }

  async broadcast(message: string) {
    return this.send('broadcast', message);
  }
}

describe('Router', () => {
  let router: any;

  beforeEach(() => {
    router = new Router();
  });

  describe('register/unregister', () => {
    it('registra transport', () => {
      const t = new MockTransport('test');
      router.register(t);
      expect(router.get('test')).toBe(t);
    });

    it('remove transport', () => {
      router.register(new MockTransport('test'));
      router.unregister('test');
      expect(router.get('test')).toBe(undefined);
    });
  });

  describe('send', () => {
    it('envia pelo transport de maior prioridade', async () => {
      const t1 = new MockTransport('high', { priority: 1 });
      const t2 = new MockTransport('low', { priority: 2 });
      router.register(t1).register(t2);

      const result = await router.send('dest', 'msg');
      expect(result.ok).toBe(true);
      expect(result.channel).toBe('high');
      expect(t1.sentMessages.length).toBe(1);
      expect(t2.sentMessages.length).toBe(0);
    });

    it('faz fallback quando o primeiro falha', async () => {
      const t1 = new MockTransport('fail', { priority: 1, shouldFail: true });
      const t2 = new MockTransport('ok', { priority: 2 });
      router.register(t1).register(t2);

      const result = await router.send('dest', 'msg');
      expect(result.ok).toBe(true);
      expect(result.channel).toBe('ok');
    });

    it('retorna erro quando todos falham', async () => {
      const t1 = new MockTransport('fail1', { priority: 1, shouldFail: true });
      const t2 = new MockTransport('fail2', { priority: 2, shouldFail: true });
      router.register(t1).register(t2);

      const result = await router.send('dest', 'msg');
      expect(result.ok).toBe(false);
      expect(result.errors.length).toBe(2);
    });

    it('respeita preferChannel', async () => {
      const t1 = new MockTransport('high', { priority: 1 });
      const t2 = new MockTransport('preferred', { priority: 2 });
      router.register(t1).register(t2);

      const result = await router.send('dest', 'msg', { preferChannel: 'preferred' });
      expect(result.channel).toBe('preferred');
    });

    it('retorna erro sem transports', async () => {
      const result = await router.send('dest', 'msg');
      expect(result.ok).toBe(false);
      expect(result.error).toBeTruthy();
    });
  });

  describe('broadcast', () => {
    it('envia para todos os transports', async () => {
      router.register(new MockTransport('a', { priority: 1 }));
      router.register(new MockTransport('b', { priority: 2 }));

      const results = await router.broadcast('hello');
      expect(results.length).toBe(2);
      expect(results.every((r: any) => r.ok)).toBeTruthy();
    });
  });

  describe('healthCheckAll', () => {
    it('verifica todos os transports', async () => {
      router.register(new MockTransport('ok', { priority: 1 }));
      router.register(new MockTransport('fail', { priority: 2, shouldFail: true }));

      const results = await router.healthCheckAll();
      expect(results.ok.ok).toBeTruthy();
      expect(!results.fail.ok).toBeTruthy();
    });
  });

  describe('available', () => {
    it('filtra transports indisponíveis', () => {
      router.register(new MockTransport('up', { priority: 1, available: true }));
      router.register(new MockTransport('down', { priority: 2, available: false }));

      const avail = router.available();
      expect(avail.length).toBe(1);
      expect(avail[0].name).toBe('up');
    });
  });
});
