'use strict';

const Transport = require('./base');

const TELEGRAM_API = 'https://api.telegram.org/bot';

class TelegramTransport extends Transport {
  /**
   * @param {object} config
   * @param {string} config.botToken - token do bot (@BotFather)
   * @param {string} config.chatId - chat/grupo padrão para broadcast
   * @param {number} config.pollInterval - intervalo de polling em ms (default 10s)
   * @param {function} config.fetch - fetch customizado (opcional, para proxy)
   */
  constructor(config = {}) {
    super('telegram', { enabled: true, priority: 2, ...config });
    this._token = config.botToken || process.env.TELEGRAM_BOT_TOKEN || '';
    this._chatId = config.chatId || process.env.TELEGRAM_CHAT_ID || '';
    this._pollInterval = config.pollInterval || 10000;
    this._fetch = config.fetch || globalThis.fetch;
    this._pollTimer = null;
    this._lastUpdateId = 0;

    if (!this._token) {
      this._markAvailable(false);
    }
  }

  get configured() {
    return !!this._token;
  }

  async _api(method, body = {}) {
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

    const data = await res.json();
    if (!data.ok) {
      throw new Error(`Telegram ${method}: ${data.description || 'erro desconhecido'}`);
    }
    return data.result;
  }

  async send(destination, message) {
    if (!this.configured) throw new Error('Telegram não configurado (sem botToken)');

    try {
      const chatId = destination || this._chatId;
      if (!chatId) throw new Error('Sem chatId de destino');

      const text = typeof message === 'string' ? message : JSON.stringify(message, null, 2);

      const result = await this._api('sendMessage', {
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
      // Só marca indisponível se for erro de rede, não de input
      if (!err.message.includes('chat not found') && !err.message.includes('400')) {
        this._markAvailable(false);
      }
      this.emit('error', err);
      throw err;
    }
  }

  async receive(source, options = {}) {
    if (!this.configured) throw new Error('Telegram não configurado');

    const limit = options.limit || 20;
    const updates = await this._api('getUpdates', {
      offset: this._lastUpdateId + 1,
      limit,
      timeout: 0,
    });

    if (updates.length > 0) {
      this._lastUpdateId = updates[updates.length - 1].update_id;
      this._countReceived();
      this._markAvailable(true);
    }

    // Filtra por source (chatId) se fornecido
    const messages = updates
      .filter(u => u.message)
      .map(u => ({
        id: u.update_id,
        chatId: String(u.message.chat.id),
        from: u.message.from?.username || u.message.from?.first_name || 'unknown',
        text: u.message.text || '',
        date: new Date(u.message.date * 1000).toISOString(),
      }));

    if (source) {
      return messages.filter(m => m.chatId === String(source));
    }
    return messages;
  }

  async healthCheck() {
    if (!this.configured) {
      return { ok: false, channel: 'telegram', error: 'Não configurado (sem botToken)' };
    }
    try {
      const me = await this._api('getMe');
      this._markAvailable(true);
      return { ok: true, channel: 'telegram', bot: me.username };
    } catch (err) {
      this._markAvailable(false);
      return { ok: false, channel: 'telegram', error: err.message };
    }
  }

  async broadcast(message) {
    if (!this._chatId) {
      return [{ chatId: null, ok: false, error: 'Sem TELEGRAM_CHAT_ID configurado' }];
    }
    try {
      const r = await this.send(this._chatId, message);
      return [{ chatId: this._chatId, ok: true, result: r }];
    } catch (err) {
      return [{ chatId: this._chatId, ok: false, error: err.message }];
    }
  }

  // Polling de mensagens novas
  startPolling(callback) {
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
        console.error(`[telegram] Erro no polling: ${err.message}`);
      }
    }, this._pollInterval);
  }

  stopPolling() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  toJSON() {
    return {
      ...super.toJSON(),
      configured: this.configured,
      chatId: this._chatId ? `***${this._chatId.slice(-4)}` : null,
      polling: !!this._pollTimer,
    };
  }
}

module.exports = TelegramTransport;
