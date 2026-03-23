'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const Identity = require('../lib/identity');

const TEST_KEY_PATH = path.join(__dirname, '../data/test-identity.json');

describe('Identity (Ed25519)', () => {
  let identity;

  before(() => {
    if (fs.existsSync(TEST_KEY_PATH)) fs.unlinkSync(TEST_KEY_PATH);
    identity = new Identity({
      keyPath: TEST_KEY_PATH,
      nodeId: 'test-node-001',
      nodeName: 'Test Node',
    });
  });

  after(() => {
    if (fs.existsSync(TEST_KEY_PATH)) fs.unlinkSync(TEST_KEY_PATH);
  });

  it('gera par de chaves Ed25519', () => {
    assert.ok(identity.publicKey);
    assert.ok(identity.fingerprint);
    assert.equal(identity.nodeId, 'test-node-001');
    assert.equal(identity.fingerprint.length, 16);
  });

  it('persiste chaves em disco', () => {
    assert.ok(fs.existsSync(TEST_KEY_PATH));
    const data = JSON.parse(fs.readFileSync(TEST_KEY_PATH, 'utf-8'));
    assert.equal(data.algorithm, 'Ed25519');
    assert.equal(data.nodeId, 'test-node-001');
  });

  it('carrega chaves existentes', () => {
    const identity2 = new Identity({
      keyPath: TEST_KEY_PATH,
    });
    assert.equal(identity2.publicKey, identity.publicKey);
    assert.equal(identity2.fingerprint, identity.fingerprint);
  });

  it('assina e verifica dados (string)', () => {
    const data = 'Mensagem de teste para assinatura';
    const sig = identity.sign(data);
    assert.ok(sig);
    assert.ok(sig.length > 0);

    const valid = Identity.verify(data, sig, identity.publicKey);
    assert.equal(valid, true);
  });

  it('assina e verifica dados (objeto)', () => {
    const data = { type: 'MSG', payload: { text: 'Olá' }, timestamp: '2026-01-01T00:00:00Z' };
    const sig = identity.sign(data);

    assert.equal(Identity.verify(data, sig, identity.publicKey), true);
  });

  it('rejeita assinatura inválida', () => {
    const data = 'Teste';
    const sig = identity.sign(data);

    // Altera dados
    assert.equal(Identity.verify('Outro', sig, identity.publicKey), false);

    // Altera assinatura
    const tampered = 'ff' + sig.slice(2);
    assert.equal(Identity.verify(data, tampered, identity.publicKey), false);
  });

  it('rejeita chave pública errada', () => {
    const other = new Identity({
      keyPath: path.join(__dirname, '../data/test-identity-other.json'),
      nodeId: 'other-node',
    });

    const data = 'Teste cross-node';
    const sig = identity.sign(data);

    // Verifica com chave do outro nó — deve falhar
    assert.equal(Identity.verify(data, sig, other.publicKey), false);

    // Verifica com chave correta — deve passar
    assert.equal(Identity.verify(data, sig, identity.publicKey), true);

    // Cleanup
    const otherPath = path.join(__dirname, '../data/test-identity-other.json');
    if (fs.existsSync(otherPath)) fs.unlinkSync(otherPath);
  });

  it('exporta chave pública', () => {
    const exported = identity.exportPublicKey();
    assert.equal(exported.nodeId, 'test-node-001');
    assert.equal(exported.algorithm, 'Ed25519');
    assert.ok(exported.publicKey);
    assert.ok(exported.fingerprint);
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
    assert.ok(signed.signature);
    assert.ok(signed.signerKey);
    assert.ok(signed.signerFingerprint);

    // Verifica
    assert.equal(Identity.verifyMessage(signed), true);
  });

  it('cria e verifica recibo de entrega', () => {
    const receipt = identity.createReceipt('msg-123', 'node-A', 'node-B', 'delivered');
    assert.equal(receipt.messageId, 'msg-123');
    assert.equal(receipt.action, 'delivered');
    assert.ok(receipt.signature);
    assert.ok(receipt.nonce);

    assert.equal(Identity.verifyReceipt(receipt), true);

    // Adultera e verifica que falha
    const tampered = { ...receipt, action: 'rejected' };
    assert.equal(Identity.verifyReceipt(tampered), false);
  });

  it('verifyOwn funciona', () => {
    const data = 'teste verifyOwn';
    const sig = identity.sign(data);
    assert.equal(identity.verifyOwn(data, sig), true);
  });
});
