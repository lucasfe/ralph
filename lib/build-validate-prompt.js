import { existsSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { join, resolve } from 'node:path'
import { interpolate } from './interpolate.js'
import { templatePath } from './paths.js'
import { hashConfig } from './state.js'

export function buildValidatePrompt({
  projectRoot = process.cwd(),
  ralphVersion = process.env.RALPH_VERSION ?? 'unknown',
  fs: fsImpl,
  stderr = process.stderr,
} = {}) {
  const fs = fsImpl ?? { existsSync, readFileSync }
  const template = fs.readFileSync(templatePath('validate-config.md'), 'utf8').toString()
  const configPath = join(projectRoot, 'ralph.config.sh')
  const configHash = hashConfig(configPath, fsImpl)
  return interpolate(
    template,
    {
      PROJECT_ROOT: projectRoot,
      CURRENT_CONFIG_HASH: configHash,
      RALPH_VERSION: ralphVersion,
    },
    { stderr },
  )
}

const invokedAsScript =
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (invokedAsScript) {
  process.stdout.write(buildValidatePrompt())
}
