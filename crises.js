// Crises déclenchables depuis le poste de commandement.
//
// Une crise ne modifie jamais directement l'état d'un module : elle publie un
// événement racine `crisis.<nom>` sur le bus, et ce sont les modules abonnés
// qui réagissent, déclenchant à leur tour d'autres effets (cascade).

export const CRISES = {
  energy50: {
    label: 'Perte de 50 % de l’énergie',
    message: 'CRISE — Panneaux solaires endommagés : production réduite de 50 %',
  },
  epidemic: {
    label: 'Épidémie à bord',
    message: 'CRISE — Agent infectieux détecté dans l’équipage',
  },
  cyberattack: {
    label: 'Cyberattaque',
    message: 'CRISE — Intrusion sur le réseau IoT du vaisseau',
  },
  'earth-link-lost': {
    label: 'Perte du lien Terre',
    message: 'CRISE — Antenne longue portée hors service : lien Terre perdu',
  },
  reset: {
    label: 'Retour à la normale',
    message: 'Commandement : fin d’alerte, retour aux paramètres nominaux',
  },
};

export function triggerCrisis({ bus, state }, name) {
  const crisis = CRISES[name];
  if (!crisis) {
    const err = new Error(`Crise inconnue : ${name}`);
    err.code = 'UNKNOWN_CRISIS';
    throw err;
  }
  if (name === 'reset') {
    for (const key of Object.keys(state.crises)) state.crises[key] = false;
  } else {
    state.crises[name] = true;
  }
  return bus.publish(`crisis.${name}`, {
    source: 'commandement',
    severity: name === 'reset' ? 'info' : 'critical',
    message: crisis.message,
    label: name === 'reset' ? 'Retour à la normale' : `Crise : ${crisis.label}`,
    data: { crisis: name },
  });
}
