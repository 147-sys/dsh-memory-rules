/*!
 * dsh-memory-rules — shared test helpers (no host required).
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { openMemoryService } from '../lib/service.js'

/** An isolated temporary directory, unique per test. */
export function tempDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `dsh-mem-${name}-`))
}

/**
 * Open a service on a throwaway directory.
 * @param name - unique test name fragment.
 * @param options - extra options merged into the service options.
 * @returns `{ service, dir, dbFile, cleanup }`.
 */
export async function tempService(name, options = {}) {
  const dir = tempDir(name)
  const dbFile = path.join(dir, 'memory.db')
  const logger = { info() {}, warn() {}, debug() {}, error() {} }
  const service = await openMemoryService({
    memoryDir: dir,
    dbFile,
    logger,
    markdownMirror: options.markdownMirror === true,
    ...options
  })
  return {
    service,
    dir,
    dbFile,
    async cleanup() {
      await service.close()
      try {
        fs.rmSync(dir, { recursive: true, force: true })
      } catch {
        /* best effort */
      }
    }
  }
}

/** Turn a plain string into one user turn. */
export function userTurn(text) {
  return { role: 'user', text }
}

/** Turn a plain string into one assistant turn. */
export function assistantTurn(text) {
  return { role: 'assistant', text }
}
