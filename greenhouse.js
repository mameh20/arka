// Module 3 — Serre
//
// Humidité, pH, niveau d'eau d'irrigation et croissance de 6 cultures. La
// croissance dépend de l'éclairage (alimenté par le secteur énergie « serre »),
// de l'eau, du pH et de l'humidité.
//
// Publie : greenhouse.lighting.changed, greenhouse.growth.changed,
//          greenhouse.water.low, greenhouse.irrigation.*, greenhouse.climate.*,
//          greenhouse.maintenance.*, greenhouse.harvest, greenhouse.alert
// Écoute : energy.allocation, energy.sector.changed (serre),
//          security.device.quarantined/released (hyd-pump, hvac-01),
//          medbay.staffing.low/restored, crisis.reset

import { approach, clamp, pushHistory, round } from '../core/state.js';

const CROPS = [
  ['lettuce', 'Laitue', 1.4],
  ['tomato', 'Tomates', 0.8],
  ['potato', 'Pommes de terre', 0.6],
  ['soy', 'Soja', 0.9],
  ['spirulina', 'Spiruline', 1.8],
  ['wheat', 'Blé nain', 0.7],
];

const PH_TARGET = 6.2;
const HUMIDITY_TARGET = 62;

const BAND_ORDER = ['halted', 'slowed', 'nominal'];
const BAND_FLOOR = { nominal: 0.8, slowed: 0.4, halted: 0 };
const HYSTERESIS = 0.05;

/** Bande de croissance avec hystérésis : il faut dépasser le seuil de 5 points pour remonter. */
function growthBand(current, rate) {
  const raw = rate >= BAND_FLOOR.nominal ? 'nominal' : rate >= BAND_FLOOR.slowed ? 'slowed' : 'halted';
  if (BAND_ORDER.indexOf(raw) <= BAND_ORDER.indexOf(current)) return raw;
  return rate >= BAND_FLOOR[raw] + HYSTERESIS ? raw : current;
}
const GROWTH_LABEL = { nominal: 'nominale', slowed: 'ralentie', halted: 'quasi arrêtée' };

export function createGreenhouseModule() {
  // Dernière cause connue pour chaque facteur de croissance : un ralentissement
  // est attribué au facteur le plus limitant, pas au dernier événement reçu.
  const causes = { light: null, water: null, ph: null, humidity: null };
  const lastCause = () => Object.values(causes).find(Boolean) ?? null;
  let growthState = 'nominal';
  let waterLow = false;
  let lastStatus = 'ok';

  function initialState(rng) {
    return {
      status: 'ok',
      powerRatio: 1,
      lightLevel: 100,
      humidity: HUMIDITY_TARGET,
      ph: PH_TARGET,
      waterLevel: 75,
      pumpActive: true,
      irrigationAuto: true,
      climateControl: true,
      maintenance: true,
      growthRate: 100,
      harvests: 0,
      crops: CROPS.map(([id, name, speed]) => ({ id, name, speed, growth: round(rng.range(5, 90)), health: 100 })),
      history: [],
    };
  }

  function init({ bus, state }) {
    const g = () => state.greenhouse;

    bus.on('energy.allocation', (ev) => {
      g().powerRatio = ev.data.serre ?? 1;
    });

    bus.on('energy.sector.changed', (ev) => {
      if (ev.data.sector !== 'serre') return;
      const pct = Math.round(ev.data.ratio * 100);
      causes.light = bus.publish('greenhouse.lighting.changed', {
        source: 'greenhouse',
        severity: ev.data.to === 'full' ? 'info' : 'warn',
        message:
          ev.data.to === 'full'
            ? 'Lampes de croissance rétablies à 100 %'
            : `Lampes de croissance réduites à ${pct} %${pct < 30 ? ' — pompes d’irrigation à l’arrêt' : ''}`,
        label: ev.data.to === 'full' ? 'Éclairage serre 100 %' : `Éclairage serre ${pct} %`,
        data: { lightTarget: pct },
        cause: ev,
      });
    });

    const deviceEffects = {
      'hyd-pump': {
        key: 'irrigationAuto',
        factor: 'water',
        lost: ['greenhouse.irrigation.offline', 'Contrôleur d’irrigation isolé : arrosage automatique suspendu, niveau d’eau en baisse', 'Irrigation automatique coupée'],
        back: ['greenhouse.irrigation.online', 'Irrigation automatique rétablie', 'Irrigation rétablie'],
      },
      'hvac-01': {
        key: 'climateControl',
        factor: 'humidity',
        lost: ['greenhouse.climate.unregulated', 'Capteur climat isolé : humidité non régulée', 'Humidité non régulée'],
        back: ['greenhouse.climate.regulated', 'Régulation climatique rétablie', 'Climat régulé'],
      },
    };

    bus.on('security.device.quarantined', (ev) => {
      const fx = deviceEffects[ev.data.deviceId];
      if (!fx) return;
      g()[fx.key] = false;
      const [type, message, label] = fx.lost;
      causes[fx.factor] = bus.publish(type, { source: 'greenhouse', severity: 'warn', message, label, cause: ev });
    });

    bus.on('security.device.released', (ev) => {
      const fx = deviceEffects[ev.data.deviceId];
      if (!fx) return;
      g()[fx.key] = true;
      const [type, message, label] = fx.back;
      bus.publish(type, { source: 'greenhouse', message, label, cause: ev });
    });

    bus.on('medbay.staffing.low', (ev) => {
      g().maintenance = false;
      causes.ph = bus.publish('greenhouse.maintenance.suspended', {
        source: 'greenhouse',
        severity: 'warn',
        message: 'Équipage réduit : dosage des nutriments suspendu, le pH va dériver',
        label: 'Maintenance serre suspendue',
        cause: ev,
      });
    });

    bus.on('medbay.staffing.restored', (ev) => {
      g().maintenance = true;
      bus.publish('greenhouse.maintenance.resumed', { source: 'greenhouse', message: 'Maintenance de la serre reprise', label: 'Maintenance reprise', cause: ev });
    });

    bus.on('crisis.reset', () => {
      g().maintenance = true;
      for (const k of Object.keys(causes)) causes[k] = null;
    });
  }

  function tick({ state, bus, rng }) {
    const g = state.greenhouse;

    // Éclairage : suit l'alimentation du secteur serre
    g.lightLevel = round(approach(g.lightLevel, clamp(g.powerRatio, 0, 1) * 100, 0.3));
    // Pompes : besoin d'un contrôleur actif et d'un minimum de puissance
    g.pumpActive = g.irrigationAuto && g.powerRatio >= 0.3;

    // Eau : consommation des plantes (plus forte sous lumière), recharge par pompes
    const plantUse = 0.25 + 0.2 * (g.lightLevel / 100);
    const refill = g.pumpActive && g.waterLevel < 80 ? 0.6 : 0;
    g.waterLevel = round(clamp(g.waterLevel - plantUse + refill + rng.gauss(0, 0.05), 0, 100));

    // Humidité : régulée si climat + irrigation OK, sinon dérive
    const humTarget = !g.climateControl ? 82 : g.waterLevel < 20 ? 40 : g.pumpActive ? HUMIDITY_TARGET : 50;
    g.humidity = round(clamp(approach(g.humidity, humTarget, 0.05) + rng.gauss(0, 0.3), 20, 100));

    // pH : corrigé par la maintenance, sinon dérive vers l'alcalin
    g.ph = round(clamp(g.maintenance ? approach(g.ph, PH_TARGET, 0.1) + rng.gauss(0, 0.01) : g.ph + 0.01 + rng.gauss(0, 0.005), 4, 9), 2);

    // Croissance
    const light = g.lightLevel / 100;
    const water = g.waterLevel >= 30 ? 1 : g.waterLevel / 30;
    const ph = 1 - Math.min(1, Math.abs(g.ph - PH_TARGET) / 1.5);
    const hum = 1 - Math.min(1, Math.max(0, Math.abs(g.humidity - HUMIDITY_TARGET) - 10) / 30);
    const rate = light * water * ph * hum;
    g.growthRate = round(rate * 100);

    for (const c of g.crops) {
      const stress = g.waterLevel < 10 || ph < 0.4 ? 0.5 : -0.2;
      c.health = round(clamp(c.health - stress, 0, 100));
      c.growth = round(c.growth + c.speed * 0.25 * rate * (c.health / 100), 2);
      if (c.growth >= 100) {
        c.growth = 0;
        g.harvests++;
        bus.publish('greenhouse.harvest', {
          source: 'greenhouse',
          message: `Récolte : ${c.name} (santé ${Math.round(c.health)} %)`,
          label: `Récolte ${c.name}`,
        });
      }
    }

    // Transitions notables
    const factors = { light, water, ph, humidity: hum };
    const limiting = Object.entries(factors).sort((a, b) => a[1] - b[1])[0][0];
    const band = growthBand(growthState, rate);
    if (band !== growthState) {
      bus.publish('greenhouse.growth.changed', {
        source: 'greenhouse',
        severity: band === 'nominal' ? 'info' : band === 'slowed' ? 'warn' : 'critical',
        message: `Croissance des cultures ${GROWTH_LABEL[band]} (${g.growthRate} % — lumière ${Math.round(light * 100)} %, eau ${Math.round(water * 100)} %, pH ${Math.round(ph * 100)} %)`,
        label: `Croissance ${GROWTH_LABEL[band]}`,
        data: { from: growthState, to: band, rate: g.growthRate, limiting },
        cause: band === 'nominal' ? null : causes[limiting] ?? lastCause(),
      });
      growthState = band;
    }

    if (!waterLow && g.waterLevel < 30) {
      waterLow = true;
      causes.water = bus.publish('greenhouse.water.low', {
        source: 'greenhouse',
        severity: 'warn',
        message: `Réservoir d’irrigation bas : ${g.waterLevel} %`,
        label: 'Réservoir d’eau bas',
        cause: causes.water,
      }) ?? causes.water;
    } else if (waterLow && g.waterLevel > 40) {
      waterLow = false;
    }

    const phBad = g.ph < 5.5 || g.ph > 7;
    g.status =
      g.waterLevel < 10 || g.lightLevel < 30 || g.ph < 5 || g.ph > 7.5
        ? 'critical'
        : g.waterLevel < 30 || g.lightLevel < 90 || phBad || g.humidity < 45 || g.humidity > 75
          ? 'warn'
          : 'ok';

    if (g.status === 'critical' && lastStatus !== 'critical') {
      bus.publish('greenhouse.alert', {
        source: 'greenhouse',
        severity: 'critical',
        message: 'Serre en état critique : rendement alimentaire menacé',
        label: 'Serre critique',
        data: { priority: 2, subject: 'Alerte serre — rendement alimentaire menacé' },
        cause: lastCause(),
      });
    }
    lastStatus = g.status;

    pushHistory(g.history, {
      t: state.tick,
      humidity: g.humidity,
      ph: g.ph,
      water: g.waterLevel,
      light: g.lightLevel,
      growth: g.growthRate,
    });
  }

  return { id: 'greenhouse', label: 'Serre', initialState, init, tick };
}
