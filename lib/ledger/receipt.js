'use strict';

const crypto = require('node:crypto');

/**
 * TaskReceipt — recibo verificável de tarefa executada entre dois agentes.
 *
 * Fluxo:
 *   1. Agente A delega task para agente B
 *   2. B executa e retorna resultado
 *   3. A cria receipt com hash do resultado e assina (fromSignature)
 *   4. B verifica e contra-assina (toSignature)
 *   5. Ambos armazenam no ledger local
 *
 * Verificação:
 *   Qualquer nó com as public keys de A e B pode verificar ambas assinaturas.
 */

/**
 * Gera o hash canônico do receipt (SHA-256).
 * Campos usados: from + to + taskId + skill + resultHash + timestamp
 */
function computeReceiptHash(fields) {
  const { from, to, taskId, skill, resultHash, timestamp } = fields;
  const canonical = [from, to, taskId, skill, resultHash, timestamp].join('|');
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

/**
 * Gera o hash SHA-256 de um resultado (para resultHash).
 */
function hashResult(result) {
  const data = typeof result === 'string' ? result : JSON.stringify(result);
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Cria um TaskReceipt (sem assinaturas — elas são adicionadas depois).
 *
 * @param {object} params
 * @param {string} params.taskId - ID da tarefa
 * @param {string} params.from - agent ID de quem pediu
 * @param {string} params.to - agent ID de quem executou
 * @param {string} params.skill - skill usada (ex: "chat", "code-execution")
 * @param {*} params.result - resultado da tarefa (será hasheado)
 * @param {object} [params.resourceUsed] - recursos consumidos
 * @returns {object} TaskReceipt sem assinaturas
 */
function createReceipt(params) {
  const { taskId, from, to, skill, result, resourceUsed } = params;

  const timestamp = new Date().toISOString();
  const resultHash = hashResult(result);
  const hash = computeReceiptHash({ from, to, taskId, skill, resultHash, timestamp });
  const id = `rcpt_${hash.slice(0, 16)}`;

  return {
    id,
    taskId,
    from,
    to,
    skill,
    resultHash,
    resourceUsed: {
      durationMs: resourceUsed?.durationMs || 0,
      cpuSeconds: resourceUsed?.cpuSeconds || undefined,
      memoryMB: resourceUsed?.memoryMB || undefined,
      diskMB: resourceUsed?.diskMB || undefined,
    },
    timestamp,
    hash,
    fromSignature: null,
    toSignature: null,
  };
}

/**
 * Assina o receipt hash com uma chave privada Ed25519.
 * Compatível com o signChallenge() do identity.ts do Tulipa.
 *
 * @param {string} receiptHash - hash hex do receipt
 * @param {string} privateKeyBase64 - chave privada Ed25519 (base64, PKCS8 DER)
 * @returns {string} assinatura base64
 */
function signReceipt(receiptHash, privateKeyBase64) {
  const privKey = crypto.createPrivateKey({
    key: Buffer.from(privateKeyBase64, 'base64'),
    format: 'der',
    type: 'pkcs8',
  });
  const signature = crypto.sign(null, Buffer.from(receiptHash, 'hex'), privKey);
  return signature.toString('base64');
}

/**
 * Verifica a assinatura de um receipt.
 *
 * @param {string} receiptHash - hash hex do receipt
 * @param {string} signatureBase64 - assinatura base64
 * @param {string} publicKeyBase64 - chave pública Ed25519 (base64, SPKI DER)
 * @returns {boolean}
 */
function verifySignature(receiptHash, signatureBase64, publicKeyBase64) {
  try {
    const pubKey = crypto.createPublicKey({
      key: Buffer.from(publicKeyBase64, 'base64'),
      format: 'der',
      type: 'spki',
    });
    return crypto.verify(
      null,
      Buffer.from(receiptHash, 'hex'),
      pubKey,
      Buffer.from(signatureBase64, 'base64'),
    );
  } catch {
    return false;
  }
}

/**
 * Verifica se um receipt é válido:
 *   1. Hash bate com os campos
 *   2. fromSignature é válida (se fornecida)
 *   3. toSignature é válida (se fornecida)
 *
 * @param {object} receipt - TaskReceipt completo
 * @param {object} [keys] - { fromPublicKey, toPublicKey } (base64)
 * @returns {object} { valid, errors[] }
 */
function verifyReceipt(receipt, keys = {}) {
  const errors = [];

  // 1. Verificar hash
  const expectedHash = computeReceiptHash({
    from: receipt.from,
    to: receipt.to,
    taskId: receipt.taskId,
    skill: receipt.skill,
    resultHash: receipt.resultHash,
    timestamp: receipt.timestamp,
  });

  if (expectedHash !== receipt.hash) {
    errors.push('Hash inválido — campos foram alterados');
  }

  // 2. Verificar fromSignature
  if (receipt.fromSignature && keys.fromPublicKey) {
    if (!verifySignature(receipt.hash, receipt.fromSignature, keys.fromPublicKey)) {
      errors.push('fromSignature inválida');
    }
  }

  // 3. Verificar toSignature
  if (receipt.toSignature && keys.toPublicKey) {
    if (!verifySignature(receipt.hash, receipt.toSignature, keys.toPublicKey)) {
      errors.push('toSignature inválida');
    }
  }

  // 4. Verificar se tem pelo menos uma assinatura
  if (!receipt.fromSignature && !receipt.toSignature) {
    errors.push('Nenhuma assinatura presente');
  }

  return { valid: errors.length === 0, errors, dualSigned: !!(receipt.fromSignature && receipt.toSignature) };
}

module.exports = {
  createReceipt,
  signReceipt,
  verifySignature,
  verifyReceipt,
  computeReceiptHash,
  hashResult,
};
