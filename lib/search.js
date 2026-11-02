/*!
 * dsh-memory-rules — the Markdown day-file view.
 *
 * The legacy layer, kept because the day files are hand-editable: this is what
 * `memory_search` reads, and it is the only reader of `YYYY-MM-DD.md`. The
 * structured store lives in SQLite (`service.js`) and is read through
 * `retrieve.js`; nothing here touches the database.
 *
 * The index is lazy: it rebuilds when the directory signature changes (day-file
 * mtime/size), so records written by the mirror, by `memory_write`, or by hand
 * in an editor are all visible without restarting the harness.
 */

import fs from 'node:fs'
import path from 'node:path'

import { DAY_FILE_RE, ENTRY_HEADING_RE, squash, tokenize as tokenizeImpl } from './util.js'

/** Platform path separator, kept out of the record-building template. */
function pathSeparator() {
  return path.sep
}

/**
 * Parse one day file into records.
 *
 * Only the file's own framing is understood (`### HH:MM:SS — kind` headings);
 * anything between records is preserved on disk but is not part of a record.
 *
 * @param file - absolute day-file path.
 * @param day - day key for the file.
 * @returns Records in file order.
 */
export function parseDayFile(file, day) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return []
    throw error
  }
  const records = []
  let current
  for (const line of text.split(/\r?\n/)) {
    const heading = ENTRY_HEADING_RE.exec(line)
    if (heading) {
      if (current) records.push(current)
      current = { day, time: `${heading[1]}:${heading[2]}:${heading[3]}`, kind: heading[4], lines: [], file }
      continue
    }
    if (current) current.lines.push(line)
  }
  if (current) records.push(current)
  return records.map((record, index) => {
    const body = record.lines.join('\n').trim()
    // Tags are stored on their own trailing line(s); strip them from the body so
    // a rendered line does not show them twice.
    const tags = [...body.matchAll(/#[^\s#]+/g)].map((m) => m[0].slice(1))
    const bodyText = body.replace(/(?:\n|^)\s*#[^\s#]+(?:\s+#[^\s#]+)*\s*$/g, '').trim()
    return {
      day: record.day,
      time: record.time,
      kind: record.kind,
      index: index + 1,
      file: record.file,
      body: bodyText,
      title: squash((bodyText.split('\n')[0] ?? '').replace(/^[-*]\s*/, '')).slice(0, 120),
      tags
    }
  })
}

/** List day files in descending date order. */
export function listDayFiles(root) {
  let names
  try {
    names = fs.readdirSync(root)
  } catch (error) {
    if (error && error.code === 'ENOENT') return []
    throw error
  }
  return names
    .filter((name) => DAY_FILE_RE.test(name))
    .sort()
    .reverse()
    .map((name) => ({ name, day: name.slice(0, -3), path: path.join(root, name) }))
}

/** Read every record across every day file, newest day first. */
export function readAll(root) {
  const out = []
  for (const entry of listDayFiles(root)) out.push(...parseDayFile(entry.path, entry.day))
  return out
}

/**
 * Tokenise a query. Delegates to the shared tokenizer, so the Markdown search
 * and the structured keyword path agree on what a term is.
 * @param text - query text.
 * @returns Lowercased, de-duplicated terms.
 */
export function tokenize(text) {
  return tokenizeImpl(text)
}

/**
 * Score one record against pre-tokenised terms.
 * @param record - source record.
 * @param terms - query terms.
 * @returns Match score (higher is better) and the matched terms.
 */
export function scoreRecord(record, terms) {
  const haystackText = String(record.body ?? '').toLowerCase()
  const haystackTags = (record.tags ?? []).join(' ').toLowerCase()
  const haystackTitle = String(record.title ?? '').toLowerCase()
  let score = 0
  const matched = []
  for (const term of terms) {
    let hit = 0
    if (haystackTags.includes(term)) hit += 3
    if (haystackTitle.includes(term)) hit += 2
    const occurrences = haystackText.split(term).length - 1
    if (occurrences > 0) hit += Math.min(occurrences, 5)
    if (hit > 0) {
      score += hit
      matched.push(term)
    }
  }
  return { score, matched }
}

/**
 * Rank records for a free-text query, newest first among equal scores.
 * @param records - candidate records.
 * @param query - free-text query.
 * @param limit - maximum results (<= 0 means unlimited).
 * @param minScore - minimum score to be reported.
 * @returns Scored matches.
 */
export function search(records, query, limit, minScore) {
  const terms = tokenize(query)
  if (terms.length === 0) return []
  const floor = Number(minScore) > 0 ? Number(minScore) : 1
  const scored = []
  for (const record of records) {
    const { score, matched } = scoreRecord(record, terms)
    if (score >= floor) scored.push({ record, score, matched })
  }
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    if (a.record.day !== b.record.day) return a.record.day < b.record.day ? 1 : -1
    if (a.record.time !== b.record.time) return a.record.time < b.record.time ? 1 : -1
    return b.record.index - a.record.index
  })
  return Number(limit) > 0 ? scored.slice(0, Number(limit)) : scored
}

/** Lazy, signature-validated view over the memory directory. */
export class MemoryIndex {
  /**
   * @param root - absolute memory root.
   */
  constructor(root) {
    this.root = root
    this.records = []
    // `undefined` (not '') so the first read always builds, even when the
    // directory is empty and its signature is the empty string.
    this.signature = undefined
    this.refreshes = 0
  }

  /** Cheap change probe over the directory's day files. */
  currentSignature() {
    let names
    try {
      names = fs.readdirSync(this.root)
    } catch {
      return ''
    }
    const parts = []
    for (const name of names.filter((n) => DAY_FILE_RE.test(n)).sort()) {
      try {
        const stat = fs.statSync(`${this.root}/${name}`)
        parts.push(`${name}:${stat.mtimeMs}:${stat.size}`)
      } catch {
        parts.push(`${name}:gone`)
      }
    }
    return parts.join('|')
  }

  /** Rebuild when stale; returns the record list (newest day first). */
  ensureFresh() {
    const signature = this.currentSignature()
    if (signature !== this.signature) {
      this.records = readAll(this.root)
      this.signature = signature
      this.refreshes += 1
    }
    return this.records
  }

  /** All records, newest day first. */
  all() {
    return this.ensureFresh()
  }

  /**
   * Insert one freshly written record without waiting for a directory rescan.
   *
   * `ensureFresh()` compares day-file mtime+size, and a fully buffered
   * `writeFileSync` inside the same millisecond changes neither, so a reader
   * that re-stats immediately after a write can legitimately miss it. The
   * writer already knows what it wrote, so it hands the record over directly;
   * the next `ensureFresh()` still reconciles with disk if anything else moved.
   *
   * @param record - a parsed record (`{ day, time, kind, body, tags }`).
   * @returns This index, for chaining.
   */
  prepend(record) {
    this.ensureFresh()
    if (!record || typeof record.day !== 'string') return this
    const duplicate = this.records.some(
      (entry) => entry.day === record.day && entry.time === record.time && entry.body === record.body
    )
    if (duplicate) return this
    const index = this.records.filter((entry) => entry.day === record.day).length + 1
    this.records.unshift({
      file: `${this.root}${pathSeparator()}${record.day}.md`,
      title: String(record.body ?? '').split('\n')[0].slice(0, 120),
      ...record,
      index
    })
    // Keep the signature in step so the next probe does not rebuild the list
    // and drop the handed-over record.
    this.signature = this.currentSignature()
    return this
  }

  /** Records for one day. */
  byDay(day) {
    return this.ensureFresh().filter((record) => record.day === day)
  }

  /** Ranked search over all records. */
  search(query, limit, minScore) {
    return search(this.ensureFresh(), query, limit, minScore)
  }
}
