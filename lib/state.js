import { createHash } from 'node:crypto'
import {
  existsSync as realExistsSync,
  mkdirSync as realMkdirSync,
  readFileSync as realReadFileSync,
  writeFileSync as realWriteFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

export function statePath(projectRoot) {
  return join(projectRoot, '.ralph', 'state.json')
}

export function readState(projectRoot, fsImpl) {
  const fs = wrapRead(fsImpl)
  const path = statePath(projectRoot)
  if (!fs.existsSync(path)) return null
  let raw
  try {
    raw = fs.readFileSync(path, 'utf8').toString()
  } catch {
    return null
  }
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

export function writeState(projectRoot, obj, fsImpl) {
  const fs = wrapWrite(fsImpl)
  const path = statePath(projectRoot)
  fs.mkdirSync(dirname(path), { recursive: true })
  fs.writeFileSync(path, JSON.stringify(obj, null, 2) + '\n')
}

export function hashConfig(configPath, fsImpl) {
  const fs = wrapRead(fsImpl)
  const content = fs.readFileSync(configPath)
  return createHash('sha256').update(content).digest('hex')
}

function wrapRead(fsImpl) {
  if (!fsImpl) {
    return { existsSync: realExistsSync, readFileSync: realReadFileSync }
  }
  return {
    existsSync: fsImpl.existsSync.bind(fsImpl),
    readFileSync: fsImpl.readFileSync.bind(fsImpl),
  }
}

function wrapWrite(fsImpl) {
  if (!fsImpl) {
    return { mkdirSync: realMkdirSync, writeFileSync: realWriteFileSync }
  }
  return {
    mkdirSync: fsImpl.mkdirSync.bind(fsImpl),
    writeFileSync: fsImpl.writeFileSync.bind(fsImpl),
  }
}
