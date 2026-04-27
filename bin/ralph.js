#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { Command } from 'commander'

const __dirname = dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(readFileSync(resolve(__dirname, '..', 'package.json'), 'utf8'))

const program = new Command()

program
  .name('ralph')
  .description('Autonomous GitHub issue resolution loop')
  .version(pkg.version, '-v, --version', 'output the current version')

program.parse(process.argv)
