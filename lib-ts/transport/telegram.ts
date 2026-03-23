// © 2026 Tulio Silva — Tulipa Platform. Proprietary and confidential.

import { Transport } from './transport-base.js';
import type { TransportConfig, TransportJSON } from './transport-base.js';

const TELEGRAM_API = 'https://api.telegram.org/bot';

type FetchFn = typeof globalThis.fetch;

export interface TelegramTransportConfig extends TransportConfig {
  botToken?: string;
  chatId?: string;
  pollInterval?: number;
  fetch?: FetchFn;
}

export interface TelegramMessage {
  id: number;
  chatId: string;
  from: string;
  text: string;
  date: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: {
    chat: { id: number };
    from?: { username?: string; first_name?: string };
    text?: string;
    date: number;
    message_id: number;
  };
}

export interface TelegramTransportJSON extends TransportJSON {
  configured: boolean;
  chatId: string | null;
  polling: boolean;
}

export class TelegramTransport extends Transport {
  private _token: string;
  private _chatId: string;
  private _pollInterval: number;
  private _fetch: FetchFn;
  private _pollTimer: ReturnType<typeof setInterval> | null;
  private _lastUpdateId: number;

  constructor(config: TelegramTransportConfig = {}) {
    super('telegram', { enabled: true, priority: 2, ...config });
    this._token = config.botToken ?? process.env.TELEGRAM_BOT_TOKEN ?? '';
    this._chatId = config.chatId ?? process.env.TELEGRAM_CHAT_ID ?? '';
    this._pollInterval = config.pollInterval ?? 10000;
    this._fetch = config.fetch ?? globalThis.fetch;
    this._pollTimer = null;
    this._lastUpdateId = 0;
    if (!this._token) {
      this._markAvailable(false);
    }
  }

  get configured(): boolean { return !!this._token; }

  private async _api<T = unknown>(method: string, body: Record<string, unknown> = {}): Promise<T> {
    const url = `${TELEGRAM_API}${this._token}/${method}`;
    const res = await this._fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Telegram ${method} falhou (${res.status}): ${text.slice(0, 200)}`);
    }
    const data = await res.json() as { ok: boolean; result: T; description?: string };
    if (!data.ok) {
      throw new Error(`Telegram ${method}: ${data.description ?? 'erro desconhecido'}`);
    }
    return data.result;
  }

  async send(destination: string, message: unknown): Promise<unknown> {
    if (!this.configured) throw new Error('Telegram não configurado (sem botToken)');
    try {
      const chatId = destination || this._chatId;
      if (!chatId) throw new Error('Sem chatId de destino');
      const text = typeof message === 'string' ? message : JSON.stringify(message, null, 2);
      const result = await this._api<{ message_id: number }>('sendMessage', {
        chat_id: chatId,
        text,
        parse_mode: text.startsWith('{') ? undefined : 'Markdown',
      });
      this._countSent();
      this._markAvailable(true);
      this.emit('sent', { destination: chatId, messageId: result.message_id });
      return result;
    } catch (err) {
      this._countError();
      if (!(err as Error).message.includes('chat not found') && !(err as Error).message.includes('400')) {
        this._markAvailable(false);
      }
      this.emit('error', err);
      throw err;
    }
  }

  async receive(source?: string, options: { limit?: number } = {}): Promise<TelegramMessage[]> {
    if (!this.configured) throw new Error('Telegram não configurado');
    const limit = options.limit ?? 20;
    const updates = await this._api<TelegramUpdate[]>('getUpdates', {
      offset: this._lastUpdateId + 1,
      limit,
      timeout: 0,
    });
    if (updates.length > 0) {
      this._lastUpdateId = updates[updates.length - 1].update_id;
      this._countReceived();
      this._markAvailable(true);
    }
    const messages: TelegramMessage[] = updates
      .filter((u): u is TelegramUpdate & { message: NonNullable<TelegramUpdate['message']> } => !!u.message)
      .map(u => ({
        id: u.update_id,
        chatId: String(u.message.chat.id),
        from: u.message.from?.username ?? u.message.from?.first_name ?? 'unknown',
        text: u.message.text ?? '',
        date: new Date(u.message.date * 1000).toISOString(),
      }));
    if (source) {
      return messages.filter(m => m.chatId === String(source));
    }
    return messages;
  }

  async healthCheck(): Promise<{ ok: boolean; channel: string; bot?: string; error?: string }> {
    if (!this.configured) {
      return { ok: false, channel: 'telegram', error: 'Não configurado (sem botToken)' };
    }
    try {
      const me = await this._api<{ username: string }>('getMe');
      this._markAvailable(true);
      return { ok: true, channel: 'telegram', bot: me.username };
    } catch (err) {
      this._markAvailable(false);
      return { ok: false, channel: 'telegram', error: (err as Error).message };
    }
  }

  async broadcast(message: unknown): Promise<Array<{ chatId: string | null; ok: boolean; result?: unknown; error?: string }>> {
    if (!this._chatId) {
      return [{ chatId: null, ok: false, error: 'Sem TELEGRAM_CHAT_ID configurado' }];
    }
    try {
      const r = await this.send(this._chatId, message);
      return [{ chatId: this._chatId, ok: true, result: r }];
    } catch (err) {
      return [{ chatId: this._chatId, ok: false, error: (err as Error).message }];
    }
  }

  startPolling(callback?: (msg: TelegramMessage) => void): void {
    if (!this.configured || this._pollTimer) return;
    console.log(`[telegram] Polling ativo a cada ${this._pollInterval / 1000}s`);
    this._pollTimer = setInterval(async () => {
      try {
        const messages = await this.receive();
        for (const msg of messages) {
          this.emit('message', msg);
          if (callback) callback(msg);
        }
      } catch (err) {
        console.error(`[telegram] Erro no polling: ${(err as Error).message}`);
      }
    }, this._pollInterval);
  }

  stopPolling(): void {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  toJSON(): TelegramTransportJSON {
    return {
      ...super.toJSON(),
      configured: this.configured,
      chatId: this._chatId ? `***${this._chatId.slice(-4)}` : null,
      polling: !!this._pollTimer,
    };
  }
}

export default TelegramTransport;
