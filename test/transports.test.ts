// © 2026 Tulio Silva — Tulipa Platform. Proprietary and confidential.

import { describe, it, expect } from 'vitest';
import Transport from '../lib-ts/transport/base.js';
import WhatsAppTransport from '../lib-ts/transport/whatsapp.js';
import TelegramTransport from '../lib-ts/transport/telegram.js';
import EmailTransport from '../lib-ts/transport/email.js';
import WebhookTransport from '../lib-ts/transport/webhook.js';

describe('Transport base', () => {
  it('não permite instanciar diretamente', () => {
    expect(() => new (Transport as any)('test')).toThrow(/classe abstrata/);
  });
});

describe('WhatsAppTransport', () => {
  it('inicializa com nome e prioridade', () => {
    const wa = new WhatsAppTransport({ callMcpTool: async () => ({}), priority: 1 });
    expect(wa.name).toBe('whatsapp');
    expect(wa.priority).toBe(1);
  });

  it('toJSON inclui name e stats', () => {
    const wa = new WhatsAppTransport({ callMcpTool: async () => ({}) });
    const json = wa.toJSON();
    expect(json.name).toBe('whatsapp');
    expect('stats' in json).toBeTruthy();
  });
});

describe('TelegramTransport', () => {
  it('não configurado sem token', () => {
    const tg = new TelegramTransport();
    expect(tg.name).toBe('telegram');
    expect(tg.configured).toBe(false);
    expect(tg.available).toBe(false);
  });

  it('configurado com token', () => {
    const tg = new TelegramTransport({ botToken: '123:ABC' });
    expect(tg.configured).toBe(true);
  });

  it('healthCheck retorna erro se não configurado', async () => {
    const tg = new TelegramTransport();
    const result = await tg.healthCheck();
    expect(result.ok).toBe(false);
    expect(result.error.includes('Não configurado')).toBeTruthy();
  });

  it('send rejeita sem token', async () => {
    const tg = new TelegramTransport();
    await expect(() => tg.send('123', 'hi')).rejects.toThrow(/não configurado/);
  });

  it('toJSON inclui campos específicos', () => {
    const tg = new TelegramTransport({ botToken: '123:ABC', chatId: '-100999' });
    const json = tg.toJSON();
    expect(json.configured).toBe(true);
    expect(json.chatId.startsWith('***')).toBeTruthy();
    expect(json.polling).toBe(false);
  });
});

describe('EmailTransport', () => {
  it('não configurado sem callGmailTool', () => {
    const em = new EmailTransport();
    expect(em.name).toBe('email');
    expect(em.configured).toBe(false);
    expect(em.priority).toBe(3);
  });

  it('configurado com callGmailTool', () => {
    const em = new EmailTransport({ callGmailTool: async () => ({}) });
    expect(em.configured).toBe(true);
  });

  it('formata mensagem string em subject + body', () => {
    const em = new EmailTransport({ callGmailTool: async () => ({}) });
    const { subject, body } = (em as any)._formatMessage('Linha 1\nLinha 2\nLinha 3');
    expect(subject.includes('[Tulipa]')).toBeTruthy();
    expect(subject.includes('Linha 1')).toBeTruthy();
    expect(body.includes('Linha 2')).toBeTruthy();
  });

  it('formata mensagem objeto com subject', () => {
    const em = new EmailTransport({ callGmailTool: async () => ({}) });
    const { subject, body } = (em as any)._formatMessage({ subject: 'Teste', body: 'Conteúdo' });
    expect(subject).toBe('Teste');
    expect(body).toBe('Conteúdo');
  });

  it('send cria draft via callGmailTool', async () => {
    let calledWith: any = null;
    const em = new EmailTransport({
      callGmailTool: async (tool: string, args: any) => {
        calledWith = { tool, args };
        return { id: 'draft-1' };
      },
    });

    await em.send('user@test.com', { subject: 'Oi', body: 'Teste' });
    expect(calledWith.tool).toBe('gmail_create_draft');
    expect(calledWith.args.to).toBe('user@test.com');
  });

  it('toJSON mascara email', () => {
    const em = new EmailTransport({ defaultTo: 'tulio@test.com' });
    const json = em.toJSON();
    expect(json.defaultTo.includes('***')).toBeTruthy();
    expect(json.defaultTo.includes('@test.com')).toBeTruthy();
  });
});

describe('WebhookTransport', () => {
  it('não configurado sem endpoints', () => {
    const wh = new WebhookTransport();
    expect(wh.name).toBe('webhook');
    expect(wh.configured).toBe(false);
    expect(wh.priority).toBe(4);
  });

  it('configurado com endpoints', () => {
    const wh = new WebhookTransport({
      endpoints: { test: { url: 'https://example.com/hook' } },
    });
    expect(wh.configured).toBe(true);
    expect((wh as any)._endpoints.size).toBe(1);
  });

  it('addEndpoint rejeita sem url', () => {
    const wh = new WebhookTransport();
    expect(() => (wh as any).addEndpoint('bad', {})).toThrow(/precisa de url/);
  });

  it('removeEndpoint funciona', () => {
    const wh = new WebhookTransport({
      endpoints: { a: { url: 'https://a.com' }, b: { url: 'https://b.com' } },
    });
    (wh as any).removeEndpoint('a');
    expect((wh as any)._endpoints.size).toBe(1);
  });

  it('formata body para Slack', () => {
    const wh = new WebhookTransport();
    const body = (wh as any)._formatBody('hello', { format: 'slack' });
    expect(body).toEqual({ text: 'hello', unfurl_links: false });
  });

  it('formata body para Discord', () => {
    const wh = new WebhookTransport();
    const body = (wh as any)._formatBody('hello', { format: 'discord' });
    expect(body).toEqual({ content: 'hello' });
  });

  it('formata body JSON com metadata', () => {
    const wh = new WebhookTransport();
    const body = (wh as any)._formatBody('hello', { format: 'json' });
    expect(body.message).toBe('hello');
    expect(body._source).toBe('tulipa');
    expect(body._timestamp).toBeTruthy();
  });

  it('formata body JSON de objeto preserva campos', () => {
    const wh = new WebhookTransport();
    const body = (wh as any)._formatBody({ key: 'value' }, { format: 'json' });
    expect(body.key).toBe('value');
    expect(body._source).toBe('tulipa');
  });

  it('send rejeita endpoint inexistente', async () => {
    const wh = new WebhookTransport({
      endpoints: { a: { url: 'https://a.com' } },
    });
    await expect(() => wh.send('nonexistent', 'hi')).rejects.toThrow(/não encontrado/);
  });

  it('listEndpoints retorna formato correto', () => {
    const wh = new WebhookTransport({
      endpoints: { slack: { url: 'https://hooks.slack.com/xxx', format: 'slack' } },
    });
    const list = (wh as any).listEndpoints();
    expect(list.slack).toBeTruthy();
    expect(list.slack.format).toBe('slack');
    expect(list.slack.method).toBe('POST');
  });

  it('toJSON inclui endpointCount', () => {
    const wh = new WebhookTransport({
      endpoints: { a: { url: 'https://a.com' }, b: { url: 'https://b.com' } },
    });
    const json = wh.toJSON();
    expect(json.endpointCount).toBe(2);
    expect(json.configured).toBe(true);
  });
});
