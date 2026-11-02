/*!
 * dsh-memory-rules — package entry (`exports["."]`).
 *
 * This module is the host half loaded by the profile bundle declared in
 * `cordis.patch.yml`. It re-exports the plugin surface so the implementation
 * can live in focused modules while the manifest keeps a single entry point.
 */

export {
  apply,
  collectUserText,
  inject,
  isSelfInjected,
  lastSpokenUserIndex,
  name,
  placeInjection,
  selectSpokenMessages,
  toTurns,
  turnKeyFor
} from './plugin.js'
export { MEMORY_GUIDANCE, TAGS, buildRecallBlock, describePaths, renderEntry, renderMemoryElement } from './recall.js'
export { RULES } from './rules.js'
export {
  MemoryService,
  PROMPT_SEED_ID,
  PROMPT_SEED_KEY,
  PROMPT_SEED_TITLE,
  decodeAnswer,
  decodeBelief,
  decodeFact,
  openMemoryService
} from './service.js'
export { MemoryLibraryService, MAX_BODY_CHARS, PROMPT_METHODS } from './library.js'
export { resolveConfig, resolveDbFile, resolveMemoryDir, resolvePaths } from './config.js'
export { clusterByTopic, detectConflict, periodKeyFor, reflect, ReflectionScheduler, strengthFor } from './reflect.js'
export { embed, cosine, toSimilarity } from './embed.js'
export { findAnswer, mergeAndRank, parseTimeFilter, retrieve } from './retrieve.js'
export { ALL_TOOL_NAMES, TOOL_NAMES } from './util.js'
