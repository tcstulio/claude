// © 2026 Tulio Silva — Tulipa Platform. Proprietary and confidential.

import { describe, it, beforeEach, expect } from 'vitest';
import MeshManager from '../lib-ts/mesh/mesh-manager.js';

describe('MeshManager', () => {
  let mesh: InstanceType<typeof MeshManager>;

  beforeEach(() => {
    mesh = new MeshManager({
      nodeId: 'node-self',
      nodeName: 'Test Node',
    });
  });

  describe('sendPrompt', () => {
    it('rejeita se peer não existe', async () => {
      await expect(
        () => mesh.sendPrompt('node-inexistente', 'oi')
      ).rejects.toThrow(/não encontrado/);
    });

    it('envia prompt via HTTP direto quando peer tem endpoint', async () => {
      // Registra peer com endpoint
      mesh.registry.upsert('node-peer', {
        name: 'Peer Test',
        endpoint: 'http://fake:18800',
        metadata: { remoteToken: 'tok123' },
      });

      // Mock fetch
      (mesh as any)._fetch = async (url: string, opts: any) => {
        expect(url).toBe('http://fake:18800/api/message');
        expect(opts.method).toBe('POST');
        expect(opts.headers['Authorization']).toBe('Bearer tok123');
        const body = JSON.parse(opts.body);
        expect(body.text).toBe('Diga oi');
        expect(body.system_prompt).toBe('Voce e um bot');
        return {
          ok: true,
          json: async () => ({ response: 'Oi!', model: 'claude-haiku' }),
        };
      };

      const result = await mesh.sendPrompt('node-peer', 'Diga oi', {
        systemPrompt: 'Voce e um bot',
      });

      expect(result.method).toBe('http');
      expect(result.response).toBe('Oi!');
      expect(result.model).toBe('claude-haiku');
    });

    it('fallback para gateway-relay quando HTTP direto falha', async () => {
      mesh.registry.upsert('node-peer', {
        name: 'Peer Test',
        endpoint: 'http://fake:18800',
        metadata: { remoteToken: 'tok123' },
      });

      // Mock fetch que falha
      (mesh as any)._fetch = async () => { throw new Error('Connection refused'); };

      // Mock callMcpTool (gateway relay)
      (mesh as any)._callMcpTool = async (tool: string, args: any) => {
        expect(tool).toBe('run_command');
        expect(args.command).toMatch(/curl/);
        expect(args.command).toMatch(/http:\/\/fake:18800\/api\/message/);
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
      expect(result.method).toBe('gateway-relay');
      expect(result.response).toBe('Via relay!');
    });

    it('emite evento prompt-response', async () => {
      mesh.registry.upsert('node-peer', {
        name: 'Peer',
        endpoint: 'http://fake:18800',
      });

      (mesh as any)._fetch = async () => ({
        ok: true,
        json: async () => ({ response: 'OK', model: 'test' }),
      });

      let emitted: any;
      mesh.on('prompt-response', (data) => { emitted = data; });

      await mesh.sendPrompt('node-peer', 'test');
      expect(emitted).toBeTruthy();
      expect(emitted.nodeId).toBe('node-peer');
      expect(emitted.method).toBe('http');
    });

    it('respeita timeout customizado', async () => {
      mesh.registry.upsert('node-peer', {
        name: 'Peer',
        endpoint: 'http://fake:18800',
      });

      let capturedSignal: any;
      (mesh as any)._fetch = async (url: string, opts: any) => {
        capturedSignal = opts.signal;
        return { ok: true, json: async () => ({ response: 'ok', model: 'x' }) };
      };

      await mesh.sendPrompt('node-peer', 'test', { timeoutMs: 60000 });
      // AbortSignal.timeout was created — we just verify it didn't abort
      expect(capturedSignal).toBeTruthy();
    });

    it('erro quando nenhuma rota disponível', async () => {
      mesh.registry.upsert('node-peer', { name: 'Peer' });
      // Sem endpoint, sem callMcpTool, sem router
      await expect(
        () => mesh.sendPrompt('node-peer', 'oi')
      ).rejects.toThrow(/sem rota disponível/);
    });
  });
});
