import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createSimulation } from '../src/core/simulation.js';

const sector = (state, id) => state.energy.sectors.find((s) => s.id === id);
const device = (state, id) => state.security.devices.find((d) => d.id === id);

/** Toutes les étapes d'une cascade enregistrées dans SQLite, pour une racine donnée. */
const stepsOf = (sim, rootId) => sim.journal.cascade(rootId);
const types = (steps) => steps.map((s) => s.type);

let sim;
beforeEach(() => {
  sim = createSimulation({ seed: Number(process.env.SEED ?? 42) });
  sim.run(10); // quelques ticks de régime nominal
});
afterEach(() => sim.close());

describe('état nominal', () => {
  it('démarre avec tous les modules au vert et tous les secteurs alimentés', () => {
    const { state } = sim;
    for (const id of ['energy', 'medbay', 'greenhouse', 'security', 'earthlink']) expect(state[id].status).toBe('ok');
    expect(state.energy.sectors.every((s) => s.ratio === 1)).toBe(true);
    expect(state.medbay.crew).toHaveLength(20);
    expect(state.security.devices).toHaveLength(8);
  });
});

describe('crise energy50', () => {
  it('réduit l’éclairage de la serre', () => {
    const before = sim.state.greenhouse.lightLevel;
    sim.triggerCrisis('energy50');
    expect(sector(sim.state, 'serre').ratio).toBeLessThan(1);

    sim.run(5);
    expect(sim.state.greenhouse.lightLevel).toBeLessThan(before);
    expect(sim.state.greenhouse.lightLevel).toBeLessThan(90);
  });

  it('déleste par priorité : O2 et infirmerie intacts, loisirs coupés, mode dégradé', () => {
    sim.triggerCrisis('energy50');
    const { state } = sim;
    expect(sector(state, 'o2').ratio).toBe(1);
    expect(sector(state, 'infirmerie').ratio).toBe(1);
    expect(sector(state, 'loisirs').band).toBe('cut');
    expect(state.energy.mode).toBe('degraded');
    // la priorité est respectée : chaque secteur est au moins aussi alimenté que les suivants
    const ratios = [...state.energy.sectors].sort((a, b) => a.priority - b.priority).map((s) => s.ratio);
    for (let i = 1; i < ratios.length; i++) expect(ratios[i]).toBeLessThanOrEqual(ratios[i - 1]);
  });

  it('journalise la cascade crise → énergie → serre → croissance dans SQLite', () => {
    const root = sim.triggerCrisis('energy50');
    sim.run(10);
    const steps = stepsOf(sim, root.id);
    expect(types(steps)).toEqual(
      expect.arrayContaining(['crisis.energy50', 'energy.production.drop', 'energy.sector.changed', 'greenhouse.lighting.changed', 'greenhouse.growth.changed']),
    );
    const lighting = steps.find((s) => s.type === 'greenhouse.lighting.changed');
    expect(lighting.depth).toBeGreaterThanOrEqual(3);
    expect(lighting.chain).toMatch(/^Crise : Perte de 50 % .* → Production solaire −50 % → Serre réduit .* → Éclairage serre \d+ %$/);
    // chaque étape pointe vers une étape existante de la même cascade
    const ids = new Set(steps.map((s) => s.id));
    for (const s of steps.slice(1)) expect(ids.has(s.causeId)).toBe(true);
  });

  it('propage aux autres modules : stress équipage, console loisirs, bande passante', () => {
    const root = sim.triggerCrisis('energy50');
    const t = types(stepsOf(sim, root.id));
    expect(t).toContain('medbay.crew.stress');
    expect(t).toContain('security.device.offline');
    expect(t).toContain('earthlink.bandwidth.changed');
    expect(sim.state.medbay.stress).toBe(1);
    expect(device(sim.state, 'ent-hub').status).toBe('offline');
    expect(sim.state.earthlink.bandwidth).toBeLessThan(100);
  });
});

describe('crise epidemic', () => {
  it('fait apparaître des patients graves qui augmentent la demande énergétique de l’infirmerie', () => {
    const root = sim.triggerCrisis('epidemic');
    sim.run(40);
    const { state } = sim;
    expect(state.medbay.counts.green).toBeLessThan(20);
    expect(state.medbay.counts.orange + state.medbay.counts.red).toBeGreaterThan(0);
    expect(sector(state, 'infirmerie').demand).toBeGreaterThan(sector(state, 'infirmerie').baseDemand);
    expect(types(stepsOf(sim, root.id))).toEqual(expect.arrayContaining(['medbay.outbreak', 'medbay.power.request', 'energy.demand.changed']));
  });

  it('envoie un rapport médical urgent vers la Terre et suspend la maintenance de la serre', () => {
    const root = sim.triggerCrisis('epidemic');
    sim.run(60);
    const t = types(stepsOf(sim, root.id));
    expect(t).toEqual(expect.arrayContaining(['medbay.patient.critical', 'medbay.report', 'earthlink.message.queued', 'medbay.staffing.low', 'greenhouse.maintenance.suspended']));
    const sentOrQueued = [...sim.state.earthlink.sent, ...sim.state.earthlink.queue];
    expect(sentOrQueued.some((m) => m.priority === 1 && m.origin === 'infirmerie')).toBe(true);
    expect(sim.state.greenhouse.maintenance).toBe(false);
  });
});

describe('crise cyberattack', () => {
  it('détecte le débit anormal puis met les appareils ciblés en quarantaine', () => {
    sim.triggerCrisis('cyberattack');
    sim.run(1);
    expect(device(sim.state, 'ant-rtr').status).toBe('suspect');
    sim.run(3);
    for (const id of ['bat-bms', 'hyd-pump', 'ant-rtr', 'bio-mon']) expect(device(sim.state, id).status).toBe('quarantined');
    expect(device(sim.state, 'o2-ctl').status).toBe('ok');
  });

  it('chaque quarantaine prive le module lié de sa fonction', () => {
    const root = sim.triggerCrisis('cyberattack');
    sim.run(5);
    const { state } = sim;
    expect(state.energy.battery.safeMode).toBe(true);
    expect(state.greenhouse.irrigationAuto).toBe(false);
    expect(state.medbay.telemetryOk).toBe(false);
    expect(state.earthlink.bandwidth).toBeLessThanOrEqual(20);

    const steps = stepsOf(sim, root.id);
    const battery = steps.find((s) => s.type === 'energy.battery.safemode');
    expect(battery.chain).toBe(
      'Crise : Cyberattaque → Intrusion réseau IoT → Débit anormal Gestionnaire batterie → Gestionnaire batterie en quarantaine → Batterie bridée (mode sécurité)',
    );
    expect(types(steps)).toEqual(expect.arrayContaining(['greenhouse.irrigation.offline', 'medbay.telemetry.lost', 'earthlink.bandwidth.changed']));
  });

  it('sans irrigation automatique, le niveau d’eau de la serre baisse', () => {
    sim.triggerCrisis('cyberattack');
    sim.run(5);
    const water = sim.state.greenhouse.waterLevel;
    sim.run(30);
    expect(sim.state.greenhouse.waterLevel).toBeLessThan(water);
  });
});

describe('crises combinées', () => {
  it('attribue le ralentissement de la serre au facteur réellement limitant', () => {
    const energy = sim.triggerCrisis('energy50');
    sim.run(2);
    sim.triggerCrisis('cyberattack'); // coupe aussi l'irrigation, mais l'eau reste suffisante
    sim.run(20);
    const growth = sim.journal
      .query("SELECT data, root_id AS rootId, chain FROM journal WHERE type = 'greenhouse.growth.changed' ORDER BY seq DESC LIMIT 1")
      .map((r) => ({ ...r, data: JSON.parse(r.data) }))[0];
    expect(growth.data.limiting).toBe('light');
    expect(growth.rootId).toBe(energy.id);
    expect(growth.chain).toContain('Éclairage serre');
  });

  it('n’oscille pas entre deux bandes de croissance autour d’un seuil', () => {
    sim.triggerCrisis('energy50');
    sim.run(200);
    const changes = sim.journal.query("SELECT tick FROM journal WHERE type = 'greenhouse.growth.changed'");
    for (let i = 1; i < changes.length; i++) expect(changes[i].tick - changes[i - 1].tick).toBeGreaterThan(2);
  });
});

describe('crise earth-link-lost', () => {
  it('met les messages en attente puis les synchronise au retour du lien', () => {
    const root = sim.triggerCrisis('earth-link-lost');
    expect(sim.state.earthlink.connected).toBe(false);
    expect(sim.state.medbay.remoteSupport).toBe(false);
    expect(sim.state.security.threshold).toBe(2);
    expect(types(stepsOf(sim, root.id))).toEqual(expect.arrayContaining(['earthlink.link.lost', 'medbay.telemedicine.offline', 'security.vigilance.raised']));

    const sentBefore = sim.state.earthlink.stats.sent;
    sim.run(30);
    expect(sim.state.earthlink.stats.sent).toBe(sentBefore);
    const held = sim.state.earthlink.queue.length;
    expect(held).toBeGreaterThan(0);

    const reset = sim.triggerCrisis('reset');
    expect(types(stepsOf(sim, reset.id))).toEqual(expect.arrayContaining(['earthlink.link.restored', 'earthlink.sync.started']));
    sim.run(30);
    expect(sim.state.earthlink.syncing).toBe(false);
    expect(sim.state.earthlink.stats.synced).toBeGreaterThanOrEqual(held);
    expect(types(stepsOf(sim, reset.id))).toContain('earthlink.sync.completed');
  });

  it('transmet les messages urgents avant les messages de routine', () => {
    sim.triggerCrisis('earth-link-lost');
    sim.run(10);
    sim.triggerCrisis('cyberattack'); // génère un rapport d'incident urgent
    sim.run(10);
    const queue = sim.state.earthlink.queue;
    const priorities = queue.map((m) => m.priority);
    expect(priorities).toEqual([...priorities].sort((a, b) => a - b));
    expect(queue[0]).toMatchObject({ priority: 1, origin: 'sécurité' });
    expect(queue.at(-1).priority).toBeGreaterThan(1);
  });
});

describe('reset', () => {
  it('ramène tous les modules à l’état nominal', () => {
    for (const c of ['energy50', 'epidemic', 'cyberattack', 'earth-link-lost']) sim.triggerCrisis(c);
    sim.run(30);
    sim.triggerCrisis('reset');
    sim.run(250);
    const { state } = sim;
    expect(Object.values(state.crises).every((v) => v === false)).toBe(true);
    expect(state.energy.productionFactor).toBe(1);
    expect(state.energy.battery.safeMode).toBe(false);
    expect(state.security.devices.every((d) => d.status === 'ok')).toBe(true);
    expect(state.earthlink.connected).toBe(true);
    expect(state.medbay.counts.red).toBe(0);
    expect(state.greenhouse.irrigationAuto).toBe(true);
  });

  it('refuse une crise inconnue', () => {
    expect(() => sim.triggerCrisis('asteroid')).toThrow(/inconnue/);
  });
});
