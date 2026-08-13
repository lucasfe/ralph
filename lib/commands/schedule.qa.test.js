import { describe, it, expect } from 'vitest'
import {
  scheduleInstallCommand,
  scheduleRemoveCommand,
  schedulePauseCommand,
  scheduleResumeCommand,
  scheduleStatusCommand,
  scheduleHeartbeatCommand,
  ScheduleAbort,
} from './schedule.js'

// #6 QA augmentation — all six schedule subcommands guard on platform and, when
// #6 translated them, must emit the SAME English "only supports macOS" line
// with the detected platform interpolated. The dev did not add a parametrized
// test that every entry point stays consistent; a one-sided miss (one command
// left in Portuguese) would slip through otherwise.

function makeStream() {
  const chunks = []
  return {
    write: (s) => {
      chunks.push(s)
      return true
    },
    output: () => chunks.join(''),
  }
}

const COMMANDS = [
  ['scheduleInstallCommand', scheduleInstallCommand],
  ['scheduleRemoveCommand', scheduleRemoveCommand],
  ['schedulePauseCommand', schedulePauseCommand],
  ['scheduleResumeCommand', scheduleResumeCommand],
  ['scheduleStatusCommand', scheduleStatusCommand],
  ['scheduleHeartbeatCommand', scheduleHeartbeatCommand],
]

describe('QA schedule — every platform guard emits identical English on non-mac (#6)', () => {
  it.each(COMMANDS)('%s rejects linux with the English "only supports macOS" line + platform', async (_name, cmd) => {
    const stderr = makeStream()
    await expect(
      cmd({ stderr, stdout: makeStream(), platform: 'linux' }),
    ).rejects.toBeInstanceOf(ScheduleAbort)
    expect(stderr.output()).toContain('❌ ralph schedule only supports macOS (detected: linux).')
    // The detected platform is interpolated, not hard-coded.
    expect(stderr.output()).not.toMatch(/só suporta|detectado/)
  })

  it.each(COMMANDS)('%s interpolates the ACTUAL platform value (windows) into the message', async (_name, cmd) => {
    const stderr = makeStream()
    await expect(
      cmd({ stderr, stdout: makeStream(), platform: 'windows' }),
    ).rejects.toBeInstanceOf(ScheduleAbort)
    expect(stderr.output()).toContain('(detected: windows).')
  })
})
