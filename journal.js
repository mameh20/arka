// Journal de bord central (SQLite).
//
// S'abonne à tout le bus et enregistre chaque événement non silencieux avec
// sa chaîne de causalité complète (« cause → effet → effet »), ce qui permet
// de relire n'importe quelle cascade a posteriori.

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const RECENT_MAX = 200;
const CHAIN_SEP = ' → ';

export function createJournal(dbPath = ':memory:') {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS journal (
      seq       INTEGER PRIMARY KEY AUTOINCREMENT,
      id        TEXT NOT NULL UNIQUE,
      ts        INTEGER NOT NULL,
      tick      INTEGER NOT NULL,
      type      TEXT NOT NULL,
      source    TEXT NOT NULL,
      severity  TEXT NOT NULL,
      message   TEXT NOT NULL,
      cause_id  TEXT,
      root_id   TEXT NOT NULL,
      depth     INTEGER NOT NULL,
      chain     TEXT NOT NULL,
      data      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_journal_root ON journal(root_id);
  `);

  const insert = db.prepare(`
    INSERT INTO journal (id, ts, tick, type, source, severity, message, cause_id, root_id, depth, chain, data)
    VALUES (@id, @ts, @tick, @type, @source, @severity, @message, @causeId, @rootId, @depth, @chain, @data)
  `);
  const selectRecent = db.prepare('SELECT * FROM journal ORDER BY seq DESC LIMIT ?');
  const selectCascade = db.prepare('SELECT * FROM journal WHERE root_id = ? ORDER BY seq ASC');
  const selectCascadeRoots = db.prepare(`
    SELECT root_id, COUNT(*) AS size, MAX(depth) AS max_depth, MIN(seq) AS first_seq
    FROM journal GROUP BY root_id HAVING size > 1 ORDER BY first_seq DESC LIMIT ?
  `);

  const toEntry = (row) => ({
    id: row.id,
    ts: row.ts,
    tick: row.tick,
    type: row.type,
    source: row.source,
    severity: row.severity,
    message: row.message,
    causeId: row.cause_id,
    rootId: row.root_id,
    depth: row.depth,
    chain: row.chain,
  });

  // Tampon mémoire des dernières entrées (ordre chronologique) + entrées pas encore diffusées
  const recent = selectRecent.all(RECENT_MAX).reverse().map(toEntry);
  let pending = [];

  function record(event) {
    if (event.silent) return;
    const entry = {
      id: event.id,
      ts: event.ts,
      tick: event.tick,
      type: event.type,
      source: event.source,
      severity: event.severity,
      message: event.message,
      causeId: event.causeId,
      rootId: event.rootId,
      depth: event.depth,
      chain: event.path.join(CHAIN_SEP),
    };
    insert.run({ ...entry, data: JSON.stringify(event.data ?? {}) });
    recent.push(entry);
    if (recent.length > RECENT_MAX) recent.shift();
    pending.push(entry);
  }

  return {
    db,
    attach(bus) {
      return bus.onAny(record);
    },
    /** Dernières entrées, de la plus ancienne à la plus récente. */
    recent(limit = RECENT_MAX) {
      return recent.slice(-limit);
    },
    /** Entrées enregistrées depuis le dernier appel (pour la diffusion). */
    drainPending() {
      const out = pending;
      pending = [];
      return out;
    },
    /** Toutes les étapes d'une cascade, dans l'ordre. */
    cascade(rootId) {
      return selectCascade.all(rootId).map(toEntry);
    },
    /** Résumé des dernières cascades (au moins un effet). */
    cascades(limit = 20) {
      return selectCascadeRoots.all(limit).map((r) => ({
        rootId: r.root_id,
        size: r.size,
        maxDepth: r.max_depth,
        steps: selectCascade.all(r.root_id).map(toEntry),
      }));
    },
    query(sql, ...params) {
      return db.prepare(sql).all(...params);
    },
    close() {
      db.close();
    },
  };
}
