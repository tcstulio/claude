'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const MeshManager = require('../lib/mesh/index');

describe('MeshManager', () => {
  let mesh;

  beforeEach(() => {
    mesh = new MeshManager({
      nodeId: 'node-self',
      nodeName: 'Test Node',
    });
  });

  describe('sendPrompt', () => {
    it('rejeita se peer não existe', async () => {
      await assert.rejects(
        () => mesh.sendPrompt('node-inexistente', 'oi'),
        { message: /não encontrado/ }
      );
    });

    it('envia prompt via HTTP direto quando peer tem endpoint', async () => {
      // Registra peer com endpoint
      mesh.registry.upsert('node-peer', {
        name: 'Peer Test',
        endpoint: 'http://fake:18800',
        metadata: { remoteToken: 'tok123' },
      });

      // Mock fetch
      mesh._fetch = async (url, opts) => {
        assert.equal(url, 'http://fake:18800/api/message');
        assert.equal(opts.method, 'POST');
        assert.equal(opts.headers['Authorization'], 'Bearer tok123');
        const body = JSON.parse(opts.body);
        assert.equal(body.text, 'Diga oi');
        assert.equal(body.system_prompt, 'Voce e um bot');
        return {
          ok: true,
          json: async () => ({ response: 'Oi!', model: 'claude-haiku' }),
        };
      };

      const result = await mesh.sendPrompt('node-peer', 'Diga oi', {
        systemPrompt: 'Voce e um bot',
      });

      assert.equal(result.method, 'http');
      assert.equal(result.response, 'Oi!');
      assert.equal(result.model, 'claude-haiku');
    });

    it('fallback para gateway-relay quando HTTP direto falha', async () => {
      mesh.registry.upsert('node-peer', {
        name: 'Peer Test',
        endpoint: 'http://fake:18800',
        metadata: { remoteToken: 'tok123' },
      });

      // Mock fetch que falha
      mesh._fetch = async () => { throw new Error('Connection refused'); };

      // Mock callMcpTool (gateway relay)
      mesh._callMcpTool = async (tool, args) => {
        assert.equal(tool, 'run_command');
        assert.ok(args.command.includes('curl'));
        assert.ok(args.command.includes('http://fake:18800/api/message'));
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              output: JSON.stringify({ response: 'Via relay!', model: 'default' }),
              exitCode: 0,
            }),
          }],
        };
      };

      const result = await mesh.sendPrompt('node-peer', 'oi');
      assert.equal(result.method, 'gateway-relay');
      assert.equal(result.response, 'Via relay!');
    });

    it('emite evento prompt-response', async () => {
      mesh.registry.upsert('node-peer', {
        name: 'Peer',
        endpoint: 'http://fake:18800',
      });

      mesh._fetch = async () => ({
        ok: true,
        json: async () => ({ response: 'OK', model: 'test' }),
      });

      let emitted;
      mesh.on('prompt-response', (data) => { emitted = data; });

      await mesh.sendPrompt('node-peer', 'test');
      assert.ok(emitted);
      assert.equal(emitted.nodeId, 'node-peer');
      assert.equal(emitted.method, 'http');
    });

    it('respeita timeout customizado', async () => {
      mesh.registry.upsert('node-peer', {
        name: 'Peer',
        endpoint: 'http://fake:18800',
      });

      let capturedSignal;
      mesh._fetch = async (url, opts) => {
        capturedSignal = opts.signal;
        return { ok: true, json: async () => ({ response: 'ok', model: 'x' }) };
      };

      await mesh.sendPrompt('node-peer', 'test', { timeoutMs: 60000 });
      // AbortSignal.timeout was created — we just verify it didn't abort
      assert.ok(capturedSignal);
    });

    it('erro quando nenhuma rota disponível', async () => {
      mesh.registry.upsert('node-peer', { name: 'Peer' });
      // Sem endpoint, sem callMcpTool, sem router
      await assert.rejects(
        () => mesh.sendPrompt('node-peer', 'oi'),
        { message: /sem rota disponível/ }
      );
    });
  });
});
