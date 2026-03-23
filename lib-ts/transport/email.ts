// © 2026 Tulio Silva — Tulipa Platform. Proprietary and confidential.

import { Transport } from './transport-base.js';
import type { TransportConfig, TransportJSON } from './transport-base.js';

type GmailToolCaller = (toolName: string, args: Record<string, unknown>) => Promise<unknown>;

export interface EmailTransportConfig extends TransportConfig {
  callGmailTool?: GmailToolCaller | null;
  defaultTo?: string;
  autoSend?: boolean;
  fromName?: string;
}

interface FormattedMessage {
  subject: string;
  body: string;
}

interface MessageWithSubject {
  subject: string;
  body?: string;
  text?: string;
  [key: string]: unknown;
}

interface SearchResultWithContent {
  messages?: unknown[];
  content?: string | Array<{ text?: string }>;
}

export interface EmailTransportJSON extends TransportJSON {
  configured: boolean;
  defaultTo: string | null;
  autoSend: boolean;
}

export class EmailTransport extends Transport {
  private _callGmailTool: GmailToolCaller | null;
  private _defaultTo: string;
  private _autoSend: boolean;
  private _fromName: string;

  constructor(config: EmailTransportConfig = {}) {
    super('email', { enabled: true, priority: 3, ...config });
    this._callGmailTool = config.callGmailTool ?? null;
    this._defaultTo = config.defaultTo ?? process.env.EMAIL_DEFAULT_TO ?? '';
    this._autoSend = config.autoSend ?? (process.env.EMAIL_AUTO_SEND === 'true');
    this._fromName = config.fromName ?? process.env.EMAIL_FROM_NAME ?? 'Tulipa Agent';
    if (!this._callGmailTool) {
      this._markAvailable(false);
    }
  }

  get configured(): boolean { return !!this._callGmailTool; }

  async send(destination: string, message: unknown): Promise<{ ok: boolean; to: string; subject: string; draft: boolean; result: unknown }> {
    if (!this.configured) throw new Error('Email não configurado (sem callGmailTool)');
    try {
      const to = destination || this._defaultTo;
      if (!to) throw new Error('Sem destinatário (envie email ou configure EMAIL_DEFAULT_TO)');
      const { subject, body } = this._formatMessage(message);
      const result = await this._callGmailTool!('gmail_create_draft', { to, subject, body });
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

  async receive(source: string, options: { limit?: number; query?: string } = {}): Promise<unknown[]> {
    if (!this.configured) throw new Error('Email não configurado');
    try {
      const query = source ? `from:${source}` : options.query ?? 'is:unread';
      const maxResults = options.limit ?? 10;
      const result = await this._callGmailTool!('gmail_search_messages', { query, max_results: maxResults });
      this._countReceived();
      this._markAvailable(true);
      return this._parseSearchResult(result);
    } catch (err) {
      this._countError();
      throw err;
    }
  }

  async healthCheck(): Promise<{ ok: boolean; channel: string; profile?: unknown; error?: string }> {
    if (!this.configured) {
      return { ok: false, channel: 'email', error: 'Não configurado (sem callGmailTool)' };
    }
    try {
      const profile = await this._callGmailTool!('gmail_get_profile', {});
      this._markAvailable(true);
      return { ok: true, channel: 'email', profile };
    } catch (err) {
      this._markAvailable(false);
      return { ok: false, channel: 'email', error: (err as Error).message };
    }
  }

  async broadcast(message: unknown): Promise<Array<{ to: string | null; ok: boolean; result?: unknown; error?: string }>> {
    if (!this._defaultTo) {
      return [{ to: null, ok: false, error: 'Sem EMAIL_DEFAULT_TO configurado' }];
    }
    try {
      const r = await this.send(this._defaultTo, message);
      return [{ to: this._defaultTo, ok: true, result: r }];
    } catch (err) {
      return [{ to: this._defaultTo, ok: false, error: (err as Error).message }];
    }
  }

  async readMessage(messageId: string): Promise<unknown> {
    if (!this.configured) throw new Error('Email não configurado');
    return this._callGmailTool!('gmail_read_message', { message_id: messageId });
  }

  async listDrafts(): Promise<unknown> {
    if (!this.configured) throw new Error('Email não configurado');
    return this._callGmailTool!('gmail_list_drafts', {});
  }

  private _formatMessage(message: unknown): FormattedMessage {
    if (typeof message === 'object' && message !== null && (message as MessageWithSubject).subject) {
      const msg = message as MessageWithSubject;
      return {
        subject: msg.subject,
        body: msg.body ?? msg.text ?? JSON.stringify(message, null, 2),
      };
    }
    const text = typeof message === 'string' ? message : JSON.stringify(message, null, 2);
    const lines = text.split('\n');
    const subject = lines[0].length > 100
      ? `[Tulipa] ${lines[0].slice(0, 97)}...`
      : `[Tulipa] ${lines[0]}`;
    const body = lines.length > 1 ? lines.slice(1).join('\n').trim() : text;
    return { subject, body: body || text };
  }

  private _parseSearchResult(result: unknown): unknown[] {
    if (Array.isArray(result)) return result;
    if (typeof result === 'string') {
      try { return JSON.parse(result); } catch { return []; }
    }
    if (result && typeof result === 'object') {
      const r = result as SearchResultWithContent;
      if (r.messages) return r.messages;
      if (r.content) {
        try {
          const text = typeof r.content === 'string'
            ? r.content
            : r.content[0]?.text ?? '';
          return JSON.parse(text);
        } catch { return []; }
      }
    }
    return [];
  }

  toJSON(): EmailTransportJSON {
    return {
      ...super.toJSON(),
      configured: this.configured,
      defaultTo: this._defaultTo ? `***${this._defaultTo.split('@')[0].slice(-3)}@${this._defaultTo.split('@')[1] ?? ''}` : null,
      autoSend: this._autoSend,
    };
  }
}

export default EmailTransport;
