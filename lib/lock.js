import { createHash } from 'node:crypto'
import {
  existsSync as realExistsSync,
  readFileSync as realReadFileSync,
  unlinkSync as realUnlinkSync,
  writeFileSync as realWriteFileSync,
} from 'node:fs'

const DEFAULT_STALE_AFTER_MS = 6 * 60 * 60 * 1000
const DEFAULT_TMP_DIR = '/tmp'

export function lockPathFor(repoPath, tmpDir = DEFAULT_TMP_DIR) {
  const slug = createHash('sha256').update(repoPath).digest('hex').slice(0, 8)
  return `${tmpDir}/ralph-cycle-${slug}.lock`
}

export function acquireLock(repoPath, options = {}) {
  const {
    pid = process.pid,
    startedAt = new Date(),
    staleAfterMs = DEFAULT_STALE_AFTER_MS,
    fsImpl,
    processKill = defaultProcessKill,
    now = Date.now,
    tmpDir = DEFAULT_TMP_DIR,
  } = options
  const fs = wrapFs(fsImpl)
  const path = lockPathFor(repoPath, tmpDir)
  const existing = readHolder(fs, path)
  if (existing && !isStale(existing, { processKill, now, staleAfterMs })) {
    return { acquired: false, holder: existing }
  }
  const holder = {
    pid,
    startedAt: startedAt instanceof Date ? startedAt.toISOString() : startedAt,
    repoPath,
  }
  fs.writeFileSync(path, JSON.stringify(holder))
  return { acquired: true, holder }
}

export function releaseLock(repoPath, options = {}) {
  const { fsImpl, tmpDir = DEFAULT_TMP_DIR } = options
  const fs = wrapFs(fsImpl)
  const path = lockPathFor(repoPath, tmpDir)
  if (fs.existsSync(path)) {
    fs.unlinkSync(path)
  }
}

export function peekLock(repoPath, options = {}) {
  const {
    fsImpl,
    processKill = defaultProcessKill,
    tmpDir = DEFAULT_TMP_DIR,
  } = options
  const fs = wrapFs(fsImpl)
  const path = lockPathFor(repoPath, tmpDir)
  const holder = readHolder(fs, path)
  if (!holder) return null
  return { holder, alive: isPidAlive(holder.pid, processKill) }
}

function readHolder(fs, path) {
  if (!fs.existsSync(path)) return null
  let raw
  try {
    raw = fs.readFileSync(path, 'utf8').toString()
  } catch {
    return null
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed.pid !== 'number') return null
  return parsed
}

function isStale(holder, { processKill, now, staleAfterMs }) {
  if (!isPidAlive(holder.pid, processKill)) return true
  const startedMs = Date.parse(holder.startedAt)
  if (Number.isNaN(startedMs)) return true
  return now() - startedMs > staleAfterMs
}

function isPidAlive(pid, processKill) {
  try {
    processKill(pid, 0)
    return true
  } catch (err) {
    // EPERM means the process exists but we can't signal it (still alive).
    // ESRCH (and any other error) means treat as dead.
    return err && err.code === 'EPERM'
  }
}

function defaultProcessKill(pid, signal) {
  return process.kill(pid, signal)
}

function wrapFs(fsImpl) {
  if (!fsImpl) {
    return {
      existsSync: realExistsSync,
      readFileSync: realReadFileSync,
      writeFileSync: realWriteFileSync,
      unlinkSync: realUnlinkSync,
    }
  }
  return {
    existsSync: fsImpl.existsSync.bind(fsImpl),
    readFileSync: fsImpl.readFileSync.bind(fsImpl),
    writeFileSync: fsImpl.writeFileSync.bind(fsImpl),
    unlinkSync: fsImpl.unlinkSync.bind(fsImpl),
  }
}
