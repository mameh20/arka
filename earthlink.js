// Module 5 — Lien Terre
//
// File de messages vers la Terre, triée par priorité (1 = urgent … 4 = basse).
// La bande passante dépend de l'énergie et du routeur d'antenne. Si le lien
// est coupé, les messages sont mis en attente ; au retour, une
// synchronisation à débit accéléré vide la file.
//
// Publie : earthlink.link.lost/restored, earthlink.bandwidth.changed,
//          earthlink.message.queued, earthlink.sync.started/completed,
//          earthlink.queue.overflow
// Écoute : crisis.earth-link-lost, crisis.reset, energy.mode.changed,
//          security.device.quarantined/released (ant-rtr), security.intrusion,
//          medbay.report, greenhouse.alert

import { pushHistory, round } from '../core/state.js';

const BASE_RATE = 3; // messages / tick à pleine bande passante
const SYNC_BOOST = 2;
const QUEUE_MAX = 150;
const SENT_LOG = 30;
const PRIORITY_LABEL = { 1: 'urgent', 2: 'haute', 3: 'normale', 4: 'basse' };
const ENERGY_FACTOR = { normal: 1, degraded: 0.5, critical: 0.25 };

export function createEarthlinkModule() {
  let seq = 0;
  let syncCause = null;
  let overflowWarned = false;

  function initialState() {
    return {
      status: 'ok',
      connected: true,
      bandwidth: 100, // %
      factors: { energy: 1, antenna: 1 },
      syncing: false,
      queue: [],
      sent: [],
      stats: { sent: 0, dropped: 0, synced: 0, sentThisTick: 0 },
      lastContactTick: 0,
      history: [],
    };
  }

  function makeMessage(state, priority, subject, origin) {
    return { id: `MSG-${String(++seq).padStart(5, '0')}`, priority, subject, origin, createdTick: state.tick, held: !state.earthlink.connected };
  }

  function enqueue(state, msg) {
    const q = state.earthlink.queue;
    q.push(msg);
    q.sort((a, b) => a.priority - b.priority || a.createdTick - b.createdTick);
    if (q.length > QUEUE_MAX) {
      q.pop(); // la moins prioritaire, la plus récente
      state.earthlink.stats.dropped++;
      return true;
    }
    return false;
  }

  function recomputeBandwidth(link) {
    link.bandwidth = link.connected ? Math.round(link.factors.energy * link.factors.antenna * 100) : 0;
  }

  function init({ bus, state }) {
    const link = () => state.earthlink;

    const setFactor = (key, value, cause, reason) => {
      const l = link();
      if (l.factors[key] === value) return;
      l.factors[key] = value;
      const before = l.bandwidth;
      recomputeBandwidth(l);
      if (before === l.bandwidth) return;
      bus.publish('earthlink.bandwidth.changed', {
        source: 'earthlink',
        severity: l.bandwidth < before ? 'warn' : 'info',
        message: `Bande passante vers la Terre : ${before} % → ${l.bandwidth} % (${reason})`,
        label: `Bande passante ${l.bandwidth} %`,
        data: { from: before, to: l.bandwidth },
        cause,
      });
    };

    bus.on('energy.mode.changed', (ev) => {
      setFactor('energy', ENERGY_FACTOR[ev.data.to], ev, `émetteur en mode énergie ${ev.data.to === 'normal' ? 'nominal' : 'réduit'}`);
    });

    bus.on('security.device.quarantined', (ev) => {
      if (ev.data.deviceId === 'ant-rtr') setFactor('antenna', 0.2, ev, 'routeur d’antenne isolé, liaison de secours bas débit');
    });

    bus.on('security.device.released', (ev) => {
      if (ev.data.deviceId === 'ant-rtr') setFactor('antenna', 1, ev, 'routeur d’antenne réintégré');
    });

    bus.on('crisis.earth-link-lost', (ev) => {
      const l = link();
      if (!l.connected) return;
      l.connected = false;
      l.syncing = false;
      for (const m of l.queue) m.held = true;
      recomputeBandwidth(l);
      bus.publish('earthlink.link.lost', {
        source: 'earthlink',
        severity: 'critical',
        message: `Lien Terre perdu : ${l.queue.length} message(s) en file mis en attente`,
        label: 'Lien Terre coupé',
        cause: ev,
      });
    });

    bus.on('crisis.reset', (ev) => {
      const l = link();
      if (l.connected) return;
      l.connected = true;
      recomputeBandwidth(l);
      const restored = bus.publish('earthlink.link.restored', {
        source: 'earthlink',
        message: 'Lien Terre rétabli',
        label: 'Lien Terre rétabli',
        cause: ev,
      });
      startSync(state, bus, restored);
    });

    // Messages générés par les autres modules
    const reports = {
      'medbay.report': 'infirmerie',
      'security.intrusion': 'sécurité',
      'greenhouse.alert': 'serre',
    };
    for (const [type, origin] of Object.entries(reports)) {
      bus.on(type, (ev) => {
        const { priority = 2, subject = ev.message } = ev.data;
        const msg = makeMessage(state, priority, subject, origin);
        const dropped = enqueue(state, msg);
        const l = link();
        bus.publish('earthlink.message.queued', {
          source: 'earthlink',
          severity: l.connected ? 'info' : 'warn',
          message: `${msg.id} [${PRIORITY_LABEL[priority]}] « ${subject} » ${l.connected ? `en file (position ${l.queue.indexOf(msg) + 1})` : 'mis en attente (lien coupé)'}${dropped ? ' — file pleine, message basse priorité supprimé' : ''}`,
          label: l.connected ? `Message ${PRIORITY_LABEL[priority]} vers la Terre` : 'Message mis en attente',
          data: { id: msg.id, priority },
          cause: ev,
        });
      });
    }
  }

  function startSync(state, bus, cause) {
    const l = state.earthlink;
    const pending = l.queue.length;
    if (!pending) return;
    l.syncing = true;
    syncCause = bus.publish('earthlink.sync.started', {
      source: 'earthlink',
      message: `Synchronisation : ${pending} message(s) en attente à transmettre (débit ×${SYNC_BOOST})`,
      label: `Synchronisation de ${pending} message(s)`,
      data: { pending },
      cause,
    });
  }

  function tick({ state, bus, rng }) {
    const l = state.earthlink;

    // Trafic de routine
    if (state.tick % 5 === 0) enqueue(state, makeMessage(state, 3, `Télémétrie vaisseau T+${state.tick}`, 'télémétrie'));
    if (rng.chance(0.12)) enqueue(state, makeMessage(state, 4, 'Message personnel de l’équipage', 'équipage'));
    if (l.queue.length >= QUEUE_MAX && !overflowWarned) {
      overflowWarned = true;
      bus.publish('earthlink.queue.overflow', {
        source: 'earthlink',
        severity: 'warn',
        message: `File saturée (${QUEUE_MAX}) : les messages de basse priorité sont supprimés`,
        label: 'File de messages saturée',
      });
    } else if (l.queue.length < QUEUE_MAX * 0.8) {
      overflowWarned = false;
    }

    // Transmission
    l.stats.sentThisTick = 0;
    if (l.connected && l.bandwidth > 0) {
      l.lastContactTick = state.tick;
      const capacity = Math.max(1, Math.round((BASE_RATE * l.bandwidth) / 100)) * (l.syncing ? SYNC_BOOST : 1);
      const batch = l.queue.splice(0, capacity);
      for (const msg of batch) {
        l.sent.unshift({ ...msg, sentTick: state.tick, latency: state.tick - msg.createdTick });
        l.stats.sent++;
        if (msg.held) l.stats.synced++;
      }
      l.sent.length = Math.min(l.sent.length, SENT_LOG);
      l.stats.sentThisTick = batch.length;

      if (l.syncing && !l.queue.some((m) => m.held)) {
        l.syncing = false;
        bus.publish('earthlink.sync.completed', {
          source: 'earthlink',
          message: `Synchronisation terminée : ${l.stats.synced} message(s) mis en attente transmis`,
          label: 'Synchronisation terminée',
          cause: syncCause,
        });
        syncCause = null;
      }
    }

    const held = l.queue.filter((m) => m.held).length;
    l.status = !l.connected ? 'critical' : l.bandwidth < 50 || l.queue.length > 40 || l.syncing ? 'warn' : 'ok';
    pushHistory(l.history, { t: state.tick, queue: l.queue.length, held, bandwidth: l.bandwidth, sent: l.stats.sentThisTick });
  }

  return { id: 'earthlink', label: 'Lien Terre', initialState, init, tick };
}

export { PRIORITY_LABEL };
