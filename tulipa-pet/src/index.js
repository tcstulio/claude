/**
 * Tulipa Pet — Virtual pet powered by real device sensors
 *
 * Each Tulipa agent (Android phone, server, desktop) gets its own pet
 * whose health, mood, and evolution reflect the real state of the device.
 */

import { PetManager } from './engine/pet-manager.js';
import { createPetServer } from './api/server.js';

const PORT = parseInt(process.env.PET_PORT || '3333');

console.log('');
console.log('  🌷 Tulipa Pet');
console.log('  ─────────────────────────────');

const manager = new PetManager();
manager.start();
createPetServer(manager, PORT);

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n  Salvando pet...');
  manager.stop();
  process.exit(0);
});

process.on('SIGTERM', () => {
  manager.stop();
  process.exit(0);
});

console.log('  ─────────────────────────────');
console.log('');
