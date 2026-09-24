// Module 2 — Infirmerie
//
// 20 astronautes aux constantes simulées (température, SpO2, FC) et triés en
// vert / orange / rouge. Les patients graves demandent de l'énergie
// (assistance respiratoire), une équipe malade suspend la maintenance de la
// serre, et chaque aggravation génère un rapport médical vers la Terre.
//
// Publie : medbay.outbreak, medbay.contagion, medbay.patient.critical,
//          medbay.power.request, medbay.staffing.low/restored, medbay.report,
//          medbay.crew.stress, medbay.telemetry.*, medbay.telemedicine.*
// Écoute : crisis.epidemic, crisis.reset, energy.allocation, energy.sector.changed,
//          security.device.quarantined/released, earthlink.link.lost/restored

import { approach, clamp, pushHistory, round } from '../core/state.js';

const CREW = [
  ['Élise Marchand', 'Commandante'], ['Yusuf Adeyemi', 'Second'], ['Mei Tanaka', 'Pilote'],
  ['Lucas Ferreira', 'Ingénieur propulsion'], ['Amara Diallo', 'Médecin chef'], ['Ivan Petrov', 'Ingénieur énergie'],
  ['Sofia Lindqvist', 'Botaniste'], ['Rahul Mehta', 'Officier réseau'], ['Chloé Dubois', 'Infirmière'],
  ['Kwame Mensah', 'Géologue'], ['Ana Morales', 'Biologiste'], ['Tomás Novak', 'Technicien'],
  ['Leïla Haddad', 'Communications'], ['Jonas Weber', 'Navigateur'], ['Nia Okafor', 'Chimiste'],
  ['Hugo Lefèvre', 'Mécanicien'], ['Sara Rossi', 'Psychologue'], ['Kenji Sato', 'Roboticien'],
  ['Inès Benali', 'Agronome'], ['Olaf Berg', 'Officier sécurité'],
];

const INFECTION_DURATION = 150; // ticks avant guérison (infirmerie alimentée)

export function triageOf({ temp, spo2, hr }) {
  if (temp >= 39.5 || spo2 < 90 || hr > 130) return 'red';
  if (temp >= 38 || spo2 < 94 || hr > 105) return 'orange';
  return 'green';
}

export function createMedbayModule() {
  let epidemicCause = null;
  let lastCause = null;
  let requested = { infirmerieKw: 0, o2Kw: 0 };
  let reportedReds = 0;

  function initialState(rng) {
    return {
      status: 'ok',
      o2Ratio: 1,
      powerRatio: 1,
      stress: 0,
      telemetryOk: true,
      remoteSupport: true,
      epidemicActive: false,
      staffingLow: false,
      counts: { green: CREW.length, orange: 0, red: 0 },
      crew: CREW.map(([name, role], i) => {
        const base = { temp: round(rng.range(36.5, 37.0), 2), spo2: round(rng.range(97, 99.5), 1), hr: Math.round(rng.range(58, 78)) };
        return { id: `A${String(i + 1).padStart(2, '0')}`, name, role, base, ...base, severity: 0, infected: false, infectedTicks: 0, triage: 'green', stale: false };
      }),
      history: [],
    };
  }

  function infect(m, rng) {
    m.infected = true;
    m.infectedTicks = 0;
    m.severityTarget = rng.range(0.55, 1); // toutes les infections ne sont pas graves
  }

  function init({ bus, state, rng }) {
    const med = () => state.medbay;

    bus.on('crisis.epidemic', (ev) => {
      const m = med();
      m.epidemicActive = true;
      const healthy = m.crew.filter((a) => !a.infected);
      const victims = [];
      for (let i = 0; i < 6 && healthy.length; i++) {
        const [a] = healthy.splice(Math.floor(rng.next() * healthy.length), 1);
        infect(a, rng);
        if (i === 0) a.severityTarget = 1; // le patient zéro développe toujours une forme grave
        victims.push(a.name);
      }
      epidemicCause = bus.publish('medbay.outbreak', {
        source: 'medbay',
        severity: 'critical',
        message: `Foyer infectieux : ${victims.length} astronautes contaminés (${victims.join(', ')}) — isolement en infirmerie`,
        label: `${victims.length} astronautes contaminés`,
        data: { victims },
        cause: ev,
      });
      lastCause = epidemicCause;
    });

    bus.on('energy.allocation', (ev) => {
      med().o2Ratio = ev.data.o2 ?? 1;
      med().powerRatio = ev.data.infirmerie ?? 1;
    });

    bus.on('energy.sector.changed', (ev) => {
      const { sector, to } = ev.data;
      if (sector === 'loisirs') {
        const stressed = to !== 'full';
        if (stressed === (med().stress > 0)) return;
        med().stress = stressed ? 1 : 0;
        bus.publish('medbay.crew.stress', {
          source: 'medbay',
          severity: stressed ? 'warn' : 'info',
          message: stressed
            ? 'Loisirs coupés : niveau de stress de l’équipage en hausse (FC +10 bpm)'
            : 'Loisirs rétablis : stress de l’équipage en baisse',
          label: stressed ? 'Stress équipage ↑' : 'Stress équipage ↓',
          cause: ev,
        });
      } else if (sector === 'o2' && to !== 'full') {
        lastCause = bus.publish('medbay.hypoxia.risk', {
          source: 'medbay',
          severity: 'critical',
          message: 'Alimentation O2 insuffisante : risque d’hypoxie pour tout l’équipage',
          label: 'Risque d’hypoxie',
          cause: ev,
        });
      } else if (sector === 'infirmerie' && to !== 'full') {
        lastCause = bus.publish('medbay.care.degraded', {
          source: 'medbay',
          severity: 'critical',
          message: 'Infirmerie sous-alimentée : soins ralentis, guérisons retardées',
          label: 'Soins ralentis',
          cause: ev,
        });
      }
    });

    bus.on('security.device.quarantined', (ev) => {
      if (ev.data.deviceId !== 'bio-mon') return;
      med().telemetryOk = false;
      for (const a of med().crew) a.stale = true;
      lastCause = bus.publish('medbay.telemetry.lost', {
        source: 'medbay',
        severity: 'warn',
        message: 'Moniteur biométrique en quarantaine : constantes figées, relevés manuels toutes les heures',
        label: 'Télémétrie médicale perdue',
        cause: ev,
      });
    });

    bus.on('security.device.released', (ev) => {
      if (ev.data.deviceId !== 'bio-mon') return;
      med().telemetryOk = true;
      for (const a of med().crew) a.stale = false;
      bus.publish('medbay.telemetry.restored', { source: 'medbay', message: 'Télémétrie médicale rétablie', label: 'Télémétrie médicale rétablie', cause: ev });
    });

    bus.on('earthlink.link.lost', (ev) => {
      med().remoteSupport = false;
      bus.publish('medbay.telemedicine.offline', {
        source: 'medbay',
        severity: 'warn',
        message: 'Télémédecine indisponible : l’infirmerie passe en protocole autonome',
        label: 'Protocole médical autonome',
        cause: ev,
      });
    });

    bus.on('earthlink.link.restored', (ev) => {
      med().remoteSupport = true;
      bus.publish('medbay.telemedicine.online', { source: 'medbay', message: 'Télémédecine rétablie avec le centre médical terrestre', label: 'Télémédecine rétablie', cause: ev });
    });

    bus.on('crisis.reset', () => {
      const m = med();
      m.epidemicActive = false;
      for (const a of m.crew) {
        a.infected = false;
        a.severityTarget = 0;
      }
      epidemicCause = null;
      reportedReds = 0;
    });
  }

  function tick({ state, bus, rng }) {
    const m = state.medbay;

    // Contagion tant que l'épidémie est active
    if (m.epidemicActive && state.tick % 12 === 0) {
      const healthy = m.crew.filter((a) => !a.infected && a.severity < 0.05);
      const infectedCount = m.crew.length - healthy.length;
      if (healthy.length && infectedCount < 14) {
        const a = rng.pick(healthy);
        infect(a, rng);
        lastCause = bus.publish('medbay.contagion', {
          source: 'medbay',
          severity: 'warn',
          message: `Nouveau cas : ${a.name} (${a.role}) présente des symptômes`,
          label: `Nouveau cas : ${a.name}`,
          cause: epidemicCause,
        });
      }
    }

    // Évolution des constantes
    const healingSpeed = (m.powerRatio >= 0.9 ? 1 : 0.4) * (m.remoteSupport ? 1 : 0.8);
    for (const a of m.crew) {
      if (a.infected) {
        a.infectedTicks += healingSpeed;
        if (a.infectedTicks > INFECTION_DURATION) {
          a.infected = false;
          a.severityTarget = 0;
        }
      }
      a.severity = approach(a.severity, a.infected ? a.severityTarget : 0, a.infected ? 0.05 : 0.03);
      if (!m.telemetryOk) continue; // capteurs isolés : dernières valeurs connues
      const hypoxia = (1 - m.o2Ratio) * 12;
      const targetTemp = a.base.temp + 3 * a.severity;
      const targetSpo2 = a.base.spo2 - 10 * a.severity - hypoxia;
      const targetHr = a.base.hr + 50 * a.severity + 10 * m.stress + hypoxia * 2;
      a.temp = round(clamp(approach(a.temp, targetTemp, 0.2) + rng.gauss(0, 0.04), 34, 42), 2);
      a.spo2 = round(clamp(approach(a.spo2, targetSpo2, 0.2) + rng.gauss(0, 0.2), 70, 100), 1);
      a.hr = Math.round(clamp(approach(a.hr, targetHr, 0.2) + rng.gauss(0, 1), 40, 190));

      const triage = triageOf(a);
      if (triage === 'red' && a.triage !== 'red') {
        lastCause = bus.publish('medbay.patient.critical', {
          source: 'medbay',
          severity: 'critical',
          message: `Triage ROUGE : ${a.name} — ${a.temp} °C, SpO2 ${a.spo2} %, FC ${a.hr} bpm`,
          label: `${a.name} en triage rouge`,
          data: { id: a.id },
          cause: epidemicCause ?? lastCause,
        });
      }
      a.triage = triage;
    }

    const counts = { green: 0, orange: 0, red: 0 };
    for (const a of m.crew) counts[a.triage]++;
    m.counts = counts;

    // Assistance respiratoire : demande d'énergie supplémentaire
    const need = { infirmerieKw: counts.red * 4 + counts.orange * 2, o2Kw: counts.red };
    if (Math.abs(need.infirmerieKw - requested.infirmerieKw) >= 4 || need.o2Kw !== requested.o2Kw) {
      requested = need;
      bus.publish('medbay.power.request', {
        source: 'medbay',
        severity: need.infirmerieKw > 0 ? 'warn' : 'info',
        message: `Assistance respiratoire : ${counts.red} rouge(s), ${counts.orange} orange(s) — besoin infirmerie +${need.infirmerieKw} kW`,
        label: `Assistance respiratoire (${counts.red} R / ${counts.orange} O)`,
        data: need,
        cause: counts.red + counts.orange > 0 ? lastCause : null,
      });
    }

    // Effectif disponible
    const unavailable = counts.orange + counts.red;
    if (!m.staffingLow && unavailable > 5) {
      m.staffingLow = true;
      bus.publish('medbay.staffing.low', {
        source: 'medbay',
        severity: 'warn',
        message: `${unavailable} astronautes inaptes au service : tâches non essentielles suspendues`,
        label: `${unavailable} astronautes inaptes`,
        cause: lastCause,
      });
    } else if (m.staffingLow && unavailable <= 2) {
      m.staffingLow = false;
      bus.publish('medbay.staffing.restored', { source: 'medbay', message: 'Effectif opérationnel rétabli', label: 'Effectif rétabli' });
    }

    // Rapport médical vers la Terre à chaque nouveau patient critique
    if (counts.red > reportedReds) {
      bus.publish('medbay.report', {
        source: 'medbay',
        severity: 'warn',
        message: `Rapport médical transmis au lien Terre : ${counts.red} patient(s) en triage rouge`,
        label: 'Rapport médical urgent',
        data: { priority: 1, subject: `Rapport médical — ${counts.red} patient(s) critique(s)` },
        cause: lastCause,
      });
    }
    reportedReds = counts.red;

    m.status = counts.red > 0 ? 'critical' : counts.orange > 0 || !m.telemetryOk ? 'warn' : 'ok';
    const avg = (k) => round(m.crew.reduce((s, a) => s + a[k], 0) / m.crew.length, 2);
    pushHistory(m.history, { t: state.tick, temp: avg('temp'), spo2: avg('spo2'), hr: avg('hr'), ...counts });
  }

  return { id: 'medbay', label: 'Infirmerie', initialState, init, tick };
}
