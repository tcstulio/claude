// © 2026 Tulio Silva — Tulipa Platform. Proprietary and confidential.

import { describe, it, beforeEach, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Organization, ROLES, DEFAULT_POLICIES } from '../lib-ts/org/organization.js';
import { OrgRegistry } from '../lib-ts/org/org-registry.js';
import { TrustGraph } from '../lib-ts/mesh/trust.js';

describe('Organization', () => {
  let org: InstanceType<typeof Organization>;

  beforeEach(() => {
    org = new Organization({
      name: 'Test Org',
      createdBy: 'owner_1',
    });
  });

  describe('criação', () => {
    it('cria org com owner', () => {
      expect(org.id.startsWith('org_')).toBeTruthy();
      expect(org.name).toBe('Test Org');
      expect(org.createdBy).toBe('owner_1');
      expect(org.isMember('owner_1')).toBeTruthy();
      expect(org.getMembers('owner').length).toBe(1);
    });

    it('políticas default', () => {
      expect(org.policies.minTrust).toBe(DEFAULT_POLICIES.minTrust);
      expect(org.policies.votingThreshold).toBe(0.51);
    });

    it('políticas custom', () => {
      const custom = new Organization({
        name: 'Custom', createdBy: 'x',
        policies: { minTrust: 0.5, maxHops: 2 },
      });
      expect(custom.policies.minTrust).toBe(0.5);
      expect(custom.policies.maxHops).toBe(2);
    });
  });

  describe('invite + accept', () => {
    it('convida e aceita', () => {
      const result = org.invite('peer_a', 'owner_1', 'member');
      expect(result.invited).toBeTruthy();
      expect(result.pending).toBeTruthy();

      const accepted = org.acceptInvite('peer_a');
      expect(!accepted.pending).toBeTruthy();
      expect(org.isMember('peer_a')).toBeTruthy();
    });

    it('convite sem aprovação quando requireApproval=false', () => {
      org.policies.requireApproval = false;
      const result = org.invite('peer_b', 'owner_1');
      expect(result.invited).toBeTruthy();
      expect(!result.pending).toBeTruthy();
      expect(org.isMember('peer_b')).toBeTruthy();
    });

    it('erro ao convidar membro existente', () => {
      expect(
        () => org.invite('owner_1', 'owner_1'),
      ).toThrow(/already a member/);
    });

    it('membro não pode convidar', () => {
      org.policies.requireApproval = false;
      org.invite('peer_a', 'owner_1', 'member');
      expect(
        () => org.invite('peer_b', 'peer_a'),
      ).toThrow(/Permission denied/);
    });

    it('só owner pode convidar owner', () => {
      org.policies.requireApproval = false;
      org.invite('admin_1', 'owner_1', 'admin');
      expect(
        () => org.invite('peer_b', 'admin_1', 'owner'),
      ).toThrow(/Only owners/);
    });

    it('decline invite', () => {
      org.invite('peer_a', 'owner_1');
      org.declineInvite('peer_a');
      expect(!org.isMember('peer_a')).toBeTruthy();
      expect(org.getPendingInvites().length).toBe(0);
    });
  });

  describe('removeMember', () => {
    it('owner remove member', () => {
      org.policies.requireApproval = false;
      org.invite('peer_a', 'owner_1');
      expect(org.isMember('peer_a')).toBeTruthy();
      org.removeMember('peer_a', 'owner_1');
      expect(!org.isMember('peer_a')).toBeTruthy();
    });

    it('não pode remover a si mesmo', () => {
      expect(
        () => org.removeMember('owner_1', 'owner_1'),
      ).toThrow(/Cannot remove yourself/);
    });
  });

  describe('leave', () => {
    it('member sai da org', () => {
      org.policies.requireApproval = false;
      org.invite('peer_a', 'owner_1');
      org.leave('peer_a');
      expect(!org.isMember('peer_a')).toBeTruthy();
    });

    it('último owner não pode sair', () => {
      expect(
        () => org.leave('owner_1'),
      ).toThrow(/Last owner/);
    });
  });

  describe('updatePolicies', () => {
    it('owner altera políticas', () => {
      const p = org.updatePolicies({ minTrust: 0.6 }, 'owner_1');
      expect(p.minTrust).toBe(0.6);
    });

    it('member não pode alterar', () => {
      org.policies.requireApproval = false;
      org.invite('peer_a', 'owner_1', 'member');
      expect(
        () => org.updatePolicies({}, 'peer_a'),
      ).toThrow(/Permission denied/);
    });
  });

  describe('canDelegate', () => {
    it('permite delegação entre membros com trust suficiente', () => {
      org.policies.requireApproval = false;
      org.invite('peer_a', 'owner_1');
      expect(org.canDelegate('owner_1', 'peer_a', 0.5)).toBeTruthy();
    });

    it('bloqueia com trust baixo', () => {
      org.policies.requireApproval = false;
      org.invite('peer_a', 'owner_1');
      expect(!org.canDelegate('owner_1', 'peer_a', 0.1)).toBeTruthy();
    });

    it('bloqueia não-membros', () => {
      expect(!org.canDelegate('owner_1', 'outsider', 0.9)).toBeTruthy();
    });
  });

  describe('toJSON', () => {
    it('serializa corretamente', () => {
      const json = org.toJSON();
      expect(json.name).toBe('Test Org');
      expect(json.members.length >= 1).toBeTruthy();
      expect(json.stats).toBeTruthy();
    });
  });
});

describe('OrgRegistry', () => {
  let registry: InstanceType<typeof OrgRegistry>;
  let trust: InstanceType<typeof TrustGraph>;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'org-test-'));
    trust = new TrustGraph({ nodeId: 'self' });
    trust.setDirectTrust('peer_a', 0.8);
    trust.setDirectTrust('peer_b', 0.6);
    registry = new OrgRegistry({ dataDir: tmpDir, trust });
  });

  describe('create + get + list', () => {
    it('cria e recupera org', () => {
      const org = registry.create('Dev Team', 'self');
      expect(org.id).toBeTruthy();
      expect(registry.get(org.id).name).toBe('Dev Team');
      expect(registry.list().length).toBe(1);
    });

    it('filtra por member', () => {
      const org1 = registry.create('Team A', 'self');
      registry.create('Team B', 'peer_x');

      org1.policies.requireApproval = false;
      org1.invite('peer_a', 'self');

      expect(registry.list({ member: 'peer_a' }).length).toBe(1);
      expect(registry.list({ member: 'peer_x' }).length).toBe(1);
    });
  });

  describe('getOrgReputation', () => {
    it('calcula média de trust dos membros', () => {
      const org = registry.create('Team', 'self');
      org.policies.requireApproval = false;
      org.invite('peer_a', 'self'); // trust 0.8
      org.invite('peer_b', 'self'); // trust 0.6

      const rep = registry.getOrgReputation(org.id);
      // (0.8 + 0.6) / 2 = 0.7 (self não tem trust direto consigo)
      expect(rep > 0.6).toBeTruthy();
      expect(rep < 0.9).toBeTruthy();
    });
  });

  describe('getTrustBoost', () => {
    it('retorna boost para membro de org com boa reputação', () => {
      const org = registry.create('Good Team', 'self');
      org.policies.requireApproval = false;
      org.invite('peer_a', 'self');
      org.invite('peer_b', 'self');

      const boost = registry.getTrustBoost('peer_a');
      expect(boost > 0).toBeTruthy();
      expect(boost <= 0.3).toBeTruthy();
    });

    it('retorna 0 para não-membro', () => {
      expect(registry.getTrustBoost('unknown')).toBe(0);
    });
  });

  describe('getPublicOrgInfo', () => {
    it('retorna info pública das orgs', () => {
      const org = registry.create('Public Team', 'self');
      org.policies.requireApproval = false;
      org.invite('peer_a', 'self');

      const info = registry.getPublicOrgInfo('peer_a');
      expect(info.length).toBe(1);
      expect(info[0].orgName).toBe('Public Team');
      expect(info[0].role).toBe('member');
      expect(typeof info[0].reputation === 'number').toBeTruthy();
    });
  });

  describe('persistência', () => {
    it('salva e carrega do disco', () => {
      const org = registry.create('Persistent', 'self');
      org.policies.requireApproval = false;
      org.invite('peer_a', 'self', 'admin');
      registry.save();

      // Novo registry do mesmo dir
      const reg2 = new OrgRegistry({ dataDir: tmpDir, trust });
      expect(reg2.list().length).toBe(1);
      const loaded = reg2.get(org.id);
      expect(loaded.name).toBe('Persistent');
      expect(loaded.isMember('peer_a')).toBeTruthy();
    });
  });

  describe('remove', () => {
    it('owner remove org', () => {
      const org = registry.create('To Delete', 'self');
      registry.remove(org.id, 'self');
      expect(registry.list().length).toBe(0);
    });

    it('não-owner não pode remover', () => {
      const org = registry.create('Protected', 'self');
      expect(
        () => registry.remove(org.id, 'outsider'),
      ).toThrow(/Permission denied/);
    });
  });
});
