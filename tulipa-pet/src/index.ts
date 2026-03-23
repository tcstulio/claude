/**
 * Tulipa Pet — Virtual pet powered by real device sensors
 *
 * Each Tulipa agent (Android phone, server, desktop) gets its own pet
 * whose health, mood, and evolution reflect the real state of the device.
 */

import { PetManager } from './engine/pet-manager.js';
import { PetNetwork } from './engine/pet-network.js';
import { createPetServer } from './api/server.js';

const PORT: number = parseInt(process.env.PET_PORT || '3333');

console.log('');
console.log('  🌷 Tulipa Pet');
console.log('  ─────────────────────────────');

const manager = new PetManager();
const network = new PetNetwork(manager);

manager.start();
network.start();
createPetServer(manager, PORT, network);

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n  Salvando pet...');
  network.stop();
  manager.stop();
  process.exit(0);
});

process.on('SIGTERM', () => {
  network.stop();
  manager.stop();
  process.exit(0);
});

console.log('  ─────────────────────────────');
console.log('');
