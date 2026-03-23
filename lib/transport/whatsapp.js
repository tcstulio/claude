'use strict';

const Transport = require('./base');

class WhatsAppTransport extends Transport {
  /**
   * @param {object} config
   * @param {function} config.callMcpTool - função (tool, args, req?) => Promise<data>
   * @param {string[]} config.groups - números dos grupos WhatsApp
   * @param {number} config.priority - prioridade do canal (menor = preferido)
   */
  constructor(config = {}) {
    super('whatsapp', { enabled: true, priority: 1, ...config });
    this._callMcp = config.callMcpTool;
    if (!this._callMcp) {
      throw new Error('WhatsAppTransport requer config.callMcpTool');
    }
    this._groups = config.groups || [];
  }

  async send(destination, message) {
    try {
      const text = typeof message === 'string' ? message : JSON.stringify(message);
      const result = await this._callMcp('send_whatsapp', {
        phone: destination,
        message: text,
      });
      this._countSent();
      this._markAvailable(true);
      this.emit('sent', { destination, message });
      return result;
    } catch (err) {
      this._countError();
      this._markAvailable(false);
      this.emit('error', err);
      throw err;
    }
  }

  async receive(source, options = {}) {
    try {
      const args = {};
      if (source) args.phone = source;
      if (options.limit) args.limit = options.limit;

      const result = await this._callMcp('get_whatsapp_history', args);
      this._countReceived();
      this._markAvailable(true);
      return result;
    } catch (err) {
      this._countError();
      this._markAvailable(false);
      throw err;
    }
  }

  async healthCheck() {
    try {
      // Usa get_status como proxy — se o gateway responde, WhatsApp está acessível
      await this._callMcp('get_status', {});
      this._markAvailable(true);
      return { ok: true, channel: 'whatsapp' };
    } catch (err) {
      this._markAvailable(false);
      return { ok: false, channel: 'whatsapp', error: err.message };
    }
  }

  async broadcast(message) {
    const results = [];
    for (const group of this._groups) {
      try {
        const r = await this.send(group, message);
        results.push({ group, ok: true, result: r });
      } catch (err) {
        results.push({ group, ok: false, error: err.message });
      }
    }
    return results;
  }
}

module.exports = WhatsAppTransport;
