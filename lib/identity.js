'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULT_KEY_PATH = process.env.TULIPA_KEY_PATH || './data/identity.json';

/**
 * Identity — identidade criptográfica Ed25519 para nós da rede Tulipa.
 *
 * Cada nó tem um par de chaves Ed25519 persistido em disco.
 * Mensagens são assinadas com a chave privada e verificadas com a pública.
 */
class Identity {
  /**
   * @param {object} options
   * @param {string} options.keyPath - caminho do arquivo de chaves
   * @param {string} options.nodeId - ID do nó (gerado se não fornecido)
   * @param {string} options.nodeName - nome do nó
   */
  constructor(options = {}) {
    this._keyPath = options.keyPath || DEFAULT_KEY_PATH;
    this._nodeId = options.nodeId || null;
    this._nodeName = options.nodeName || null;
    this._privateKey = null;
    this._publicKey = null;
    this._fingerprint = null;
    this._createdAt = null;

    this._loadOrGenerate();
  }

  get nodeId() { return this._nodeId; }
  get nodeName() { return this._nodeName; }
  get publicKey() { return this._publicKey; }
  get fingerprint() { return this._fingerprint; }
  get createdAt() { return this._createdAt; }

  /**
   * Exporta a chave pública (para compartilhar com peers).
   */
  exportPublicKey() {
    return {
      nodeId: this._nodeId,
      nodeName: this._nodeName,
      publicKey: this._publicKey,
      fingerprint: this._fingerprint,
      algorithm: 'Ed25519',
    };
  }

  /**
   * Assina dados com a chave privada Ed25519.
   * @param {string|object} data - dados a assinar
   * @returns {string} assinatura em hex
   */
  sign(data) {
    const payload = typeof data === 'string' ? data : JSON.stringify(data);
    const privateKeyObj = crypto.createPrivateKey({
      key: Buffer.from(this._privateKey, 'base64'),
      format: 'der',
      type: 'pkcs8',
    });
    const signature = crypto.sign(null, Buffer.from(payload), privateKeyObj);
    return signature.toString('hex');
  }

  /**
   * Verifica assinatura com uma chave pública Ed25519.
   * @param {string|object} data - dados originais
   * @param {string} signature - assinatura em hex
   * @param {string} publicKeyBase64 - chave pública em base64 (DER/SPKI)
   * @returns {boolean}
   */
  static verify(data, signature, publicKeyBase64) {
    try {
      const payload = typeof data === 'string' ? data : JSON.stringify(data);
      const publicKeyObj = crypto.createPublicKey({
        key: Buffer.from(publicKeyBase64, 'base64'),
        format: 'der',
        type: 'spki',
      });
      return crypto.verify(null, Buffer.from(payload), publicKeyObj, Buffer.from(signature, 'hex'));
    } catch {
      return false;
    }
  }

  /**
   * Verifica assinatura usando a chave pública desta instância.
   */
  verifyOwn(data, signature) {
    return Identity.verify(data, signature, this._publicKey);
  }

  /**
   * Assina uma mensagem do protocolo Tulipa (adiciona campo signature).
   */
  signMessage(message) {
    const { signature: _, ...msgWithoutSig } = message;
    const sig = this.sign(msgWithoutSig);
    return {
      ...message,
      signature: sig,
      signerKey: this._publicKey,
      signerFingerprint: this._fingerprint,
    };
  }

  /**
   * Verifica assinatura de uma mensagem do protocolo Tulipa.
   */
  static verifyMessage(message) {
    if (!message.signature || !message.signerKey) return false;
    const { signature, signerKey, signerFingerprint, ...msgWithoutSig } = message;
    return Identity.verify(msgWithoutSig, signature, signerKey);
  }

  /**
   * Cria um recibo assinado para uma troca entre dois nós.
   */
  createReceipt(messageId, fromNodeId, toNodeId, action) {
    const receipt = {
      messageId,
      from: fromNodeId,
      to: toNodeId,
      action, // 'delivered' | 'acknowledged' | 'rejected'
      timestamp: new Date().toISOString(),
      nonce: crypto.randomBytes(16).toString('hex'),
    };
    const signature = this.sign(receipt);
    return { ...receipt, signature, signerKey: this._publicKey };
  }

  /**
   * Verifica um recibo assinado.
   */
  static verifyReceipt(receipt) {
    if (!receipt.signature || !receipt.signerKey) return false;
    const { signature, signerKey, ...data } = receipt;
    return Identity.verify(data, signature, signerKey);
  }

  // ─── Internal ──────────────────────────────────────────────────────

  _loadOrGenerate() {
    try {
      if (fs.existsSync(this._keyPath)) {
        this._load();
        return;
      }
    } catch (err) {
      console.error(`[identity] Erro ao carregar chaves: ${err.message}, gerando novas`);
    }
    this._generate();
  }

  _generate() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'der' },
      privateKeyEncoding: { type: 'pkcs8', format: 'der' },
    });

    this._publicKey = publicKey.toString('base64');
    this._privateKey = privateKey.toString('base64');
    this._nodeId = this._nodeId || `node-${crypto.randomBytes(4).toString('hex')}`;
    this._fingerprint = this._computeFingerprint(this._publicKey);
    this._createdAt = new Date().toISOString();

    this._save();
    console.log(`[identity] Nova identidade gerada: ${this._fingerprint}`);
  }

  _load() {
    const data = JSON.parse(fs.readFileSync(this._keyPath, 'utf-8'));
    this._nodeId = data.nodeId || this._nodeId;
    this._nodeName = data.nodeName || this._nodeName;
    this._publicKey = data.publicKey;
    this._privateKey = data.privateKey;
    this._fingerprint = data.fingerprint || this._computeFingerprint(data.publicKey);
    this._createdAt = data.createdAt;
    console.log(`[identity] Identidade carregada: ${this._fingerprint}`);
  }

  _save() {
    const dir = path.dirname(this._keyPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    fs.writeFileSync(this._keyPath, JSON.stringify({
      nodeId: this._nodeId,
      nodeName: this._nodeName,
      publicKey: this._publicKey,
      privateKey: this._privateKey,
      fingerprint: this._fingerprint,
      createdAt: this._createdAt,
      algorithm: 'Ed25519',
    }, null, 2), { mode: 0o600 }); // readable only by owner
  }

  _computeFingerprint(publicKeyBase64) {
    return crypto.createHash('sha256')
      .update(Buffer.from(publicKeyBase64, 'base64'))
      .digest('hex')
      .slice(0, 16);
  }
}

module.exports = Identity;
