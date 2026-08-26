#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { Command } from 'commander'
import { startCommand, StartAbort } from '../lib/commands/start.js'
import { stopCommand, StopAbort } from '../lib/commands/stop.js'
import { statusCommand, StatusAbort } from '../lib/commands/status.js'
import { initCommand, InitAbort } from '../lib/commands/init.js'
import { doctorCommand, DoctorAbort } from '../lib/commands/doctor.js'
import { cycleCommand, CycleAbort } from '../lib/commands/cycle.js'
import { updateCommand, UpdateAbort } from '../lib/commands/update.js'
import {
  scheduleHeartbeatCommand,
  scheduleInstallCommand,
  schedulePauseCommand,
  scheduleResumeCommand,
  scheduleRemoveCommand,
  scheduleStatusCommand,
  ScheduleAbort,
} from '../lib/commands/schedule.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(readFileSync(resolve(__dirname, '..', 'package.json'), 'utf8'))

const program = new Command()

program
  .name('ralph')
  .description('Autonomous GitHub issue resolution loop')
  .version(pkg.version, '-v, --version', 'output the current version')

program
  .command('init')
  .description('Initialize Ralph in the current project (config + templates + slash command)')
  .option('--reset-prompt', 'Overwrite an existing PROMPT.md with the package template')
  .option('--agent <name>', 'Coding agent to configure: claude (default) or codex')
  .option('--source <github|folder>', 'Task source: github (default) or folder')
  .action(async (opts) => {
    try {
      await initCommand({
        resetPrompt: Boolean(opts.resetPrompt),
        agent: opts.agent ?? null,
        source: opts.source ?? null,
      })
    } catch (e) {
      if (e instanceof InitAbort) {
        process.exit(e.exitCode ?? 1)
      }
      throw e
    }
  })

program
  .command('start')
  .description('Run sanity checks and launch the Ralph loop in a detached tmux session')
  .action(async () => {
    try {
      await startCommand({ currentVersion: pkg.version })
    } catch (e) {
      if (e instanceof StartAbort) {
        process.exit(e.exitCode ?? 1)
      }
      throw e
    }
  })

program
  .command('stop')
  .description('Kill the detached Ralph tmux session')
  .action(async () => {
    try {
      await stopCommand()
    } catch (e) {
      if (e instanceof StopAbort) {
        process.exit(e.exitCode ?? 1)
      }
      throw e
    }
  })

program
  .command('status')
  // The parenthetical is the live view's own line-up (#64): the three counted facts
  // #55 shipped, then the three #57 derives from them. Spelled out rather than left
  // at "what it is working on" because `--help` is the whole description a reader
  // gets before running the command — and a summary naming fewer lines than the view
  // prints undersells it, which is what this one did between #57 and #64.
  .description(
    'Show what the Ralph loop is working on right now (run, task in flight, queue, pace, ETA, spend)',
  )
  // #58: the same snapshot the human view prints, as one JSON document on stdout —
  // so a shell prompt, a status line or a custom notifier can be driven off `ralph
  // status --json | jq` instead of re-parsing issues.jsonl by hand.
  .option('--json', 'Print the snapshot as a single JSON document instead of the human view')
  .action(async (opts) => {
    try {
      const result = await statusCommand({ json: Boolean(opts.json) })
      process.exit(result.exitCode ?? 0)
    } catch (e) {
      if (e instanceof StatusAbort) {
        process.exit(e.exitCode ?? 1)
      }
      throw e
    }
  })

program
  .command('cycle')
  // #53: the update check earns its place in the one-liner — since #51/#52 it is
  // part of the sequence, not a `ralph start` extra, and it is listed where it
  // actually runs: inside the lock, before the drain. Named here because `--help`
  // is where a scheduler owner learns what a tick does.
  .description(
    'Run one queue-processing cycle: preflight, lock, update check, drain, notify. Designed for launchd / cron schedules.',
  )
  .action(async () => {
    try {
      // #51: currentVersion feeds the update notice the cycle prints inside its
      // lock. Same pkg.version start, update and doctor get — one source of truth
      // for "what is installed", and the reason a launchd-driven cycle can tell it
      // is stale at all.
      const result = await cycleCommand({ currentVersion: pkg.version })
      process.exit(result.exitCode ?? 0)
    } catch (e) {
      if (e instanceof CycleAbort) {
        process.exit(e.exitCode ?? 1)
      }
      throw e
    }
  })

const schedule = program
  .command('schedule')
  .description('Manage the macOS launchd agent that runs `ralph cycle` on a timer')

schedule
  .command('install')
  .description(
    'Install both launchd agents: cycle (every --interval) + heartbeat (daily summary at RALPH_DAILY_SUMMARY_TIME or 09:00)',
  )
  .option('--interval <duration>', 'Interval between cycles (e.g. 4h, 30m, 1d)', '4h')
  .option(
    '--heartbeat-time <hh:mm>',
    'Time for the daily heartbeat summary (defaults to RALPH_DAILY_SUMMARY_TIME or 09:00)',
  )
  .option('--force', 'Overwrite existing plists for this repo')
  .action(async (opts) => {
    try {
      const result = await scheduleInstallCommand({
        interval: opts.interval,
        heartbeatTime: opts.heartbeatTime,
        force: Boolean(opts.force),
      })
      process.exit(result.exitCode ?? 0)
    } catch (e) {
      if (e instanceof ScheduleAbort) {
        process.exit(e.exitCode ?? 1)
      }
      throw e
    }
  })

schedule
  .command('remove')
  .description('Unload and delete the launchd agent for the current repo (or every repo with --all)')
  .option('--all', 'Remove every Ralph launchd agent on this user account (with confirmation)')
  .action(async (opts) => {
    try {
      const result = await scheduleRemoveCommand({ all: Boolean(opts.all) })
      process.exit(result.exitCode ?? 0)
    } catch (e) {
      if (e instanceof ScheduleAbort) {
        process.exit(e.exitCode ?? 1)
      }
      throw e
    }
  })

schedule
  .command('pause')
  .description('Unload the launchd agent for the current repo (keeps the plist on disk so resume works)')
  .action(async () => {
    try {
      const result = await schedulePauseCommand()
      process.exit(result.exitCode ?? 0)
    } catch (e) {
      if (e instanceof ScheduleAbort) {
        process.exit(e.exitCode ?? 1)
      }
      throw e
    }
  })

schedule
  .command('resume')
  .description('Re-load a previously paused launchd agent for the current repo')
  .action(async () => {
    try {
      const result = await scheduleResumeCommand()
      process.exit(result.exitCode ?? 0)
    } catch (e) {
      if (e instanceof ScheduleAbort) {
        process.exit(e.exitCode ?? 1)
      }
      throw e
    }
  })

schedule
  .command('status')
  .description('Print the state of every Ralph launchd agent (use --here to filter to the current repo)')
  .option('--here', 'Only show the agent for the current repo')
  .action(async (opts) => {
    try {
      const result = await scheduleStatusCommand({ here: Boolean(opts.here) })
      process.exit(result.exitCode ?? 0)
    } catch (e) {
      if (e instanceof ScheduleAbort) {
        process.exit(e.exitCode ?? 1)
      }
      throw e
    }
  })

schedule
  .command('heartbeat')
  .description(
    'Internal: aggregate the last 24h of cycle logs and send the daily summary via WhatsApp',
  )
  .action(async () => {
    try {
      const result = await scheduleHeartbeatCommand()
      process.exit(result.exitCode ?? 0)
    } catch (e) {
      if (e instanceof ScheduleAbort) {
        process.exit(e.exitCode ?? 1)
      }
      throw e
    }
  })

program
  .command('update')
  .description('Update Ralph itself to the latest published version')
  .option('--force', 'Reinstall even when already on the latest version')
  .action(async (opts) => {
    try {
      const result = await updateCommand({
        force: Boolean(opts.force),
        currentVersion: pkg.version,
      })
      process.exit(result.exitCode ?? 0)
    } catch (e) {
      if (e instanceof UpdateAbort) {
        process.exit(e.exitCode ?? 1)
      }
      throw e
    }
  })

program
  .command('doctor')
  .description('Check required system deps and print install commands for missing ones')
  .action(async () => {
    try {
      // #27: currentVersion feeds doctor's cached installed-vs-latest line. Same
      // pkg.version the other commands get — one source of truth for "what is
      // running", and doctor still makes no network call to learn the other half.
      const result = await doctorCommand({ currentVersion: pkg.version })
      process.exit(result.exitCode)
    } catch (e) {
      if (e instanceof DoctorAbort) {
        process.exit(e.exitCode ?? 1)
      }
      throw e
    }
  })

program.parse(process.argv)
