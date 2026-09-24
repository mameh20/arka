// Module 1 — Énergie
//
// Production solaire variable (orbite + bruit), batterie tampon, 5 secteurs
// alimentés par ordre de priorité. En cas de manque : délestage (les secteurs
// les moins prioritaires sont réduits puis coupés) et passage en mode dégradé.
//
// Publie : energy.allocation (télémétrie silencieuse), energy.sector.changed,
//          energy.mode.changed, energy.production.drop, energy.battery.*
// Écoute : crisis.energy50, crisis.reset, medbay.power.request,
//          security.device.quarantined / released (gestionnaire batterie)

import { clamp, pushHistory, round, SIM_MINUTES_PER_TICK } from '../core/state.js';

const SECTORS = [
  { id: 'o2', label: 'Support vital O2', priority: 1, baseDemand: 30, min: 1 },
  { id: 'infirmerie', label: 'Infirmerie', priority: 2, baseDemand: 20, min: 1 },
  { id: 'serre', label: 'Serre', priority: 3, baseDemand: 25, min: 0.3 },
  { id: 'eclairage', label: 'Éclairage', priority: 4, baseDemand: 15, min: 0.3 },
  { id: 'loisirs', label: 'Loisirs', priority: 5, baseDemand: 10, min: 0 },
];

const SOLAR_NOMINAL = 120; // kW
const ORBIT_PERIOD = 240; // ticks
const DT_HOURS = SIM_MINUTES_PER_TICK / 60;
const DISCHARGE_CAP = { normal: 35, degraded: 12, safeMode: 5, lowBattery: 5, empty: 0 }; // kW
const CHARGE_CAP = 40; // kW

const BAND_LABEL = { full: 'pleine puissance', reduced: 'réduit', cut: 'coupé' };
const MODE_LABEL = { normal: 'nominal', degraded: 'dégradé', critical: 'critique' };

export const bandOf = (ratio) => (ratio >= 0.95 ? 'full' : ratio < 0.05 ? 'cut' : 'reduced');

/**
 * Allocation par priorité, en deux passes :
 *  1. chaque secteur reçoit son minimum vital (dans l'ordre de priorité) ;
 *  2. le reste complète les secteurs jusqu'à leur pleine demande, toujours par priorité.
 * Fonction pure, exportée pour les tests.
 */
export function allocatePower(sectors, available) {
  const ordered = [...sectors].sort((a, b) => a.priority - b.priority);
  const alloc = Object.fromEntries(ordered.map((s) => [s.id, 0]));
  let remaining = available;
  for (const s of ordered) {
    const give = Math.min(remaining, s.demand * s.min);
    alloc[s.id] += give;
    remaining -= give;
  }
  for (const s of ordered) {
    const give = Math.min(remaining, s.demand - alloc[s.id]);
    alloc[s.id] += give;
    remaining -= give;
  }
  return alloc;
}

export function createEnergyModule() {
  let lastCause = null; // dernière cause connue de la situation énergétique

  function initialState() {
    return {
      status: 'ok',
      mode: 'normal',
      solarRaw: SOLAR_NOMINAL * 0.8,
      productionFactor: 1,
      production: SOLAR_NOMINAL * 0.8,
      demandTotal: 100,
      consumption: 100,
      battery: { capacity: 150, charge: 120, soc: 80, flow: 0, maxDischarge: DISCHARGE_CAP.normal, safeMode: false },
      sectors: SECTORS.map((s) => ({ ...s, extraDemand: 0, demand: s.baseDemand, allocated: s.baseDemand, ratio: 1, band: 'full' })),
      history: [],
    };
  }

  function dischargeCap(e) {
    if (e.battery.soc <= 3) return DISCHARGE_CAP.empty;
    if (e.battery.safeMode) return DISCHARGE_CAP.safeMode;
    if (e.battery.soc < 20) return DISCHARGE_CAP.lowBattery;
    // Mode dégradé préventif : quand la production est amputée, on préserve la réserve
    if (e.productionFactor < 1) return DISCHARGE_CAP.degraded;
    return DISCHARGE_CAP.normal;
  }

  /** Recalcule l'allocation et publie les transitions (délestage, mode). */
  function reallocate({ state, bus }, explicitCause) {
    const e = state.energy;
    const cause = explicitCause ?? lastCause;
    e.production = Math.max(0, e.solarRaw * e.productionFactor);
    for (const s of e.sectors) s.demand = s.baseDemand + s.extraDemand;
    e.demandTotal = e.sectors.reduce((sum, s) => sum + s.demand, 0);
    e.battery.maxDischarge = dischargeCap(e);

    const alloc = allocatePower(e.sectors, e.production + e.battery.maxDischarge);
    const transitions = [];
    for (const s of e.sectors) {
      s.allocated = alloc[s.id];
      s.ratio = s.demand > 0 ? s.allocated / s.demand : 1;
      const band = bandOf(s.ratio);
      if (band !== s.band) transitions.push({ sector: s, from: s.band, to: band });
      s.band = band;
    }
    e.consumption = e.sectors.reduce((sum, s) => sum + s.allocated, 0);

    const o2 = e.sectors.find((s) => s.id === 'o2');
    const shed = e.sectors.some((s) => s.band !== 'full');
    const mode = o2.ratio < 0.99 ? 'critical' : shed || e.productionFactor < 1 || e.battery.safeMode ? 'degraded' : 'normal';

    // Télémétrie continue pour les modules consommateurs (non journalisée)
    bus.publish('energy.allocation', {
      source: 'energy',
      silent: true,
      data: Object.fromEntries(e.sectors.map((s) => [s.id, round(s.ratio, 3)])),
    });

    if (mode !== e.mode) {
      const from = e.mode;
      e.mode = mode;
      bus.publish('energy.mode.changed', {
        source: 'energy',
        severity: mode === 'normal' ? 'info' : mode === 'degraded' ? 'warn' : 'critical',
        message: `Réseau électrique : mode ${MODE_LABEL[from]} → ${MODE_LABEL[mode]}`,
        label: `Énergie en mode ${MODE_LABEL[mode]}`,
        data: { from, to: mode },
        cause,
      });
    }

    for (const { sector, from, to } of transitions) {
      const pct = Math.round(sector.ratio * 100);
      const verb = to === 'cut' ? 'Délestage : secteur coupé' : to === 'reduced' ? `Délestage : secteur réduit à ${pct} %` : 'Secteur rétabli';
      bus.publish('energy.sector.changed', {
        source: 'energy',
        severity: to === 'full' ? 'info' : sector.priority <= 2 ? 'critical' : 'warn',
        message: `${verb} — ${sector.label} (priorité ${sector.priority}, ${round(sector.allocated)} / ${round(sector.demand)} kW)`,
        label: `${sector.label} ${BAND_LABEL[to]}${to === 'reduced' ? ` (${pct} %)` : ''}`,
        data: { sector: sector.id, from, to, ratio: round(sector.ratio, 3) },
        cause,
      });
    }
  }

  function init(ctx) {
    const { bus, state } = ctx;
    const e = () => state.energy;

    bus.on('crisis.energy50', (ev) => {
      e().productionFactor = 0.5;
      lastCause = bus.publish('energy.production.drop', {
        source: 'energy',
        severity: 'critical',
        message: 'Production solaire amputée de 50 % — bascule en mode dégradé, réserve batterie préservée',
        label: 'Production solaire −50 %',
        cause: ev,
      });
      reallocate(ctx, lastCause);
    });

    bus.on('medbay.power.request', (ev) => {
      const { infirmerieKw = 0, o2Kw = 0 } = ev.data;
      const sectors = e().sectors;
      sectors.find((s) => s.id === 'infirmerie').extraDemand = infirmerieKw;
      sectors.find((s) => s.id === 'o2').extraDemand = o2Kw;
      lastCause = bus.publish('energy.demand.changed', {
        source: 'energy',
        severity: infirmerieKw + o2Kw > 0 ? 'warn' : 'info',
        message: `Demande médicale : infirmerie +${infirmerieKw} kW, O2 +${o2Kw} kW (assistance respiratoire)`,
        label: `Demande énergie +${infirmerieKw + o2Kw} kW`,
        data: { infirmerieKw, o2Kw },
        cause: ev,
      });
      reallocate(ctx, lastCause);
    });

    bus.on('security.device.quarantined', (ev) => {
      if (ev.data.deviceId !== 'bat-bms') return;
      e().battery.safeMode = true;
      lastCause = bus.publish('energy.battery.safemode', {
        source: 'energy',
        severity: 'warn',
        message: `Gestionnaire batterie isolé : décharge bridée à ${DISCHARGE_CAP.safeMode} kW (mode sécurité)`,
        label: 'Batterie bridée (mode sécurité)',
        cause: ev,
      });
      reallocate(ctx, lastCause);
    });

    bus.on('security.device.released', (ev) => {
      if (ev.data.deviceId !== 'bat-bms') return;
      e().battery.safeMode = false;
      reallocate(ctx, ev);
    });

    bus.on('crisis.reset', (ev) => {
      e().productionFactor = 1;
      reallocate(ctx, ev);
      lastCause = null;
    });
  }

  function tick(ctx) {
    const { state, rng } = ctx;
    const e = state.energy;

    // Production solaire : cycle orbital (80 % ± 20 %) + bruit
    const orbit = 0.8 + 0.2 * Math.sin((2 * Math.PI * state.tick) / ORBIT_PERIOD);
    e.solarRaw = Math.max(0, SOLAR_NOMINAL * orbit + rng.gauss(0, 2));
    reallocate(ctx, null);

    // Bilan batterie
    const b = e.battery;
    const net = e.production - e.consumption; // >0 : surplus
    b.flow = net >= 0 ? Math.min(net, CHARGE_CAP) : net; // décharge déjà bornée par l'allocation
    b.charge = clamp(b.charge + b.flow * DT_HOURS, 0, b.capacity);
    const prevSoc = b.soc;
    b.soc = round((b.charge / b.capacity) * 100, 1);
    if (prevSoc >= 20 && b.soc < 20) {
      ctx.bus.publish('energy.battery.low', {
        source: 'energy',
        severity: 'critical',
        message: `Batterie sous 20 % (${b.soc} %) — décharge limitée à ${DISCHARGE_CAP.lowBattery} kW`,
        label: 'Batterie < 20 %',
        cause: lastCause,
      });
    }

    e.status = e.mode === 'critical' || b.soc < 10 ? 'critical' : e.mode === 'degraded' || b.soc < 25 ? 'warn' : 'ok';
    pushHistory(e.history, {
      t: state.tick,
      production: round(e.production),
      consumption: round(e.consumption),
      demand: round(e.demandTotal),
      soc: b.soc,
    });
  }

  return { id: 'energy', label: 'Énergie', initialState, init, tick };
}
