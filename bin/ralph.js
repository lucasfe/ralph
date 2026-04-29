#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { Command } from 'commander'
import { startCommand, StartAbort } from '../lib/commands/start.js'
import { stopCommand, StopAbort } from '../lib/commands/stop.js'
import { initCommand, InitAbort } from '../lib/commands/init.js'
import { doctorCommand, DoctorAbort } from '../lib/commands/doctor.js'

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
