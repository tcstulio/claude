// © 2026 Tulio Silva — Tulipa Platform. Proprietary and confidential.

import { describe, it, expect } from 'vitest';
import caps from '../lib-ts/capabilities.js';

describe('Capabilities', () => {
  describe('classify', () => {
    it('classifica capabilities de infra', () => {
      expect(caps.classify('chat')).toBe('infra');
      expect(caps.classify('compute')).toBe('infra');
      expect(caps.classify('proxmox-vm')).toBe('infra');
      expect(caps.classify('deploy')).toBe('infra');
      expect(caps.classify('relay')).toBe('infra');
    });

    it('classifica capabilities private', () => {
      expect(caps.classify('whatsapp')).toBe('private');
      expect(caps.classify('email')).toBe('private');
      expect(caps.classify('calendar')).toBe('private');
      expect(caps.classify('credentials')).toBe('private');
      expect(caps.classify('financial')).toBe('private');
    });

    it('desconhecidas são private por padrão (seguro)', () => {
      expect(caps.classify('unknown-thing')).toBe('private');
      expect(caps.classify('my-secret-data')).toBe('private');
    });
  });

  describe('requiredScope', () => {
    it('infra retorna null (sem scope necessário)', () => {
      expect(caps.requiredScope('chat')).toBe(null);
      expect(caps.requiredScope('compute')).toBe(null);
    });

    it('private retorna scope correto', () => {
      expect(caps.requiredScope('whatsapp')).toBe('messaging');
      expect(caps.requiredScope('telegram')).toBe('messaging');
      expect(caps.requiredScope('email')).toBe('messaging');
      expect(caps.requiredScope('calendar')).toBe('personal');
      expect(caps.requiredScope('contacts')).toBe('personal');
      expect(caps.requiredScope('credentials')).toBe('credentials');
      expect(caps.requiredScope('financial')).toBe('financial');
      expect(caps.requiredScope('documents')).toBe('documents');
    });

    it('private sem scope definido retorna "restricted"', () => {
      expect(caps.requiredScope('unknown-thing')).toBe('restricted');
    });
  });

  describe('filterByCategory', () => {
    const all = ['chat', 'whatsapp', 'compute', 'email', 'deploy'];

    it('filtra infra', () => {
      const infra = caps.filterByCategory(all, 'infra');
      expect(infra).toEqual(['chat', 'compute', 'deploy']);
    });

    it('filtra private', () => {
      const priv = caps.filterByCategory(all, 'private');
      expect(priv).toEqual(['whatsapp', 'email']);
    });
  });

  describe('enrich', () => {
    it('enriquece capabilities com metadata', () => {
      const enriched = caps.enrich(['chat', 'whatsapp']);
      expect(enriched.length).toBe(2);

      expect(enriched[0].name).toBe('chat');
      expect(enriched[0].category).toBe('infra');
      expect(enriched[0].scope).toBe(null);

      expect(enriched[1].name).toBe('whatsapp');
      expect(enriched[1].category).toBe('private');
      expect(enriched[1].scope).toBe('messaging');
    });
  });

  describe('hasAccess', () => {
    it('infra é sempre acessível', () => {
      expect(caps.hasAccess('chat', [])).toBeTruthy();
      expect(caps.hasAccess('compute', [])).toBeTruthy();
    });

    it('private requer scope', () => {
      expect(caps.hasAccess('whatsapp', [])).not.toBeTruthy();
      expect(caps.hasAccess('whatsapp', ['messaging'])).toBeTruthy();
      expect(caps.hasAccess('whatsapp', ['personal'])).not.toBeTruthy();
    });

    it('wildcard * dá acesso total', () => {
      expect(caps.hasAccess('whatsapp', ['*'])).toBeTruthy();
      expect(caps.hasAccess('credentials', ['*'])).toBeTruthy();
      expect(caps.hasAccess('financial', ['*'])).toBeTruthy();
    });
  });

  describe('accessibleCapabilities', () => {
    const all = ['chat', 'whatsapp', 'email', 'compute', 'credentials', 'calendar'];

    it('sem scopes = só infra', () => {
      const result = caps.accessibleCapabilities(all, []);
      expect(result).toEqual(['chat', 'compute']);
    });

    it('com scope messaging = infra + messaging', () => {
      const result = caps.accessibleCapabilities(all, ['messaging']);
      expect(result).toEqual(['chat', 'whatsapp', 'email', 'compute']);
    });

    it('com múltiplos scopes', () => {
      const result = caps.accessibleCapabilities(all, ['messaging', 'personal']);
      expect(result).toEqual(['chat', 'whatsapp', 'email', 'compute', 'calendar']);
    });

    it('wildcard = tudo', () => {
      const result = caps.accessibleCapabilities(all, ['*']);
      expect(result).toEqual(all);
    });
  });
});
