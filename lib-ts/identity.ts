// © 2026 Tulio Silva — Tulipa Platform. Proprietary and confidential.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_KEY_PATH: string = process.env.TULIPA_KEY_PATH || './data/identity.json';

export interface IdentityOptions {
  keyPath?: string;
  nodeId?: string | null;
  nodeName?: string | null;
}

export interface PublicKeyExport {
  nodeId: string | null;
  nodeName: string | null;
  publicKey: string | null;
  fingerprint: string | null;
  algorithm: 'Ed25519';
}

export interface SignedMessage extends Record<string, unknown> {
  signature: string;
  signerKey: string;
  signerFingerprint: string;
}

export interface Receipt {
  messageId: string;
  from: string;
  to: string;
  action: string;
  timestamp: string;
  nonce: string;
  signature?: string;
  signerKey?: string;
}

interface IdentityData {
  nodeId?: string;
  nodeName?: string;
  publicKey: string;
  privateKey: string;
  fingerprint?: string;
  createdAt?: string;
  algorithm?: string;
}

export default class Identity {
  private _keyPath: string;
  private _nodeId: string | null;
  private _nodeName: string | null;
  private _privateKey: string | null;
  private _publicKey: string | null;
  private _fingerprint: string | null;
  private _createdAt: string | null;

  constructor(options: IdentityOptions = {}) {
    this._keyPath = options.keyPath || DEFAULT_KEY_PATH;
    this._nodeId = options.nodeId || null;
    this._nodeName = options.nodeName || null;
    this._privateKey = null;
    this._publicKey = null;
    this._fingerprint = null;
    this._createdAt = null;
    this._loadOrGenerate();
  }

  get nodeId(): string | null { return this._nodeId; }
  get nodeName(): string | null { return this._nodeName; }
  get publicKey(): string | null { return this._publicKey; }
  get fingerprint(): string | null { return this._fingerprint; }
  get createdAt(): string | null { return this._createdAt; }

  exportPublicKey(): PublicKeyExport {
    return {
      nodeId: this._nodeId,
      nodeName: this._nodeName,
      publicKey: this._publicKey,
      fingerprint: this._fingerprint,
      algorithm: 'Ed25519',
    };
  }

  sign(data: string | Record<string, unknown>): string {
    const payload = typeof data === 'string' ? data : JSON.stringify(data);
    const privateKeyObj = crypto.createPrivateKey({
      key: Buffer.from(this._privateKey!, 'base64'),
      format: 'der',
      type: 'pkcs8',
    });
    const signature = crypto.sign(null, Buffer.from(payload), privateKeyObj);
    return signature.toString('hex');
  }

  static verify(
    data: string | Record<string, unknown>,
    signature: string,
    publicKeyBase64: string,
  ): boolean {
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

  verifyOwn(data: string | Record<string, unknown>, signature: string): boolean {
    return Identity.verify(data, signature, this._publicKey!);
  }

  signMessage(message: Record<string, unknown>): SignedMessage {
    const { signature: _, ...msgWithoutSig } = message;
    const sig = this.sign(msgWithoutSig);
    return {
      ...message,
      signature: sig,
      signerKey: this._publicKey!,
      signerFingerprint: this._fingerprint!,
    };
  }

  static verifyMessage(message: Record<string, unknown>): boolean {
    if (!message.signature || !message.signerKey) return false;
    const { signature, signerKey, signerFingerprint, ...msgWithoutSig } = message;
    return Identity.verify(msgWithoutSig, signature as string, signerKey as string);
  }

  createReceipt(
    messageId: string,
    fromNodeId: string,
    toNodeId: string,
    action: string,
  ): Receipt {
    const receipt: Receipt = {
      messageId,
      from: fromNodeId,
      to: toNodeId,
      action,
      timestamp: new Date().toISOString(),
      nonce: crypto.randomBytes(16).toString('hex'),
    };
    const signature = this.sign(receipt as unknown as Record<string, unknown>);
    return { ...receipt, signature, signerKey: this._publicKey! };
  }

  static verifyReceipt(receipt: Receipt): boolean {
    if (!receipt.signature || !receipt.signerKey) return false;
    const { signature, signerKey, ...data } = receipt;
    return Identity.verify(data as unknown as Record<string, unknown>, signature, signerKey);
  }

  private _loadOrGenerate(): void {
    try {
      if (fs.existsSync(this._keyPath)) {
        this._load();
        return;
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[identity] Erro ao carregar chaves: ${message}, gerando novas`);
    }
    this._generate();
  }

  private _generate(): void {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'der' },
      privateKeyEncoding: { type: 'pkcs8', format: 'der' },
    });
    this._publicKey = (publicKey as Buffer).toString('base64');
    this._privateKey = (privateKey as Buffer).toString('base64');
    this._nodeId = this._nodeId || `node-${crypto.randomBytes(4).toString('hex')}`;
    this._fingerprint = this._computeFingerprint(this._publicKey);
    this._createdAt = new Date().toISOString();
    this._save();
    console.log(`[identity] Nova identidade gerada: ${this._fingerprint}`);
  }

  private _load(): void {
    const data: IdentityData = JSON.parse(fs.readFileSync(this._keyPath, 'utf-8'));
    this._nodeId = data.nodeId || this._nodeId;
    this._nodeName = data.nodeName || this._nodeName;
    this._publicKey = data.publicKey;
    this._privateKey = data.privateKey;
    this._fingerprint = data.fingerprint || this._computeFingerprint(data.publicKey);
    this._createdAt = data.createdAt || null;
    console.log(`[identity] Identidade carregada: ${this._fingerprint}`);
  }

  private _save(): void {
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
    }, null, 2), { mode: 0o600 });
  }

  private _computeFingerprint(publicKeyBase64: string): string {
    return crypto.createHash('sha256')
      .update(Buffer.from(publicKeyBase64, 'base64'))
      .digest('hex')
      .slice(0, 16);
  }
}
