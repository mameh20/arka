// Bus d'événements du vaisseau.
//
// Chaque module publie des événements ; les autres s'y abonnent et peuvent
// publier à leur tour en indiquant l'événement déclencheur (`cause`). Le bus
// propage ainsi une chaîne de causalité : chaque événement connaît son parent
// (causeId), la racine de la cascade (rootId), sa profondeur et le chemin
// lisible « cause → effet → effet » (path).
//
// La distribution est synchrone et en largeur (file FIFO) : quand `publish`
// revient au niveau le plus haut, toute la cascade a été traitée.

const DEFAULTS = { maxDepth: 12, maxPerDrain: 1000 };

export class EventBus {
  constructor({ clock = () => 0, maxDepth, maxPerDrain, idPrefix } = {}) {
    this.clock = clock;
    this.maxDepth = maxDepth ?? DEFAULTS.maxDepth;
    this.maxPerDrain = maxPerDrain ?? DEFAULTS.maxPerDrain;
    this.idPrefix = idPrefix ?? Date.now().toString(36);
    this.subscribers = []; // { pattern, handler }
    this.queue = [];
    this.draining = false;
    this.seq = 0;
  }

  /**
   * S'abonne à un type d'événement. Motifs acceptés :
   * 'energy.mode.changed' (exact), 'energy.*' (préfixe), '*' (tout).
   * Retourne une fonction de désabonnement.
   */
  on(pattern, handler) {
    const sub = { pattern, handler };
    this.subscribers.push(sub);
    return () => {
      this.subscribers = this.subscribers.filter((s) => s !== sub);
    };
  }

  onAny(handler) {
    return this.on('*', handler);
  }

  /**
   * Publie un événement.
   * @param {string} type        ex. 'energy.sector.changed'
   * @param {object} opts
   * @param {string} opts.source   module émetteur
   * @param {string} opts.message  description complète (journal)
   * @param {string} [opts.label]  libellé court utilisé dans la chaîne de cascade
   * @param {'info'|'warn'|'critical'} [opts.severity]
   * @param {object} [opts.data]
   * @param {object} [opts.cause]  événement déclencheur
   * @param {boolean} [opts.silent] télémétrie : non journalisée
   */
  publish(type, { source = 'system', message = type, label, severity = 'info', data = {}, cause = null, silent = false } = {}) {
    const depth = cause ? cause.depth + 1 : 0;
    if (depth > this.maxDepth) {
      console.warn(`[bus] cascade tronquée (profondeur ${depth}) : ${type}`);
      return null;
    }
    const shortLabel = label ?? message;
    const id = `${this.idPrefix}-${++this.seq}`;
    const event = {
      id,
      type,
      source,
      severity,
      message,
      label: shortLabel,
      data,
      silent,
      ts: Date.now(),
      tick: this.clock(),
      causeId: cause ? cause.id : null,
      rootId: cause ? cause.rootId : id,
      depth,
      path: cause ? [...cause.path, shortLabel] : [shortLabel],
    };
    this.queue.push(event);
    this.#drain();
    return event;
  }

  #matches(pattern, type) {
    if (pattern === '*' || pattern === type) return true;
    return pattern.endsWith('.*') && type.startsWith(pattern.slice(0, -1));
  }

  #drain() {
    if (this.draining) return; // déjà en cours : l'événement sera traité par la boucle en cours
    this.draining = true;
    let processed = 0;
    try {
      while (this.queue.length) {
        const event = this.queue.shift();
        if (++processed > this.maxPerDrain) {
          console.warn(`[bus] tempête d'événements : ${this.queue.length} événements abandonnés`);
          this.queue.length = 0;
          break;
        }
        for (const sub of [...this.subscribers]) {
          if (!this.#matches(sub.pattern, event.type)) continue;
          try {
            sub.handler(event);
          } catch (err) {
            console.error(`[bus] erreur dans un abonné à ${sub.pattern} :`, err);
          }
        }
      }
    } finally {
      this.draining = false;
    }
  }
}
