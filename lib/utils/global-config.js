import { homedir } from 'node:os'
import { join } from 'node:path'
import { loadEnvFile } from './env.js'

// #3: single source of truth for the global Ralph config path. Honors
// $XDG_CONFIG_HOME (trimmed), falling back to ~/.config, and always points at
// the generic dotenv file ralph/.env under that base.
export function globalConfigPath({ processEnv = process.env, home = homedir() } = {}) {
  const xdg = processEnv.XDG_CONFIG_HOME && processEnv.XDG_CONFIG_HOME.trim()
  const base = xdg ? xdg : join(home, '.config')
  return join(base, 'ralph', '.env')
}

// #3: single source of truth for the credential precedence chain. Resolves a
// key through repo .env.local → process.env → global config file. The global
// file is optional: loadEnvFile returns {} on ENOENT, so absence is a silent
// no-op. Inject loadEnv/processEnv/home in tests to avoid touching the FS.
export function createCredentialResolver({
  repoEnv = {},
  processEnv = process.env,
  home = homedir(),
  loadEnv = loadEnvFile,
} = {}) {
  const globalEnv = loadEnv(globalConfigPath({ processEnv, home })) || {}
  return (key) => repoEnv[key] ?? processEnv[key] ?? globalEnv[key]
}
