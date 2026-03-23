'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Transport = require('../lib/transport/base');
const WhatsAppTransport = require('../lib/transport/whatsapp');
const TelegramTransport = require('../lib/transport/telegram');
const EmailTransport = require('../lib/transport/email');
const WebhookTransport = require('../lib/transport/webhook');

describe('Transport base', () => {
  it('não permite instanciar diretamente', () => {
    assert.throws(() => new Transport('test'), /classe abstrata/);
  });
});

describe('WhatsAppTransport', () => {
  it('inicializa com nome e prioridade', () => {
    const wa = new WhatsAppTransport({ callMcpTool: async () => ({}), priority: 1 });
    assert.equal(wa.name, 'whatsapp');
    assert.equal(wa.priority, 1);
  });

  it('toJSON inclui name e stats', () => {
    const wa = new WhatsAppTransport({ callMcpTool: async () => ({}) });
    const json = wa.toJSON();
    assert.equal(json.name, 'whatsapp');
    assert.ok('stats' in json);
  });
});

describe('TelegramTransport', () => {
  it('não configurado sem token', () => {
    const tg = new TelegramTransport();
    assert.equal(tg.name, 'telegram');
    assert.equal(tg.configured, false);
    assert.equal(tg.available, false);
  });

  it('configurado com token', () => {
    const tg = new TelegramTransport({ botToken: '123:ABC' });
    assert.equal(tg.configured, true);
  });

  it('healthCheck retorna erro se não configurado', async () => {
    const tg = new TelegramTransport();
    const result = await tg.healthCheck();
    assert.equal(result.ok, false);
    assert.ok(result.error.includes('Não configurado'));
  });

  it('send rejeita sem token', async () => {
    const tg = new TelegramTransport();
    await assert.rejects(() => tg.send('123', 'hi'), /não configurado/);
  });

  it('toJSON inclui campos específicos', () => {
    const tg = new TelegramTransport({ botToken: '123:ABC', chatId: '-100999' });
    const json = tg.toJSON();
    assert.equal(json.configured, true);
    assert.ok(json.chatId.startsWith('***'));
    assert.equal(json.polling, false);
  });
});

describe('EmailTransport', () => {
  it('não configurado sem callGmailTool', () => {
    const em = new EmailTransport();
    assert.equal(em.name, 'email');
    assert.equal(em.configured, false);
    assert.equal(em.priority, 3);
  });

  it('configurado com callGmailTool', () => {
    const em = new EmailTransport({ callGmailTool: async () => ({}) });
    assert.equal(em.configured, true);
  });

  it('formata mensagem string em subject + body', () => {
    const em = new EmailTransport({ callGmailTool: async () => ({}) });
    const { subject, body } = em._formatMessage('Linha 1\nLinha 2\nLinha 3');
    assert.ok(subject.includes('[Tulipa]'));
    assert.ok(subject.includes('Linha 1'));
    assert.ok(body.includes('Linha 2'));
  });

  it('formata mensagem objeto com subject', () => {
    const em = new EmailTransport({ callGmailTool: async () => ({}) });
    const { subject, body } = em._formatMessage({ subject: 'Teste', body: 'Conteúdo' });
    assert.equal(subject, 'Teste');
    assert.equal(body, 'Conteúdo');
  });

  it('send cria draft via callGmailTool', async () => {
    let calledWith = null;
    const em = new EmailTransport({
      callGmailTool: async (tool, args) => {
        calledWith = { tool, args };
        return { id: 'draft-1' };
      },
    });

    await em.send('user@test.com', { subject: 'Oi', body: 'Teste' });
    assert.equal(calledWith.tool, 'gmail_create_draft');
    assert.equal(calledWith.args.to, 'user@test.com');
  });

  it('toJSON mascara email', () => {
    const em = new EmailTransport({ defaultTo: 'tulio@test.com' });
    const json = em.toJSON();
    assert.ok(json.defaultTo.includes('***'));
    assert.ok(json.defaultTo.includes('@test.com'));
  });
});

describe('WebhookTransport', () => {
  it('não configurado sem endpoints', () => {
    const wh = new WebhookTransport();
    assert.equal(wh.name, 'webhook');
    assert.equal(wh.configured, false);
    assert.equal(wh.priority, 4);
  });

  it('configurado com endpoints', () => {
    const wh = new WebhookTransport({
      endpoints: { test: { url: 'https://example.com/hook' } },
    });
    assert.equal(wh.configured, true);
    assert.equal(wh._endpoints.size, 1);
  });

  it('addEndpoint rejeita sem url', () => {
    const wh = new WebhookTransport();
    assert.throws(() => wh.addEndpoint('bad', {}), /precisa de url/);
  });

  it('removeEndpoint funciona', () => {
    const wh = new WebhookTransport({
      endpoints: { a: { url: 'https://a.com' }, b: { url: 'https://b.com' } },
    });
    wh.removeEndpoint('a');
    assert.equal(wh._endpoints.size, 1);
  });

  it('formata body para Slack', () => {
    const wh = new WebhookTransport();
    const body = wh._formatBody('hello', { format: 'slack' });
    assert.deepEqual(body, { text: 'hello', unfurl_links: false });
  });

  it('formata body para Discord', () => {
    const wh = new WebhookTransport();
    const body = wh._formatBody('hello', { format: 'discord' });
    assert.deepEqual(body, { content: 'hello' });
  });

  it('formata body JSON com metadata', () => {
    const wh = new WebhookTransport();
    const body = wh._formatBody('hello', { format: 'json' });
    assert.equal(body.message, 'hello');
    assert.equal(body._source, 'tulipa');
    assert.ok(body._timestamp);
  });

  it('formata body JSON de objeto preserva campos', () => {
    const wh = new WebhookTransport();
    const body = wh._formatBody({ key: 'value' }, { format: 'json' });
    assert.equal(body.key, 'value');
    assert.equal(body._source, 'tulipa');
  });

  it('send rejeita endpoint inexistente', async () => {
    const wh = new WebhookTransport({
      endpoints: { a: { url: 'https://a.com' } },
    });
    await assert.rejects(() => wh.send('nonexistent', 'hi'), /não encontrado/);
  });

  it('listEndpoints retorna formato correto', () => {
    const wh = new WebhookTransport({
      endpoints: { slack: { url: 'https://hooks.slack.com/xxx', format: 'slack' } },
    });
    const list = wh.listEndpoints();
    assert.ok(list.slack);
    assert.equal(list.slack.format, 'slack');
    assert.equal(list.slack.method, 'POST');
  });

  it('toJSON inclui endpointCount', () => {
    const wh = new WebhookTransport({
      endpoints: { a: { url: 'https://a.com' }, b: { url: 'https://b.com' } },
    });
    const json = wh.toJSON();
    assert.equal(json.endpointCount, 2);
    assert.equal(json.configured, true);
  });
});
