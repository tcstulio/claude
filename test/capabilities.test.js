'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const caps = require('../lib/capabilities');

describe('Capabilities', () => {
  describe('classify', () => {
    it('classifica capabilities de infra', () => {
      assert.equal(caps.classify('chat'), 'infra');
      assert.equal(caps.classify('compute'), 'infra');
      assert.equal(caps.classify('proxmox-vm'), 'infra');
      assert.equal(caps.classify('deploy'), 'infra');
      assert.equal(caps.classify('relay'), 'infra');
    });

    it('classifica capabilities private', () => {
      assert.equal(caps.classify('whatsapp'), 'private');
      assert.equal(caps.classify('email'), 'private');
      assert.equal(caps.classify('calendar'), 'private');
      assert.equal(caps.classify('credentials'), 'private');
      assert.equal(caps.classify('financial'), 'private');
    });

    it('desconhecidas são private por padrão (seguro)', () => {
      assert.equal(caps.classify('unknown-thing'), 'private');
      assert.equal(caps.classify('my-secret-data'), 'private');
    });
  });

  describe('requiredScope', () => {
    it('infra retorna null (sem scope necessário)', () => {
      assert.equal(caps.requiredScope('chat'), null);
      assert.equal(caps.requiredScope('compute'), null);
    });

    it('private retorna scope correto', () => {
      assert.equal(caps.requiredScope('whatsapp'), 'messaging');
      assert.equal(caps.requiredScope('telegram'), 'messaging');
      assert.equal(caps.requiredScope('email'), 'messaging');
      assert.equal(caps.requiredScope('calendar'), 'personal');
      assert.equal(caps.requiredScope('contacts'), 'personal');
      assert.equal(caps.requiredScope('credentials'), 'credentials');
      assert.equal(caps.requiredScope('financial'), 'financial');
      assert.equal(caps.requiredScope('documents'), 'documents');
    });

    it('private sem scope definido retorna "restricted"', () => {
      assert.equal(caps.requiredScope('unknown-thing'), 'restricted');
    });
  });

  describe('filterByCategory', () => {
    const all = ['chat', 'whatsapp', 'compute', 'email', 'deploy'];

    it('filtra infra', () => {
      const infra = caps.filterByCategory(all, 'infra');
      assert.deepEqual(infra, ['chat', 'compute', 'deploy']);
    });

    it('filtra private', () => {
      const priv = caps.filterByCategory(all, 'private');
      assert.deepEqual(priv, ['whatsapp', 'email']);
    });
  });

  describe('enrich', () => {
    it('enriquece capabilities com metadata', () => {
      const enriched = caps.enrich(['chat', 'whatsapp']);
      assert.equal(enriched.length, 2);

      assert.equal(enriched[0].name, 'chat');
      assert.equal(enriched[0].category, 'infra');
      assert.equal(enriched[0].scope, null);

      assert.equal(enriched[1].name, 'whatsapp');
      assert.equal(enriched[1].category, 'private');
      assert.equal(enriched[1].scope, 'messaging');
    });
  });

  describe('hasAccess', () => {
    it('infra é sempre acessível', () => {
      assert.ok(caps.hasAccess('chat', []));
      assert.ok(caps.hasAccess('compute', []));
    });

    it('private requer scope', () => {
      assert.ok(!caps.hasAccess('whatsapp', []));
      assert.ok(caps.hasAccess('whatsapp', ['messaging']));
      assert.ok(!caps.hasAccess('whatsapp', ['personal']));
    });

    it('wildcard * dá acesso total', () => {
      assert.ok(caps.hasAccess('whatsapp', ['*']));
      assert.ok(caps.hasAccess('credentials', ['*']));
      assert.ok(caps.hasAccess('financial', ['*']));
    });
  });

  describe('accessibleCapabilities', () => {
    const all = ['chat', 'whatsapp', 'email', 'compute', 'credentials', 'calendar'];

    it('sem scopes = só infra', () => {
      const result = caps.accessibleCapabilities(all, []);
      assert.deepEqual(result, ['chat', 'compute']);
    });

    it('com scope messaging = infra + messaging', () => {
      const result = caps.accessibleCapabilities(all, ['messaging']);
      assert.deepEqual(result, ['chat', 'whatsapp', 'email', 'compute']);
    });

    it('com múltiplos scopes', () => {
      const result = caps.accessibleCapabilities(all, ['messaging', 'personal']);
      assert.deepEqual(result, ['chat', 'whatsapp', 'email', 'compute', 'calendar']);
    });

    it('wildcard = tudo', () => {
      const result = caps.accessibleCapabilities(all, ['*']);
      assert.deepEqual(result, all);
    });
  });
});
