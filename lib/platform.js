import { readFileSync } from 'node:fs'

export function detectPlatform({
  platform = process.platform,
  readProcVersion = defaultReadProcVersion,
} = {}) {
  if (platform === 'darwin') return 'mac'
  if (platform === 'linux') {
    const version = readProcVersion()
    if (version && /microsoft/i.test(version)) return 'wsl'
    return 'linux'
  }
  return 'linux'
}

function defaultReadProcVersion() {
  try {
    return readFileSync('/proc/version', 'utf8')
  } catch {
    return ''
  }
}
