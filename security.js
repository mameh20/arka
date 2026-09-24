// Module 4 — Sécurité
//
// 8 appareils IoT simulés avec un débit réseau de référence. Un débit
// dépassant `threshold × baseline` marque l'appareil comme suspect ; après
// 3 ticks consécutifs il est mis en quarantaine automatiquement. La
// quarantaine d'un appareil prive le module qui en dépend de sa fonction.
//
// Publie : security.intrusion, security.anomaly.detected,
//          security.device.quarantined/released, security.device.offline/online,
//          security.attack.ended, security.vigilance.*
// Écoute : crisis.cyberattack, crisis.reset, earthlink.link.lost/restored,
//          energy.sector.changed (loisirs)

import { pushHistory, round } from '../core/state.js';

const DEVICES = [
  { id: 'cam-01', name: 'Caméra sas principal', module: 'security', baseline: 48 },
  { id: 'o2-ctl', name: 'Régulateur O2', module: 'energy', baseline: 6 },
  { id: 'bat-bms', name: 'Gestionnaire batterie', module: 'energy', baseline: 12 },
  { id: 'hyd-pump', name: 'Contrôleur irrigation serre', module: 'greenhouse', baseline: 4 },
  { id: 'hvac-01', name: 'Capteur climat serre', module: 'greenhouse', baseline: 3 },
  { id: 'bio-mon', name: 'Moniteur biométrique', module: 'medbay', baseline: 22 },
  { id: 'ant-rtr', name: 'Routeur antenne', module: 'earthlink', baseline: 64 },
  { id: 'ent-hub', name: 'Console loisirs', module: 'loisirs', baseline: 30 },
];

const ATTACK_TARGETS = ['bat-bms', 'hyd-pump', 'ant-rtr', 'bio-mon'];
const ATTACK_DURATION = 25; // ticks
const QUARANTINE_AFTER = 3; // ticks consécutifs au-dessus du seuil
const THRESHOLD = { normal: 3, vigilant: 2 };

export function createSecurityModule() {
  let attackCause = null;
  const anomalyEvents = new Map(); // deviceId -> événement de détection (cause de la quarantaine)

  function initialState() {
    return {
      status: 'ok',
      threshold: THRESHOLD.normal,
      attack: { active: false, targets: [], ticksLeft: 0 },
      devices: DEVICES.map((d) => ({ ...d, traffic: d.baseline, status: 'ok', anomalyTicks: 0 })),
      history: [],
    };
  }

  function init({ bus, state }) {
    const sec = () => state.security;
    const device = (id) => sec().devices.find((d) => d.id === id);

    bus.on('crisis.cyberattack', (ev) => {
      Object.assign(sec().attack, { active: true, targets: [...ATTACK_TARGETS], ticksLeft: ATTACK_DURATION });
      attackCause = bus.publish('security.intrusion', {
        source: 'security',
        severity: 'critical',
        message: `Intrusion détectée : trafic anormal vers ${ATTACK_TARGETS.length} appareils (${ATTACK_TARGETS.map((id) => device(id).name).join(', ')})`,
        label: 'Intrusion réseau IoT',
        data: { priority: 1, subject: 'Rapport d’incident cybersécurité', targets: ATTACK_TARGETS },
        cause: ev,
      });
    });

    bus.on('earthlink.link.lost', (ev) => {
      sec().threshold = THRESHOLD.vigilant;
      bus.publish('security.vigilance.raised', {
        source: 'security',
        severity: 'warn',
        message: `Lien Terre coupé : plus de support du SOC terrestre, seuil de détection abaissé à ×${THRESHOLD.vigilant}`,
        label: 'Vigilance réseau renforcée',
        cause: ev,
      });
    });

    bus.on('earthlink.link.restored', (ev) => {
      sec().threshold = THRESHOLD.normal;
      bus.publish('security.vigilance.normal', { source: 'security', message: `Seuil de détection rétabli à ×${THRESHOLD.normal}`, label: 'Vigilance normale', cause: ev });
    });

    // La console de loisirs suit l'alimentation de son secteur
    bus.on('energy.sector.changed', (ev) => {
      if (ev.data.sector !== 'loisirs') return;
      const hub = device('ent-hub');
      if (hub.status === 'quarantined') return;
      const off = ev.data.to === 'cut';
      if (off === (hub.status === 'offline')) return;
      hub.status = off ? 'offline' : 'ok';
      hub.anomalyTicks = 0;
      bus.publish(off ? 'security.device.offline' : 'security.device.online', {
        source: 'security',
        message: `${hub.name} ${off ? 'hors tension (délestage)' : 'de nouveau sous tension'}`,
        label: `${hub.name} ${off ? 'hors tension' : 'sous tension'}`,
        data: { deviceId: hub.id },
        cause: ev,
      });
    });

    bus.on('crisis.reset', (ev) => {
      const s = sec();
      Object.assign(s.attack, { active: false, targets: [], ticksLeft: 0 });
      attackCause = null;
      anomalyEvents.clear();
      for (const d of s.devices) {
        d.anomalyTicks = 0;
        if (d.status !== 'quarantined') {
          if (d.status === 'suspect') d.status = 'ok';
          continue;
        }
        d.status = 'ok';
        bus.publish('security.device.released', {
          source: 'security',
          message: `${d.name} levé de quarantaine après vérification`,
          label: `${d.name} réintégré`,
          data: { deviceId: d.id, module: d.module },
          cause: ev,
        });
      }
    });
  }

  function tick({ state, bus, rng }) {
    const s = state.security;
    const point = { t: state.tick };

    for (const d of s.devices) {
      if (d.status === 'quarantined' || d.status === 'offline') {
        d.traffic = 0;
        point[d.id] = 0;
        continue;
      }
      const attacked = s.attack.active && s.attack.targets.includes(d.id);
      d.traffic = round(Math.max(0, d.baseline * (1 + rng.gauss(0, 0.1)) + (attacked ? d.baseline * rng.range(5, 9) : 0)));
      point[d.id] = d.traffic;

      if (d.traffic > d.baseline * s.threshold) {
        d.anomalyTicks++;
        if (d.anomalyTicks === 1) {
          d.status = 'suspect';
          const anomaly = bus.publish('security.anomaly.detected', {
            source: 'security',
            severity: 'warn',
            message: `Débit anormal : ${d.name} à ${Math.round(d.traffic)} ko/s (référence ${d.baseline} ko/s, seuil ×${s.threshold})`,
            label: `Débit anormal ${d.name}`,
            data: { deviceId: d.id },
            cause: attacked ? attackCause : null,
          });
          anomalyEvents.set(d.id, anomaly);
        } else if (d.anomalyTicks >= QUARANTINE_AFTER) {
          d.status = 'quarantined';
          d.traffic = 0;
          point[d.id] = 0;
          bus.publish('security.device.quarantined', {
            source: 'security',
            severity: 'critical',
            message: `Quarantaine automatique : ${d.name} isolé du réseau (${QUARANTINE_AFTER} ticks au-dessus du seuil)`,
            label: `${d.name} en quarantaine`,
            data: { deviceId: d.id, module: d.module },
            cause: anomalyEvents.get(d.id) ?? null,
          });
          anomalyEvents.delete(d.id);
        }
      } else if (d.status === 'suspect') {
        d.status = 'ok';
        d.anomalyTicks = 0;
      } else {
        d.anomalyTicks = 0;
      }
    }

    if (s.attack.active && --s.attack.ticksLeft <= 0) {
      s.attack.active = false;
      bus.publish('security.attack.ended', {
        source: 'security',
        message: 'Trafic malveillant interrompu — appareils en quarantaine maintenus isolés jusqu’à vérification',
        label: 'Attaque contenue',
        cause: attackCause,
      });
    }

    const quarantined = s.devices.filter((d) => d.status === 'quarantined').length;
    const suspect = s.devices.some((d) => d.status === 'suspect');
    s.status = s.attack.active ? 'critical' : quarantined || suspect || s.threshold !== THRESHOLD.normal ? 'warn' : 'ok';
    point.total = round(s.devices.reduce((sum, d) => sum + d.traffic, 0));
    pushHistory(s.history, point);
  }

  return { id: 'security', label: 'Sécurité', initialState, init, tick };
}
