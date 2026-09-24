// Moteur de simulation : assemble l'état global, le bus, le journal et les
// modules, puis fait avancer le vaisseau à 1 Hz.

import { EventBus } from './eventBus.js';
import { createJournal } from './journal.js';
import { createRng } from './rng.js';
import { createShipState, worstStatus, SIM_MINUTES_PER_TICK } from './state.js';
import { triggerCrisis, CRISES } from './crises.js';
import { createModules } from '../modules/index.js';

export function createSimulation({ dbPath = ':memory:', seed = Date.now(), tickMs = 1000 } = {}) {
  const rng = createRng(seed);
  const modules = createModules();
  const state = createShipState(modules, rng);
  const bus = new EventBus({ clock: () => state.tick });
  const journal = createJournal(dbPath);
  journal.attach(bus);

  const ctx = { state, bus, rng };
  for (const mod of modules) mod.init(ctx);

  const tickListeners = new Set();
  let timer = null;

  function tick() {
    state.tick += 1;
    state.missionMinutes = state.tick * SIM_MINUTES_PER_TICK;
    state.updatedAt = Date.now();
    // Ordre fixe : l'énergie alloue d'abord, les autres modules consomment ensuite.
    for (const mod of modules) mod.tick(ctx);
    state.status = worstStatus(...modules.map((m) => state[m.id].status));
    for (const fn of tickListeners) fn(state);
  }

  bus.publish('system.boot', {
    source: 'system',
    message: `Vaisseau OS démarré — ${modules.length} modules en ligne (${modules.map((m) => m.label).join(', ')})`,
    label: 'Démarrage',
  });

  return {
    state,
    bus,
    journal,
    modules,
    crises: CRISES,
    tick,
    /** Avance la simulation de n ticks (utile pour les tests). */
    run(n) {
      for (let i = 0; i < n; i++) tick();
    },
    triggerCrisis: (name) => triggerCrisis(ctx, name),
    onTick(fn) {
      tickListeners.add(fn);
      return () => tickListeners.delete(fn);
    },
    start() {
      if (!timer) timer = setInterval(tick, tickMs);
    },
    stop() {
      clearInterval(timer);
      timer = null;
    },
    close() {
      this.stop();
      journal.close();
    },
  };
}
