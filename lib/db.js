/*!
 * dsh-memory-rules — storage engine adapter.
 *
 * Two engines, one interface:
 *
 *  1. `node:sqlite` (Node >= 22.5) — the preferred engine. Synchronous, no
 *     dependency, no WASM, real file locking. This is what the bundled DSH
 *     runtime provides (Node 24), so it is what normally runs.
 *  2. `sql.js` — the declared fallback for hosts whose Node is older than
 *     22.5. It is a peer dependency, never bundled: it is resolved from the
 *     host's own module paths when present, and the engine reports
 *     `available: false` with an actionable message when it is not.
 *
 * The interface deliberately exposes only `exec` / `all` / `get` / `run` /
 * `flush` / `close`, all taking `?` positional parameters, because that is the
 * intersection of the two engines. Nothing in this plugin depends on FTS5,
 * virtual tables, or SQLite extensions.
 */

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

/** Engine ids, as reported by {@link MemoryDb.engine}. */
export const ENGINE_NODE_SQLITE = 'node:sqlite'
export const ENGINE_SQL_JS = 'sql.js'

/** Instantiate `node:sqlite`'s `DatabaseSync`, or `undefined` when absent. */
function loadNodeSqlite() {
  try {
    // eslint-disable-next-line no-undef -- resolved by the host runtime
    const require = createRequire(import.meta.url)
    const mod = require('node:sqlite')
    if (mod && typeof mod.DatabaseSync === 'function') return mod
  } catch {
    /* engine absent: fall through to sql.js */
  }
  return undefined
}

/** Resolve the optional `sql.js` fallback from the host's module paths. */
function loadSqlJs() {
  const require = createRequire(import.meta.url)
  const attempts = ['sql.js', 'sql.js/dist/sql-wasm.js']
  for (const id of attempts) {
    try {
      const mod = require(id)
      const init = typeof mod === 'function' ? mod : mod && mod.default
      if (typeof init === 'function') return init
    } catch {
      /* try the next candidate */
    }
  }
  return undefined
}

/** Describe the engines this host can actually use, without opening a file. */
export function probeEngines() {
  const nodeSqlite = loadNodeSqlite()
  const sqlJs = nodeSqlite === undefined ? loadSqlJs() : undefined
  return {
    preferred: nodeSqlite !== undefined ? ENGINE_NODE_SQLITE : sqlJs !== undefined ? ENGINE_SQL_JS : null,
    nodeSqlite: nodeSqlite !== undefined,
    sqlJs: sqlJs !== undefined,
    nodeVersion: process.versions.node
  }
}

/**
 * Open one SQLite database at `file`, choosing the best available engine.
 *
 * @param file - absolute path of the database file.
 * @param options - `engine` forces an engine; `timeoutMs` bounds a busy wait.
 * @returns An open {@link MemoryDb}.
 * @throws Error when neither engine is usable (message names the remedy).
 */
export function openDatabase(file, options = {}) {
  const resolved = path.resolve(file)
  fs.mkdirSync(path.dirname(resolved), { recursive: true })
  const requested = options.engine
  const nodeSqlite = requested === ENGINE_SQL_JS ? undefined : loadNodeSqlite()
  if (nodeSqlite !== undefined) {
    const db = new nodeSqlite.DatabaseSync(resolved)
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA foreign_keys = ON')
    return new MemoryDb({ engine: ENGINE_NODE_SQLITE, file: resolved, handle: db, kind: 'node' })
  }
  const initSqlJs = requested === ENGINE_NODE_SQLITE ? undefined : loadSqlJs()
  if (initSqlJs !== undefined) {
    return new MemoryDb({
      engine: ENGINE_SQL_JS,
      file: resolved,
      handle: initSqlJs,
      kind: 'sqljs',
      pending: true
    })
  }
  throw new Error(
    'memory: no SQLite engine available. This Node (' +
      process.versions.node +
      ') has no `node:sqlite`; install the optional fallback with ' +
      '`npm install sql.js` inside the plugin directory (or set memoryDbEngine).'
  )
}

/**
 * Engine-neutral synchronous SQLite handle.
 *
 * For `sql.js` the handle is opened lazily on the first call, because that
 * engine's initialiser is asynchronous; {@link MemoryDb.ready} resolves once
 * the handle exists and is migrated, and every other method awaits it
 * internally. Callers that need a deterministic open should `await ready`.
 */
export class MemoryDb {
  constructor(init) {
    this.engine = init.engine
    this.file = init.file
    this.kind = init.kind
    this.handle = init.handle
    this.dirty = false
    this.closed = false
    this.writes = 0
    this._saveTimer = undefined
    this._ready =
      init.kind === 'sqljs'
        ? this._openSqlJs()
        : Promise.resolve(this)
  }

  /** Resolves when the database is open and usable. */
  get ready() {
    return this._ready
  }

  /** `sql.js` bootstrap: locate the wasm binary, open the file, apply pragmas. */
  async _openSqlJs() {
    const initSqlJs = this.handle
    const require = createRequire(import.meta.url)
    let wasmDir
    for (const id of ['sql.js/dist/sql-wasm.wasm', 'sql.js/dist/sql-wasm.js']) {
      try {
        wasmDir = path.dirname(require.resolve(id))
        break
      } catch {
        /* try the next candidate */
      }
    }
    const SQL = await initSqlJs(wasmDir === undefined ? undefined : { locateFile: (f) => path.join(wasmDir, f) })
    let bytes
    try {
      bytes = fs.readFileSync(this.file)
    } catch {
      bytes = undefined
    }
    this.handle = bytes === undefined || bytes.length === 0 ? new SQL.Database() : new SQL.Database(bytes)
    this.handle.run('PRAGMA foreign_keys = ON')
    return this
  }

  /** Await the (possibly asynchronous) open, then return this handle. */
  async open() {
    await this._ready
    return this
  }

  /** Execute one or more statements with no result set (DDL, PRAGMA). */
  async exec(sql) {
    await this._ready
    if (this.closed) throw new Error('memory: database is closed')
    if (this.kind === 'node') this.handle.exec(sql)
    else this.handle.run(sql)
    return this
  }

  /** Run a parameterised statement and return every row as a plain object. */
  async all(sql, params = []) {
    await this._ready
    if (this.closed) throw new Error('memory: database is closed')
    if (this.kind === 'node') return this.handle.prepare(sql).all(...params)
    const stmt = this.handle.prepare(sql)
    try {
      stmt.bind(params)
      const rows = []
      while (stmt.step()) rows.push(stmt.getAsObject())
      return rows
    } finally {
      stmt.free()
    }
  }

  /** Run a parameterised statement and return the first row, or `undefined`. */
  async get(sql, params = []) {
    const rows = await this.all(sql, params)
    return rows.length > 0 ? rows[0] : undefined
  }

  /** Run a parameterised statement; mark the store dirty when it wrote. */
  async run(sql, params = []) {
    await this._ready
    if (this.closed) throw new Error('memory: database is closed')
    this.writes += 1
    if (this.kind === 'node') return this.handle.prepare(sql).run(...params)
    this.handle.run(sql, params)
    this.dirty = true
    this._scheduleSave()
    return undefined
  }

  /** Wrap several writes in one transaction; the callback may be async. */
  async transaction(fn) {
    await this.exec('BEGIN')
    try {
      const result = await fn()
      await this.exec('COMMIT')
      return result
    } catch (error) {
      try {
        await this.exec('ROLLBACK')
      } catch {
        /* a failed rollback must not mask the original error */
      }
      throw error
    }
  }

  /** Persist to disk when the engine keeps the database in memory. */
  async flush() {
    if (this.closed) return false
    await this._ready
    if (this.kind !== 'sqljs') return false
    if (!this.dirty) return false
    const data = this.handle.export()
    const tmp = `${this.file}.tmp`
    fs.writeFileSync(tmp, Buffer.from(data))
    fs.renameSync(tmp, this.file)
    this.dirty = false
    return true
  }

  /** Coalesce frequent writes into one debounced save (sql.js only). */
  _scheduleSave() {
    if (this._saveTimer !== undefined) return
    this._saveTimer = setTimeout(() => {
      this._saveTimer = undefined
      void this.flush().catch(() => {})
    }, 500)
    this._saveTimer.unref?.()
  }

  /** Flush and close. Safe to call twice. */
  async close() {
    if (this.closed) return
    if (this._saveTimer !== undefined) {
      clearTimeout(this._saveTimer)
      this._saveTimer = undefined
    }
    await this.flush().catch(() => {})
    this.closed = true
    if (this.kind === 'node') {
      try {
        this.handle.close()
      } catch {
        /* already closed by the engine */
      }
    } else {
      this.handle.close()
    }
  }
}
