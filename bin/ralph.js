#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { Command } from 'commander'
import { startCommand, StartAbort } from '../lib/commands/start.js'
import { stopCommand, StopAbort } from '../lib/commands/stop.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(readFileSync(resolve(__dirname, '..', 'package.json'), 'utf8'))

const program = new Command()

program
  .name('ralph')
  .description('Autonomous GitHub issue resolution loop')
  .version(pkg.version, '-v, --version', 'output the current version')

program
  .command('start')
  .description('Run sanity checks and launch the Ralph loop in a detached tmux session')
  .action(async () => {
    try {
      await startCommand()
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

program.parse(process.argv)
