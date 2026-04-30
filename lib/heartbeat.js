import { readFileSync as realReadFileSync, readdirSync as realReaddirSync } from 'node:fs'
import { join } from 'node:path'

export const RALPH_CYCLE_EVENT_TAG = 'RALPH_CYCLE_EVENT'
const ABORTED_STATUSES = new Set(['preflight-failed', 'lock-held', 'tmux-active'])
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000
const LOG_BASENAME = 'ralph-cycle.out.log'

export function summarizeLast24h({
  logDir,
  fs,
  clock = Date.now,
} = {}) {
  const empty = {
    cycles: 0,
    totalIssues: 0,
    ok: 0,
    failed: 0,
    abortedCycles: 0,
    durations: [],
    lastCycle: null,
  }
  if (!logDir) return empty

  const reader = wrapFs(fs)
  const cutoff = clock() - TWENTY_FOUR_HOURS_MS
  const files = listLogFiles(reader, logDir)
  const events = []

  for (const file of files) {
    const text = safeRead(reader, file)
    if (!text) continue
    for (const line of text.split(/\r?\n/)) {
      const event = parseEventLine(line)
      if (!event) continue
      const tsMs = Date.parse(event.ts)
      if (!Number.isFinite(tsMs)) continue
      if (tsMs < cutoff) continue
      events.push({ ...event, tsMs })
    }
  }

  if (events.length === 0) return empty
  events.sort((a, b) => a.tsMs - b.tsMs)

  let ok = 0
  let failed = 0
  let abortedCycles = 0
  const durations = []
  for (const event of events) {
    ok += toInt(event.ok)
    failed += toInt(event.failed)
    if (ABORTED_STATUSES.has(event.status)) {
      abortedCycles += 1
      continue
    }
    if (Number.isFinite(event.durationMin)) {
      durations.push(event.durationMin)
    }
  }

  const last = events[events.length - 1]
  const { tsMs: _ignore, ...lastCycle } = last
  return {
    cycles: events.length,
    totalIssues: ok + failed,
    ok,
    failed,
    abortedCycles,
    durations,
    lastCycle,
  }
}

export function formatSummary(summary, { repoSlug, nextTick } = {}) {
  const cycles = toInt(summary?.cycles)
  const totalIssues = toInt(summary?.totalIssues)
  const ok = toInt(summary?.ok)
  const failed = toInt(summary?.failed)
  const slug = repoSlug || 'unknown-repo'
  const tail = nextTick ? ` | next ${nextTick}` : ''

  if (cycles === 0) {
    return `📊 Ralph 24h | 0 cycles, repo ${slug}${tail}`
  }
  const warn = ok === 0 && failed > 0 ? ' ⚠️' : ''
  return `📊 Ralph 24h | ${cycles} cycles, ${totalIssues} issues (${ok} ok, ${failed} fail)${warn} | ${slug}${tail}`
}

function listLogFiles(fs, logDir) {
  let entries = []
  try {
    entries = fs.readdirSync(logDir) || []
  } catch {
    return []
  }
  const candidates = entries.filter(
    (name) => typeof name === 'string' && name.startsWith(LOG_BASENAME),
  )
  candidates.sort()
  return candidates.map((name) => join(logDir, name))
}

function safeRead(fs, path) {
  try {
    const data = fs.readFileSync(path, 'utf8')
    return typeof data === 'string' ? data : data?.toString?.() ?? ''
  } catch {
    return ''
  }
}

function parseEventLine(line) {
  if (!line) return null
  const idx = line.indexOf(RALPH_CYCLE_EVENT_TAG)
  if (idx === -1) return null
  const jsonPart = line.slice(idx + RALPH_CYCLE_EVENT_TAG.length).trim()
  if (!jsonPart) return null
  try {
    const obj = JSON.parse(jsonPart)
    if (!obj || typeof obj !== 'object') return null
    return obj
  } catch {
    return null
  }
}

function toInt(value) {
  const n = Number(value)
  return Number.isFinite(n) ? Math.trunc(n) : 0
}

function wrapFs(fsImpl) {
  if (!fsImpl) {
    return {
      readFileSync: realReadFileSync,
      readdirSync: realReaddirSync,
    }
  }
  return {
    readFileSync: fsImpl.readFileSync
      ? fsImpl.readFileSync.bind(fsImpl)
      : realReadFileSync,
    readdirSync: fsImpl.readdirSync
      ? fsImpl.readdirSync.bind(fsImpl)
      : realReaddirSync,
  }
}
