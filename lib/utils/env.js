import { readFileSync } from 'node:fs'

export function parseEnvFile(content) {
  const env = {}
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim().replace(/^export\s+/, '')
    let value = line.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    env[key] = value
  }
  return env
}

export function loadEnvFile(path) {
  try {
    const content = readFileSync(path, 'utf8')
    return parseEnvFile(content)
  } catch (err) {
    if (err.code === 'ENOENT') return {}
    throw err
  }
}
