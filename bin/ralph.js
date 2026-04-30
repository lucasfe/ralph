#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { Command } from 'commander'
import { startCommand, StartAbort } from '../lib/commands/start.js'
import { stopCommand, StopAbort } from '../lib/commands/stop.js'
import { initCommand, InitAbort } from '../lib/commands/init.js'
import { doctorCommand, DoctorAbort } from '../lib/commands/doctor.js'
import { cycleCommand, CycleAbort } from '../lib/commands/cycle.js'
import {
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
  .action(async (opts) => {
    try {
      await initCommand({ resetPrompt: Boolean(opts.resetPrompt) })
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
  .command('cycle')
  .description(
    'Run one queue-processing cycle: preflight, lock, drain, notify. Designed for launchd / cron schedules.',
  )
  .action(async () => {
    try {
      const result = await cycleCommand()
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
  .description('Install a launchd agent that fires `ralph cycle` every --interval')
  .option('--interval <duration>', 'Interval between cycles (e.g. 4h, 30m, 1d)', '4h')
  .option('--force', 'Overwrite an existing plist for this repo')
  .action(async (opts) => {
    try {
      const result = await scheduleInstallCommand({
        interval: opts.interval,
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

program
  .command('doctor')
  .description('Check required system deps and print install commands for missing ones')
  .action(async () => {
    try {
      const result = await doctorCommand()
      process.exit(result.exitCode)
    } catch (e) {
      if (e instanceof DoctorAbort) {
        process.exit(e.exitCode ?? 1)
      }
      throw e
    }
  })

program.parse(process.argv)
