import { describe, it, expect, vi } from 'vitest';
import { EventBus } from '../src/core/eventBus.js';
import { createJournal } from '../src/core/journal.js';
import { allocatePower } from '../src/modules/energy.js';

describe('bus d’événements', () => {
  it('trace la causalité : parent, racine, profondeur et chemin lisible', () => {
    const bus = new EventBus();
    bus.on('a', (ev) => bus.publish('b', { label: 'B', cause: ev }));
    bus.on('b', (ev) => bus.publish('c', { label: 'C', cause: ev }));
    const seen = [];
    bus.onAny((ev) => seen.push(ev));

    const root = bus.publish('a', { label: 'A' });
    expect(seen.map((e) => e.type)).toEqual(['a', 'b', 'c']);
    const [, b, c] = seen;
    expect(b.causeId).toBe(root.id);
    expect(c.causeId).toBe(b.id);
    expect(c.rootId).toBe(root.id);
    expect(c.depth).toBe(2);
    expect(c.path).toEqual(['A', 'B', 'C']);
  });

  it('accepte les motifs par préfixe', () => {
    const bus = new EventBus();
    const handler = vi.fn();
    bus.on('energy.*', handler);
    bus.publish('energy.mode.changed');
    bus.publish('medbay.report');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('coupe une cascade infinie', () => {
    const bus = new EventBus({ maxDepth: 5 });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let count = 0;
    bus.on('ping', (ev) => {
      count++;
      bus.publish('ping', { cause: ev });
    });
    bus.publish('ping');
    expect(count).toBe(6);
    warn.mockRestore();
  });

  it('isole les erreurs d’un abonné', () => {
    const bus = new EventBus();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ok = vi.fn();
    bus.on('x', () => {
      throw new Error('boom');
    });
    bus.on('x', ok);
    bus.publish('x');
    expect(ok).toHaveBeenCalled();
    err.mockRestore();
  });
});

describe('journal SQLite', () => {
  it('enregistre la chaîne « cause → effet → effet » et ignore la télémétrie silencieuse', () => {
    const bus = new EventBus();
    const journal = createJournal(':memory:');
    journal.attach(bus);
    bus.on('a', (ev) => {
      bus.publish('telemetry', { silent: true, cause: ev });
      bus.publish('b', { label: 'effet', cause: ev });
    });
    const root = bus.publish('a', { label: 'cause' });

    const rows = journal.query('SELECT type, chain, depth FROM journal ORDER BY seq');
    expect(rows).toEqual([
      { type: 'a', chain: 'cause', depth: 0 },
      { type: 'b', chain: 'cause → effet', depth: 1 },
    ]);
    expect(journal.cascade(root.id)).toHaveLength(2);
    journal.close();
  });
});

describe('allocation énergétique', () => {
  const sectors = [
    { id: 'o2', priority: 1, demand: 30, min: 1 },
    { id: 'serre', priority: 3, demand: 25, min: 0.3 },
    { id: 'loisirs', priority: 5, demand: 10, min: 0 },
  ];

  it('alimente tout quand la puissance suffit', () => {
    expect(allocatePower(sectors, 100)).toEqual({ o2: 30, serre: 25, loisirs: 10 });
  });

  it('garantit les minimums par priorité avant de compléter', () => {
    const alloc = allocatePower(sectors, 45);
    expect(alloc.o2).toBe(30);
    expect(alloc.serre).toBe(15);
    expect(alloc.loisirs).toBe(0);
  });

  it('sacrifie les secteurs les moins prioritaires quand même les minimums ne passent pas', () => {
    const alloc = allocatePower(sectors, 20);
    expect(alloc).toEqual({ o2: 20, serre: 0, loisirs: 0 });
  });
});
