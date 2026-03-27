/**
 * Tulipa Pet — Virtual pet powered by real device sensors
 *
 * Each Tulipa agent (Android phone, server, desktop) gets its own pet
 * whose health, mood, and evolution reflect the real state of the device.
 *
 * The Pet Daemon monitors all processes, auto-heals crashed services,
 * watches for code changes, and feeds real system state into pet needs.
 */

import { PetManager } from './engine/pet-manager.js';
import { PetNetwork } from './engine/pet-network.js';
import { createPetServer } from './api/server.js';
import { PetDaemon } from './daemon/index.js';

const PORT: number = parseInt(process.env.PET_PORT || '3333');

console.log('');
console.log('  🌷 Tulipa Pet');
console.log('  ─────────────────────────────');

const manager = new PetManager();
const network = new PetNetwork(manager);
const daemon = new PetDaemon({
  scanIntervalMs: 30_000,
  watchFiles: true,
  selfHeal: true,
  selfHealCooldownMs: 60_000,
});

// Wire daemon sensors into pet needs
daemon.on('sensors-updated', (contribution) => {
  // Blend daemon sensor data with existing pet needs
  const pet = manager.pet;
  if (!pet) return;

  // Weighted blend: 70% real sensors, 30% daemon process data
  const blend = (current: number, daemon: number, weight = 0.3) =>
    Math.round(current * (1 - weight) + daemon * weight);

  if (contribution.saude !== undefined) {
    pet.needs.saude.value = blend(pet.needs.saude.value, contribution.saude);
  }
  if (contribution.seguranca !== undefined) {
    pet.needs.seguranca.value = blend(pet.needs.seguranca.value, contribution.seguranca);
  }
  if (contribution.limpeza !== undefined) {
    pet.needs.limpeza.value = blend(pet.needs.limpeza.value, contribution.limpeza, 0.2);
  }
  if (contribution.humor !== undefined) {
    pet.needs.humor.value = blend(pet.needs.humor.value, contribution.humor, 0.2);
  }
});

// Critical service events → pet events
daemon.on('critical-alert', (event: { service: string }) => {
  manager.pet.addEvent('alert', `🚨 Serviço crítico caiu: ${event.service}`);
});

daemon.on('restart-attempt', (event: { service: string; success: boolean }) => {
  const msg = event.success
    ? `🔧 ${event.service} reiniciado com sucesso`
    : `❌ Falha ao reiniciar ${event.service}`;
  manager.pet.addEvent('daemon', msg);
});

daemon.on('build-success', () => {
  manager.pet.addEvent('daemon', '📂 Código atualizado e rebuild concluído');
});

manager.start();
network.start();
daemon.start();
createPetServer(manager, PORT, network, daemon);

// Graceful shutdown
const shutdown = () => {
  console.log('\n  Salvando pet...');
  daemon.stop();
  network.stop();
  manager.stop();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

console.log('  ─────────────────────────────');
console.log('');
