'use strict';

const Transport = require('./base');

/**
 * EmailTransport — envia/recebe emails via Gmail MCP tools.
 *
 * Usa os MCP tools do Gmail (gmail_create_draft, gmail_search_messages, etc.)
 * disponíveis via gateway ou diretamente.
 *
 * Config:
 *   - callGmailTool: função (toolName, args) => result
 *   - defaultTo: email padrão para broadcast
 *   - autoSend: se true, envia direto; se false, cria draft (default: false)
 */
class EmailTransport extends Transport {
  constructor(config = {}) {
    super('email', { enabled: true, priority: 3, ...config });
    this._callGmailTool = config.callGmailTool || null;
    this._defaultTo = config.defaultTo || process.env.EMAIL_DEFAULT_TO || '';
    this._autoSend = config.autoSend ?? (process.env.EMAIL_AUTO_SEND === 'true');
    this._fromName = config.fromName || process.env.EMAIL_FROM_NAME || 'Tulipa Agent';

    if (!this._callGmailTool) {
      this._markAvailable(false);
    }
  }

  get configured() {
    return !!this._callGmailTool;
  }

  async send(destination, message) {
    if (!this.configured) throw new Error('Email não configurado (sem callGmailTool)');

    try {
      const to = destination || this._defaultTo;
      if (!to) throw new Error('Sem destinatário (envie email ou configure EMAIL_DEFAULT_TO)');

      const { subject, body } = this._formatMessage(message);

      const result = await this._callGmailTool('gmail_create_draft', {
        to,
        subject,
        body,
      });

      this._countSent();
      this._markAvailable(true);
      this.emit('sent', { destination: to, subject, draft: !this._autoSend });
      return { ok: true, to, subject, draft: !this._autoSend, result };
    } catch (err) {
      this._countError();
      this.emit('error', err);
      throw err;
    }
  }

  async receive(source, options = {}) {
    if (!this.configured) throw new Error('Email não configurado');

    try {
      const query = source
        ? `from:${source}`
        : options.query || 'is:unread';

      const maxResults = options.limit || 10;

      const result = await this._callGmailTool('gmail_search_messages', {
        query,
        max_results: maxResults,
      });

      this._countReceived();
      this._markAvailable(true);
      return this._parseSearchResult(result);
    } catch (err) {
      this._countError();
      throw err;
    }
  }

  async healthCheck() {
    if (!this.configured) {
      return { ok: false, channel: 'email', error: 'Não configurado (sem callGmailTool)' };
    }
    try {
      const profile = await this._callGmailTool('gmail_get_profile', {});
      this._markAvailable(true);
      return { ok: true, channel: 'email', profile };
    } catch (err) {
      this._markAvailable(false);
      return { ok: false, channel: 'email', error: err.message };
    }
  }

  async broadcast(message) {
    if (!this._defaultTo) {
      return [{ to: null, ok: false, error: 'Sem EMAIL_DEFAULT_TO configurado' }];
    }
    try {
      const r = await this.send(this._defaultTo, message);
      return [{ to: this._defaultTo, ok: true, result: r }];
    } catch (err) {
      return [{ to: this._defaultTo, ok: false, error: err.message }];
    }
  }

  /**
   * Lê um email específico por ID.
   */
  async readMessage(messageId) {
    if (!this.configured) throw new Error('Email não configurado');
    return this._callGmailTool('gmail_read_message', { message_id: messageId });
  }

  /**
   * Lista drafts pendentes.
   */
  async listDrafts() {
    if (!this.configured) throw new Error('Email não configurado');
    return this._callGmailTool('gmail_list_drafts', {});
  }

  _formatMessage(message) {
    if (typeof message === 'object' && message.subject) {
      return {
        subject: message.subject,
        body: message.body || message.text || JSON.stringify(message, null, 2),
      };
    }

    const text = typeof message === 'string' ? message : JSON.stringify(message, null, 2);

    // Primeira linha como subject, resto como body
    const lines = text.split('\n');
    const subject = lines[0].length > 100
      ? `[Tulipa] ${lines[0].slice(0, 97)}...`
      : `[Tulipa] ${lines[0]}`;
    const body = lines.length > 1 ? lines.slice(1).join('\n').trim() : text;

    return { subject, body: body || text };
  }

  _parseSearchResult(result) {
    if (Array.isArray(result)) return result;
    if (typeof result === 'string') {
      try { return JSON.parse(result); } catch { return []; }
    }
    if (result?.messages) return result.messages;
    if (result?.content) {
      try {
        const text = typeof result.content === 'string'
          ? result.content
          : result.content[0]?.text || '';
        return JSON.parse(text);
      } catch { return []; }
    }
    return [];
  }

  toJSON() {
    return {
      ...super.toJSON(),
      configured: this.configured,
      defaultTo: this._defaultTo ? `***${this._defaultTo.split('@')[0].slice(-3)}@${this._defaultTo.split('@')[1] || ''}` : null,
      autoSend: this._autoSend,
    };
  }
}

module.exports = EmailTransport;
