// PURE task-source registry — NO I/O (#565). The single place that normalizes
// the TASK_SOURCE env var into a resolved source name. Mirrors resolveAgent in
// agent-registry.js: an unset/empty/whitespace value => github (the default,
// zero-regression path); a recognized value (case-insensitive, trimmed) => that
// source; anything else falls back to github so a typo never aborts a run.

export const VALID_SOURCES = ['github', 'folder']
export const DEFAULT_SOURCE = 'github'

export function resolveSource(env = {}) {
  const raw = env?.TASK_SOURCE
  if (raw == null || String(raw).trim() === '') return DEFAULT_SOURCE
  const normalized = String(raw).trim().toLowerCase()
  return VALID_SOURCES.includes(normalized) ? normalized : DEFAULT_SOURCE
}
