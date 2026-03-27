// © 2026 Tulio Silva — Tulipa Platform. Proprietary and confidential.

import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Identity from '../lib-ts/identity.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_KEY_PATH = path.join(__dirname, '../data/test-identity.json');

describe('Identity (Ed25519)', () => {
  let identity: InstanceType<typeof Identity>;

  beforeAll(() => {
    if (fs.existsSync(TEST_KEY_PATH)) fs.unlinkSync(TEST_KEY_PATH);
    identity = new Identity({
      keyPath: TEST_KEY_PATH,
      nodeId: 'test-node-001',
      nodeName: 'Test Node',
    });
  });

  afterAll(() => {
    if (fs.existsSync(TEST_KEY_PATH)) fs.unlinkSync(TEST_KEY_PATH);
  });

  it('gera par de chaves Ed25519', () => {
    expect(identity.publicKey).toBeTruthy();
    expect(identity.fingerprint).toBeTruthy();
    expect(identity.nodeId).toBe('test-node-001');
    expect(identity.fingerprint.length).toBe(16);
  });

  it('persiste chaves em disco', () => {
    expect(fs.existsSync(TEST_KEY_PATH)).toBeTruthy();
    const data = JSON.parse(fs.readFileSync(TEST_KEY_PATH, 'utf-8'));
    expect(data.algorithm).toBe('Ed25519');
    expect(data.nodeId).toBe('test-node-001');
  });

  it('carrega chaves existentes', () => {
    const identity2 = new Identity({
      keyPath: TEST_KEY_PATH,
    });
    expect(identity2.publicKey).toBe(identity.publicKey);
    expect(identity2.fingerprint).toBe(identity.fingerprint);
  });

  it('assina e verifica dados (string)', () => {
    const data = 'Mensagem de teste para assinatura';
    const sig = identity.sign(data);
    expect(sig).toBeTruthy();
    expect(sig.length > 0).toBeTruthy();

    const valid = Identity.verify(data, sig, identity.publicKey);
    expect(valid).toBe(true);
  });

  it('assina e verifica dados (objeto)', () => {
    const data = { type: 'MSG', payload: { text: 'Olá' }, timestamp: '2026-01-01T00:00:00Z' };
    const sig = identity.sign(data);

    expect(Identity.verify(data, sig, identity.publicKey)).toBe(true);
  });

  it('rejeita assinatura inválida', () => {
    const data = 'Teste';
    const sig = identity.sign(data);

    // Altera dados
    expect(Identity.verify('Outro', sig, identity.publicKey)).toBe(false);

    // Altera assinatura
    const tampered = 'ff' + sig.slice(2);
    expect(Identity.verify(data, tampered, identity.publicKey)).toBe(false);
  });

  it('rejeita chave pública errada', () => {
    const other = new Identity({
      keyPath: path.join(__dirname, '../data/test-identity-other.json'),
      nodeId: 'other-node',
    });

    const data = 'Teste cross-node';
    const sig = identity.sign(data);

    // Verifica com chave do outro nó — deve falhar
    expect(Identity.verify(data, sig, other.publicKey)).toBe(false);

    // Verifica com chave correta — deve passar
    expect(Identity.verify(data, sig, identity.publicKey)).toBe(true);

    // Cleanup
    const otherPath = path.join(__dirname, '../data/test-identity-other.json');
    if (fs.existsSync(otherPath)) fs.unlinkSync(otherPath);
  });

  it('exporta chave pública', () => {
    const exported = identity.exportPublicKey();
    expect(exported.nodeId).toBe('test-node-001');
    expect(exported.algorithm).toBe('Ed25519');
    expect(exported.publicKey).toBeTruthy();
    expect(exported.fingerprint).toBeTruthy();
  });

  it('assina mensagem do protocolo Tulipa', () => {
    const msg = {
      v: 1,
      type: 'MSG',
      id: 'msg-123',
      from: { nodeId: 'test-node-001', name: 'Test Node' },
      to: { nodeId: 'node-xyz', name: 'Outro' },
      timestamp: new Date().toISOString(),
      payload: { text: 'Olá rede Tulipa' },
    };

    const signed = identity.signMessage(msg);
    expect(signed.signature).toBeTruthy();
    expect(signed.signerKey).toBeTruthy();
    expect(signed.signerFingerprint).toBeTruthy();

    // Verifica
    expect(Identity.verifyMessage(signed)).toBe(true);
  });

  it('cria e verifica recibo de entrega', () => {
    const receipt = identity.createReceipt('msg-123', 'node-A', 'node-B', 'delivered');
    expect(receipt.messageId).toBe('msg-123');
    expect(receipt.action).toBe('delivered');
    expect(receipt.signature).toBeTruthy();
    expect(receipt.nonce).toBeTruthy();

    expect(Identity.verifyReceipt(receipt)).toBe(true);

    // Adultera e verifica que falha
    const tampered = { ...receipt, action: 'rejected' };
    expect(Identity.verifyReceipt(tampered)).toBe(false);
  });

  it('verifyOwn funciona', () => {
    const data = 'teste verifyOwn';
    const sig = identity.sign(data);
    expect(identity.verifyOwn(data, sig)).toBe(true);
  });
});
