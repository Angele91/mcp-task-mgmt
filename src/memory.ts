/**
 * Global memory store — an implementation of Karpathy's "system prompt
 * learning" / LLM Wiki pattern.
 *
 * Two layers:
 *   1. Raw notes (`memories`) — append-only, model-authored observations
 *      (lessons, facts, preferences, decisions), keyword-searchable via FTS5.
 *   2. A single compiled "wiki" (`memory_meta` key `'wiki'`) — the model
 *      periodically reviews the raw notes and rewrites them into one
 *      de-duplicated markdown document, which clients load into context.
 *
 * Lifecycle: remember (write) → recall (retrieve) → consolidate (compile) →
 * load (the wiki, exposed as an MCP resource).
 *
 * This is a separate DB from the per-project task store: memory is global and
 * lives in the user's home dir, shared across every project.
 */
import Database from "better-sqlite3";
import { nowIso, formatId, parseId } from "./store.js";

export type MemoryKind = "lesson" | "fact" | "preference" | "decision";
export const MEMORY_KINDS = ["lesson", "fact", "preference", "decision"] as const;

export interface Memory {
  id: string; // "memory-N"
  content: string;
  kind: MemoryKind;
  tags: string[];
  source: string | null;
  salience: number; // 1..5
  createdAt: string;
  updatedAt: string;
}

export interface RecalledMemory extends Memory {
  /** bm25 relevance score; more negative = more relevant. */
  rank: number;
}

export interface DuplicateCandidate {
  a: string; // memory id
  b: string; // memory id
  score: number; // Jaccard token overlap, 0..1; higher = closer
}

const PREFIX = "memory";

/**
 * Minimum Jaccard token overlap for two notes to count as near-duplicates.
 * Jaccard is corpus-size independent (unlike bm25, which collapses toward zero
 * on tiny corpora), making it a stable advisory threshold. Tunable.
 */
const DUP_THRESHOLD = 0.3;

interface MemoryRow {
  id: number;
  content: string;
  kind: MemoryKind;
  tags: string;
  source: string | null;
  salience: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * Turn arbitrary text into a safe FTS5 MATCH query: bare punctuation and FTS
 * operators (`"`, `*`, `:`, `(`, `-`, `AND`/`OR`/`NEAR`, …) would otherwise be
 * interpreted as query syntax and throw. We keep only word tokens, quote each
 * (doubling embedded quotes), and OR them for recall-friendly matching.
 * Returns `'""'` (matches nothing) when there are no usable tokens.
 */
export function ftsQuery(raw: string): string {
  const tokens = raw.match(/\w+/gu) ?? [];
  if (tokens.length === 0) return '""';
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");
}

/** Normalize a tag array into a comma-delimited string for storage. */
function tagsToString(tags: string[] | undefined): string {
  if (!tags) return "";
  return tags
    .map((t) => t.replace(/,/g, " ").trim()) // commas would corrupt the split
    .filter((t) => t.length > 0)
    .join(",");
}

function tagsToArray(stored: string): string[] {
  return stored
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/** Lowercased word tokens of length >= 2, as a set, for similarity scoring. */
function contentTokens(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/\w+/gu) ?? []).filter((t) => t.length >= 2));
}

/** Jaccard overlap of two token sets: |A ∩ B| / |A ∪ B|, in [0, 1]. */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

function clampSalience(n: number | undefined): number {
  if (n === undefined || Number.isNaN(n)) return 3;
  return Math.min(5, Math.max(1, Math.round(n)));
}

export class MemoryStore {
  private db: Database.Database;

  /**
   * @param path SQLite file path, or ":memory:" for an ephemeral database.
   */
  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        content   TEXT NOT NULL,
        kind      TEXT NOT NULL DEFAULT 'lesson'
                    CHECK (kind IN ('lesson','fact','preference','decision')),
        tags      TEXT NOT NULL DEFAULT '',
        source    TEXT,
        salience  INTEGER NOT NULL DEFAULT 3 CHECK (salience BETWEEN 1 AND 5),
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_memories_kind ON memories(kind);

      -- External-content FTS5 mirror over the searchable text columns.
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        content,
        tags,
        content='memories',
        content_rowid='id',
        tokenize='porter unicode61'
      );

      -- Keep the FTS index in sync. The 'delete'-insert form is the canonical
      -- external-content idiom; a plain DELETE FROM the FTS table corrupts it.
      CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, content, tags)
        VALUES (new.id, new.content, new.tags);
      END;

      CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content, tags)
        VALUES ('delete', old.id, old.content, old.tags);
      END;

      CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content, tags)
        VALUES ('delete', old.id, old.content, old.tags);
        INSERT INTO memories_fts(rowid, content, tags)
        VALUES (new.id, new.content, new.tags);
      END;

      -- Single compiled wiki + room for future metadata.
      CREATE TABLE IF NOT EXISTS memory_meta (
        key       TEXT PRIMARY KEY,
        value     TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
    `);
  }

  private mapRow(row: MemoryRow): Memory {
    return {
      id: formatId(PREFIX, row.id),
      content: row.content,
      kind: row.kind,
      tags: tagsToArray(row.tags),
      source: row.source,
      salience: row.salience,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  // --- Raw notes --------------------------------------------------------------

  remember(input: {
    content: string;
    kind?: MemoryKind;
    tags?: string[];
    source?: string;
    salience?: number;
  }): Memory {
    const ts = nowIso();
    const info = this.db
      .prepare(
        `INSERT INTO memories (content, kind, tags, source, salience, createdAt, updatedAt)
         VALUES (@content, @kind, @tags, @source, @salience, @createdAt, @updatedAt)`,
      )
      .run({
        content: input.content,
        kind: input.kind ?? "lesson",
        tags: tagsToString(input.tags),
        source: input.source ?? null,
        salience: clampSalience(input.salience),
        createdAt: ts,
        updatedAt: ts,
      });
    return this.get(formatId(PREFIX, info.lastInsertRowid))!;
  }

  get(id: string): Memory | undefined {
    const numeric = parseId(PREFIX, id);
    if (numeric === undefined) return undefined;
    const row = this.db
      .prepare(`SELECT * FROM memories WHERE id = ?`)
      .get(numeric) as MemoryRow | undefined;
    return row ? this.mapRow(row) : undefined;
  }

  list(filter: { kind?: MemoryKind; limit?: number } = {}): Memory[] {
    const where = filter.kind ? `WHERE kind = @kind` : "";
    const rows = this.db
      .prepare(
        `SELECT * FROM memories ${where} ORDER BY id DESC LIMIT @limit`,
      )
      .all({ kind: filter.kind ?? null, limit: filter.limit ?? 100 }) as MemoryRow[];
    return rows.map((r) => this.mapRow(r));
  }

  update(
    id: string,
    values: Partial<{
      content: string;
      kind: MemoryKind;
      tags: string[];
      source: string;
      salience: number;
    }>,
  ): Memory | undefined {
    const numeric = parseId(PREFIX, id);
    if (numeric === undefined) return undefined;
    if (!this.get(id)) return undefined;

    const sets: string[] = [];
    const params: Record<string, unknown> = { id: numeric };
    if (values.content !== undefined) {
      sets.push(`content = @content`);
      params.content = values.content;
    }
    if (values.kind !== undefined) {
      sets.push(`kind = @kind`);
      params.kind = values.kind;
    }
    if (values.tags !== undefined) {
      sets.push(`tags = @tags`);
      params.tags = tagsToString(values.tags);
    }
    if (values.source !== undefined) {
      sets.push(`source = @source`);
      params.source = values.source;
    }
    if (values.salience !== undefined) {
      sets.push(`salience = @salience`);
      params.salience = clampSalience(values.salience);
    }
    sets.push(`updatedAt = @updatedAt`);
    params.updatedAt = nowIso();

    this.db.prepare(`UPDATE memories SET ${sets.join(", ")} WHERE id = @id`).run(params);
    return this.get(id);
  }

  delete(id: string): boolean {
    const numeric = parseId(PREFIX, id);
    if (numeric === undefined) return false;
    const info = this.db.prepare(`DELETE FROM memories WHERE id = ?`).run(numeric);
    return info.changes > 0;
  }

  // --- Recall (FTS5 keyword search) ------------------------------------------

  recall(
    query: string,
    opts: { kind?: MemoryKind; tags?: string[]; limit?: number } = {},
  ): RecalledMemory[] {
    const matchQuery = ftsQuery(query);
    const tagFilters = (opts.tags ?? [])
      .map((t) => t.trim())
      .filter((t) => t.length > 0);

    // Build a delimited-LIKE clause per requested tag (exact, composes with MATCH).
    const tagClauses = tagFilters.map((_, i) => `(',' || m.tags || ',') LIKE @tag${i}`);
    const params: Record<string, unknown> = {
      q: matchQuery,
      kind: opts.kind ?? null,
      limit: opts.limit ?? 10,
    };
    tagFilters.forEach((t, i) => {
      params[`tag${i}`] = `%,${t},%`;
    });

    const where = [
      `memories_fts MATCH @q`,
      `(@kind IS NULL OR m.kind = @kind)`,
      ...tagClauses,
    ].join(" AND ");

    const rows = this.db
      .prepare(
        `SELECT m.*, bm25(memories_fts, 10.0, 5.0) AS rank
           FROM memories_fts
           JOIN memories AS m ON m.id = memories_fts.rowid
          WHERE ${where}
          ORDER BY rank
          LIMIT @limit`,
      )
      .all(params) as (MemoryRow & { rank: number })[];

    return rows.map((r) => ({ ...this.mapRow(r), rank: r.rank }));
  }

  // --- Compiled wiki ----------------------------------------------------------

  getWiki(): { content: string; updatedAt: string } | null {
    const row = this.db
      .prepare(`SELECT value, updatedAt FROM memory_meta WHERE key = 'wiki'`)
      .get() as { value: string; updatedAt: string } | undefined;
    return row ? { content: row.value, updatedAt: row.updatedAt } : null;
  }

  saveWiki(markdown: string): { content: string; updatedAt: string } {
    const ts = nowIso();
    this.db
      .prepare(
        `INSERT INTO memory_meta (key, value, updatedAt)
         VALUES ('wiki', @value, @updatedAt)
         ON CONFLICT(key) DO UPDATE SET value = @value, updatedAt = @updatedAt`,
      )
      .run({ value: markdown, updatedAt: ts });
    return { content: markdown, updatedAt: ts };
  }

  // --- Consolidation support --------------------------------------------------

  /**
   * Find likely near-duplicate note pairs — dependency free. FTS is used as a
   * cheap candidate pre-filter (only notes sharing vocabulary are compared),
   * then each pair is scored by Jaccard token overlap and kept if it clears
   * {@link DUP_THRESHOLD}. The model makes the final call during
   * consolidation, so false positives are harmless.
   */
  duplicateCandidates(limit = 20): DuplicateCandidate[] {
    const notes = this.db
      .prepare(`SELECT id, content FROM memories`)
      .all() as { id: number; content: string }[];

    const tokenSets = new Map<number, Set<string>>();
    for (const note of notes) tokenSets.set(note.id, contentTokens(note.content));

    const match = this.db.prepare(
      `SELECT memories_fts.rowid AS rid
         FROM memories_fts
        WHERE memories_fts MATCH @q AND memories_fts.rowid <> @self
        LIMIT 10`,
    );

    const seen = new Set<string>();
    const out: DuplicateCandidate[] = [];
    for (const note of notes) {
      const neighbors = match.all({ q: ftsQuery(note.content), self: note.id }) as {
        rid: number;
      }[];
      for (const n of neighbors) {
        const pair = [note.id, n.rid].sort((x, y) => x - y);
        const key = pair.join("-");
        if (seen.has(key)) continue;
        seen.add(key);
        const score = jaccard(tokenSets.get(pair[0])!, tokenSets.get(pair[1])!);
        if (score < DUP_THRESHOLD) continue;
        out.push({ a: formatId(PREFIX, pair[0]), b: formatId(PREFIX, pair[1]), score });
      }
    }
    return out.sort((x, y) => y.score - x.score).slice(0, limit);
  }

  close(): void {
    this.db.close();
  }
}
