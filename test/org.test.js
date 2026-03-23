'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { Organization, ROLES, DEFAULT_POLICIES } = require('../lib/org/organization');
const OrgRegistry = require('../lib/org/org-registry');
const TrustGraph = require('../lib/mesh/trust');

describe('Organization', () => {
  let org;

  beforeEach(() => {
    org = new Organization({
      name: 'Test Org',
      createdBy: 'owner_1',
    });
  });

  describe('criação', () => {
    it('cria org com owner', () => {
      assert.ok(org.id.startsWith('org_'));
      assert.equal(org.name, 'Test Org');
      assert.equal(org.createdBy, 'owner_1');
      assert.ok(org.isMember('owner_1'));
      assert.equal(org.getMembers('owner').length, 1);
    });

    it('políticas default', () => {
      assert.equal(org.policies.minTrust, DEFAULT_POLICIES.minTrust);
      assert.equal(org.policies.votingThreshold, 0.51);
    });

    it('políticas custom', () => {
      const custom = new Organization({
        name: 'Custom', createdBy: 'x',
        policies: { minTrust: 0.5, maxHops: 2 },
      });
      assert.equal(custom.policies.minTrust, 0.5);
      assert.equal(custom.policies.maxHops, 2);
    });
  });

  describe('invite + accept', () => {
    it('convida e aceita', () => {
      const result = org.invite('peer_a', 'owner_1', 'member');
      assert.ok(result.invited);
      assert.ok(result.pending);

      const accepted = org.acceptInvite('peer_a');
      assert.ok(!accepted.pending);
      assert.ok(org.isMember('peer_a'));
    });

    it('convite sem aprovação quando requireApproval=false', () => {
      org.policies.requireApproval = false;
      const result = org.invite('peer_b', 'owner_1');
      assert.ok(result.invited);
      assert.ok(!result.pending);
      assert.ok(org.isMember('peer_b'));
    });

    it('erro ao convidar membro existente', () => {
      assert.throws(
        () => org.invite('owner_1', 'owner_1'),
        { message: /já é membro/ },
      );
    });

    it('membro não pode convidar', () => {
      org.policies.requireApproval = false;
      org.invite('peer_a', 'owner_1', 'member');
      assert.throws(
        () => org.invite('peer_b', 'peer_a'),
        { message: /Permissão negada/ },
      );
    });

    it('só owner pode convidar owner', () => {
      org.policies.requireApproval = false;
      org.invite('admin_1', 'owner_1', 'admin');
      assert.throws(
        () => org.invite('peer_b', 'admin_1', 'owner'),
        { message: /Apenas owners/ },
      );
    });

    it('decline invite', () => {
      org.invite('peer_a', 'owner_1');
      org.declineInvite('peer_a');
      assert.ok(!org.isMember('peer_a'));
      assert.equal(org.getPendingInvites().length, 0);
    });
  });

  describe('removeMember', () => {
    it('owner remove member', () => {
      org.policies.requireApproval = false;
      org.invite('peer_a', 'owner_1');
      assert.ok(org.isMember('peer_a'));
      org.removeMember('peer_a', 'owner_1');
      assert.ok(!org.isMember('peer_a'));
    });

    it('não pode remover a si mesmo', () => {
      assert.throws(
        () => org.removeMember('owner_1', 'owner_1'),
        { message: /remover a si mesmo/ },
      );
    });
  });

  describe('leave', () => {
    it('member sai da org', () => {
      org.policies.requireApproval = false;
      org.invite('peer_a', 'owner_1');
      org.leave('peer_a');
      assert.ok(!org.isMember('peer_a'));
    });

    it('último owner não pode sair', () => {
      assert.throws(
        () => org.leave('owner_1'),
        { message: /Último owner/ },
      );
    });
  });

  describe('updatePolicies', () => {
    it('owner altera políticas', () => {
      const p = org.updatePolicies({ minTrust: 0.6 }, 'owner_1');
      assert.equal(p.minTrust, 0.6);
    });

    it('member não pode alterar', () => {
      org.policies.requireApproval = false;
      org.invite('peer_a', 'owner_1', 'member');
      assert.throws(
        () => org.updatePolicies({}, 'peer_a'),
        { message: /Permissão negada/ },
      );
    });
  });

  describe('canDelegate', () => {
    it('permite delegação entre membros com trust suficiente', () => {
      org.policies.requireApproval = false;
      org.invite('peer_a', 'owner_1');
      assert.ok(org.canDelegate('owner_1', 'peer_a', 0.5));
    });

    it('bloqueia com trust baixo', () => {
      org.policies.requireApproval = false;
      org.invite('peer_a', 'owner_1');
      assert.ok(!org.canDelegate('owner_1', 'peer_a', 0.1));
    });

    it('bloqueia não-membros', () => {
      assert.ok(!org.canDelegate('owner_1', 'outsider', 0.9));
    });
  });

  describe('toJSON', () => {
    it('serializa corretamente', () => {
      const json = org.toJSON();
      assert.equal(json.name, 'Test Org');
      assert.ok(json.members.length >= 1);
      assert.ok(json.stats);
    });
  });
});

describe('OrgRegistry', () => {
  let registry, trust, tmpDir;

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
      assert.ok(org.id);
      assert.equal(registry.get(org.id).name, 'Dev Team');
      assert.equal(registry.list().length, 1);
    });

    it('filtra por member', () => {
      const org1 = registry.create('Team A', 'self');
      registry.create('Team B', 'peer_x');

      org1.policies.requireApproval = false;
      org1.invite('peer_a', 'self');

      assert.equal(registry.list({ member: 'peer_a' }).length, 1);
      assert.equal(registry.list({ member: 'peer_x' }).length, 1);
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
      assert.ok(rep > 0.6);
      assert.ok(rep < 0.9);
    });
  });

  describe('getTrustBoost', () => {
    it('retorna boost para membro de org com boa reputação', () => {
      const org = registry.create('Good Team', 'self');
      org.policies.requireApproval = false;
      org.invite('peer_a', 'self');
      org.invite('peer_b', 'self');

      const boost = registry.getTrustBoost('peer_a');
      assert.ok(boost > 0);
      assert.ok(boost <= 0.3);
    });

    it('retorna 0 para não-membro', () => {
      assert.equal(registry.getTrustBoost('unknown'), 0);
    });
  });

  describe('getPublicOrgInfo', () => {
    it('retorna info pública das orgs', () => {
      const org = registry.create('Public Team', 'self');
      org.policies.requireApproval = false;
      org.invite('peer_a', 'self');

      const info = registry.getPublicOrgInfo('peer_a');
      assert.equal(info.length, 1);
      assert.equal(info[0].orgName, 'Public Team');
      assert.equal(info[0].role, 'member');
      assert.ok(typeof info[0].reputation === 'number');
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
      assert.equal(reg2.list().length, 1);
      const loaded = reg2.get(org.id);
      assert.equal(loaded.name, 'Persistent');
      assert.ok(loaded.isMember('peer_a'));
    });
  });

  describe('remove', () => {
    it('owner remove org', () => {
      const org = registry.create('To Delete', 'self');
      registry.remove(org.id, 'self');
      assert.equal(registry.list().length, 0);
    });

    it('não-owner não pode remover', () => {
      const org = registry.create('Protected', 'self');
      assert.throws(
        () => registry.remove(org.id, 'outsider'),
        { message: /Permissão negada/ },
      );
    });
  });
});
