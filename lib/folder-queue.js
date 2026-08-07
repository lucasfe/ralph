// Folder-mode task queue (#565). When TASK_SOURCE=folder, Ralph draws tasks from
// a local `.ralph/tasks/` tree instead of GitHub. The afk lane has four status
// directories (todo, in-progress, done, failed); the hitl lane is human-only
// (todo). This module is the single source of truth for the folder queue's
// mechanics and doubles as a node CLI the bash loop shells out to (mirroring
// capture-issue-event.js / agent-invocation.js), so bash holds no task-move
// knowledge of its own.
//
// Library API (injectable fs for hermetic tests):
//   queueCount(tasksRoot, {fs})       — number of .md files in afk/todo
//   queuePick(tasksRoot, {fs})        — lowest-numbered afk/todo task, or null
//   locateTask(tasksRoot, id, {fs})   — which afk status dir holds a task, or null
//   startTask/completeTask/failTask   — status moves; true on success
//
// CLI (for templates/ralph.sh):
//   node folder-queue.js count <tasksRoot>       → prints the todo count
//   node folder-queue.js pick  <tasksRoot>       → prints "<id>\t<path>" or nothing
//   node folder-queue.js locate <tasksRoot> <id> → prints the afk status dir
//                                                   holding the task, or nothing
//   node folder-queue.js fail  <tasksRoot> <id>  → sweep a stuck/never-started task
//   node folder-queue.js complete <tasksRoot> <id>
//   node folder-queue.js start <tasksRoot> <id>

import {
  existsSync as realExistsSync,
  readdirSync as realReaddirSync,
  mkdirSync as realMkdirSync,
  renameSync as realRenameSync,
} from 'node:fs'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { taskIdFromFilename } from './task-file.js'

const AFK_STATUSES = ['todo', 'in-progress', 'done', 'failed']

function fsFrom(fsImpl) {
  if (!fsImpl) {
    return {
      existsSync: realExistsSync,
      readdirSync: realReaddirSync,
      mkdirSync: realMkdirSync,
      renameSync: realRenameSync,
    }
  }
  return {
    existsSync: fsImpl.existsSync.bind(fsImpl),
    readdirSync: fsImpl.readdirSync.bind(fsImpl),
    mkdirSync: fsImpl.mkdirSync.bind(fsImpl),
    renameSync: fsImpl.renameSync.bind(fsImpl),
  }
}

// List the .md files in a directory, degrading to [] when it doesn't exist.
function listMd(fs, dir) {
  if (!fs.existsSync(dir)) return []
  let entries = []
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return []
  }
  return entries
    .map((e) => (typeof e === 'string' ? e : e?.name))
    .filter((name) => typeof name === 'string' && name.endsWith('.md'))
}

function todoDir(tasksRoot) {
  return `${tasksRoot}/afk/todo`
}
function statusDir(tasksRoot, status) {
  return `${tasksRoot}/afk/${status}`
}

export function queueCount(tasksRoot, { fs: fsImpl } = {}) {
  const fs = fsFrom(fsImpl)
  return listMd(fs, todoDir(tasksRoot)).length
}

// Lowest-numbered task in afk/todo. Returns { id, file, path } or null.
export function queuePick(tasksRoot, { fs: fsImpl } = {}) {
  const fs = fsFrom(fsImpl)
  const files = listMd(fs, todoDir(tasksRoot))
    .map((file) => ({ file, id: taskIdFromFilename(file) }))
    .filter((x) => x.id != null)
    .sort((a, b) => a.id - b.id)
  if (files.length === 0) return null
  const { file, id } = files[0]
  return { id, file, path: `${todoDir(tasksRoot)}/${file}` }
}

// Which afk status directory currently holds the task with this id, or null.
export function locateTask(tasksRoot, id, { fs: fsImpl } = {}) {
  const fs = fsFrom(fsImpl)
  const target = Number(id)
  for (const status of AFK_STATUSES) {
    const files = listMd(fs, statusDir(tasksRoot, status))
    if (files.some((file) => taskIdFromFilename(file) === target)) return status
  }
  return null
}

// Move the file for `id` from `fromStatus` to `toStatus`. Defensively mkdir -p
// the destination. Returns true when a matching file was moved, false otherwise.
function move(fs, tasksRoot, id, fromStatus, toStatus) {
  const target = Number(id)
  const from = statusDir(tasksRoot, fromStatus)
  const files = listMd(fs, from)
  const file = files.find((f) => taskIdFromFilename(f) === target)
  if (!file) return false
  const to = statusDir(tasksRoot, toStatus)
  try {
    fs.mkdirSync(to, { recursive: true })
  } catch {
    // already exists
  }
  fs.renameSync(`${from}/${file}`, `${to}/${file}`)
  return true
}

export function startTask(tasksRoot, id, { fs: fsImpl } = {}) {
  return move(fsFrom(fsImpl), tasksRoot, id, 'todo', 'in-progress')
}

export function completeTask(tasksRoot, id, { fs: fsImpl } = {}) {
  return move(fsFrom(fsImpl), tasksRoot, id, 'in-progress', 'done')
}

// Failure/no-op sweep: send a task to failed from wherever it currently sits
// (a stuck in-progress task, or a never-started todo task). Returns true when
// something was moved.
export function failTask(tasksRoot, id, { fs: fsImpl } = {}) {
  const fs = fsFrom(fsImpl)
  const status = locateTask(tasksRoot, id, { fs: fsImpl })
  if (status == null || status === 'failed') return false
  return move(fs, tasksRoot, id, status, 'failed')
}

// --- CLI entrypoint (for templates/ralph.sh) --------------------------------
function runCli(argv) {
  const [cmd, tasksRoot, idArg] = argv
  if (!cmd || !tasksRoot) {
    process.stderr.write('usage: folder-queue.js <count|pick|locate|start|complete|fail> <tasksRoot> [id]\n')
    return 2
  }
  switch (cmd) {
    case 'count':
      process.stdout.write(String(queueCount(tasksRoot)) + '\n')
      return 0
    case 'pick': {
      const pick = queuePick(tasksRoot)
      if (pick) process.stdout.write(`${pick.id}\t${pick.path}\n`)
      return 0
    }
    case 'locate': {
      const status = locateTask(tasksRoot, idArg)
      if (status) process.stdout.write(status + '\n')
      return 0
    }
    case 'start':
      return startTask(tasksRoot, idArg) ? 0 : 1
    case 'complete':
      return completeTask(tasksRoot, idArg) ? 0 : 1
    case 'fail':
      return failTask(tasksRoot, idArg) ? 0 : 1
    default:
      process.stderr.write(`folder-queue.js: unknown command '${cmd}'\n`)
      return 2
  }
}

const invokedAsScript =
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (invokedAsScript) {
  process.exit(runCli(process.argv.slice(2)))
}
