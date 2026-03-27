// © 2026 Tulio Silva — Tulipa Platform. Proprietary and confidential.
// TaskReceipt — verifiable receipt for tasks executed between agents.

import crypto from "node:crypto";

export interface ResourceUsed {
  durationMs: number;
  cpuSeconds?: number;
  memoryMB?: number;
  diskMB?: number;
}

export interface TaskReceipt {
  id: string;
  taskId: string;
  from: string;
  to: string;
  skill: string;
  resultHash: string;
  resourceUsed: ResourceUsed;
  timestamp: string;
  hash: string;
  fromSignature: string | null;
  toSignature: string | null;
}

export interface ReceiptVerification {
  valid: boolean;
  errors: string[];
  dualSigned: boolean;
}

export function computeReceiptHash(fields: {
  from: string;
  to: string;
  taskId: string;
  skill: string;
  resultHash: string;
  timestamp: string;
}): string {
  const canonical = [fields.from, fields.to, fields.taskId, fields.skill, fields.resultHash, fields.timestamp].join("|");
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

export function hashResult(result: unknown): string {
  const data = typeof result === "string" ? result : JSON.stringify(result);
  return crypto.createHash("sha256").update(data).digest("hex");
}

export function createReceipt(params: {
  taskId: string;
  from: string;
  to: string;
  skill: string;
  result: unknown;
  resourceUsed?: Partial<ResourceUsed>;
}): TaskReceipt {
  const { taskId, from, to, skill, result, resourceUsed } = params;
  const timestamp = new Date().toISOString();
  const resultH = hashResult(result);
  const hash = computeReceiptHash({ from, to, taskId, skill, resultHash: resultH, timestamp });
  const id = `rcpt_${hash.slice(0, 16)}`;

  return {
    id,
    taskId,
    from,
    to,
    skill,
    resultHash: resultH,
    resourceUsed: {
      durationMs: resourceUsed?.durationMs ?? 0,
      cpuSeconds: resourceUsed?.cpuSeconds,
      memoryMB: resourceUsed?.memoryMB,
      diskMB: resourceUsed?.diskMB,
    },
    timestamp,
    hash,
    fromSignature: null,
    toSignature: null,
  };
}

export function signReceipt(receiptHash: string, privateKeyBase64: string): string {
  const privKey = crypto.createPrivateKey({
    key: Buffer.from(privateKeyBase64, "base64"),
    format: "der",
    type: "pkcs8",
  });
  const signature = crypto.sign(null, Buffer.from(receiptHash, "hex"), privKey);
  return signature.toString("base64");
}

export function verifySignature(receiptHash: string, signatureBase64: string, publicKeyBase64: string): boolean {
  try {
    const pubKey = crypto.createPublicKey({
      key: Buffer.from(publicKeyBase64, "base64"),
      format: "der",
      type: "spki",
    });
    return crypto.verify(null, Buffer.from(receiptHash, "hex"), pubKey, Buffer.from(signatureBase64, "base64"));
  } catch {
    return false;
  }
}

export function verifyReceipt(receipt: TaskReceipt, keys: { fromPublicKey?: string; toPublicKey?: string } = {}): ReceiptVerification {
  const errors: string[] = [];

  const expectedHash = computeReceiptHash({
    from: receipt.from,
    to: receipt.to,
    taskId: receipt.taskId,
    skill: receipt.skill,
    resultHash: receipt.resultHash,
    timestamp: receipt.timestamp,
  });

  if (expectedHash !== receipt.hash) {
    errors.push("Hash inválido — campos foram alterados");
  }

  if (receipt.fromSignature && keys.fromPublicKey) {
    if (!verifySignature(receipt.hash, receipt.fromSignature, keys.fromPublicKey)) {
      errors.push("fromSignature inválida");
    }
  }

  if (receipt.toSignature && keys.toPublicKey) {
    if (!verifySignature(receipt.hash, receipt.toSignature, keys.toPublicKey)) {
      errors.push("toSignature inválida");
    }
  }

  if (!receipt.fromSignature && !receipt.toSignature) {
    errors.push("Nenhuma assinatura presente");
  }

  return {
    valid: errors.length === 0,
    errors,
    dualSigned: !!(receipt.fromSignature && receipt.toSignature),
  };
}
