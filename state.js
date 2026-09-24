// État global unique du vaisseau.
//
// Chaque module possède sa tranche (state.energy, state.medbay, …) qu'il est
// seul à modifier ; il ne lit pas les tranches des autres modules mais réagit
// à leurs événements sur le bus. L'état reste un objet JSON pur, diffusé tel
// quel via WebSocket.

export const HISTORY_LENGTH = 120;
export const SIM_MINUTES_PER_TICK = 3; // 1 tick réel (1 s) = 3 minutes de mission

const STATUS_RANK = { ok: 0, warn: 1, critical: 2 };

export function createShipState(modules, rng) {
  const state = {
    ship: 'ISV Odyssée',
    tick: 0,
    missionMinutes: 0,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    status: 'ok',
    crises: { energy50: false, epidemic: false, cyberattack: false, 'earth-link-lost': false },
  };
  for (const mod of modules) state[mod.id] = mod.initialState(rng);
  return state;
}

export function worstStatus(...statuses) {
  return statuses.reduce((worst, s) => (STATUS_RANK[s] > STATUS_RANK[worst] ? s : worst), 'ok');
}

export function pushHistory(list, point, max = HISTORY_LENGTH) {
  list.push(point);
  if (list.length > max) list.splice(0, list.length - max);
}

export const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
export const round = (v, digits = 1) => {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
};
/** Rapproche `current` de `target` d'une fraction `rate` (lissage exponentiel). */
export const approach = (current, target, rate) => current + (target - current) * rate;
