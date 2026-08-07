import { existsSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { join, resolve } from 'node:path'
import { interpolate } from './interpolate.js'
import { templatePath } from './paths.js'
import { resolveAgent, agentSpec } from './agent-registry.js'
import { resolveSource } from './task-source.js'

export function buildPrompt({
  projectRoot = process.cwd(),
  env = process.env,
  fs: fsImpl,
  stderr = process.stderr,
} = {}) {
  const fs = fsImpl ?? { existsSync, readFileSync }
  // #554: select the orchestrator template from the resolved agent's spec
  // (prompt-team.md for claude, prompt-team-codex.md for codex) instead of
  // hardcoding one filename. Role composition + interpolation are unchanged.
  // #565: when TASK_SOURCE=folder, select the folder-mode orchestrator instead;
  // the github path (default) is the existing agent-selected template, unchanged.
  const { agent } = resolveAgent(env)
  const source = resolveSource(env)
  const templateName =
    source === 'folder' ? 'prompt-team-folder.md' : agentSpec(agent).orchestratorTemplate
  const orchestratorTemplate = fs.readFileSync(templatePath(templateName), 'utf8')
  const devRole = fs.readFileSync(templatePath('roles/dev.md'), 'utf8').toString()
  const qaRole = fs.readFileSync(templatePath('roles/qa.md'), 'utf8').toString()
  const reviewerRole = fs.readFileSync(templatePath('roles/reviewer.md'), 'utf8').toString()
  const writerRole = fs.readFileSync(templatePath('roles/writer.md'), 'utf8').toString()
  const explorerRole = fs.readFileSync(templatePath('roles/explorer.md'), 'utf8').toString()
  const projectPromptPath = join(projectRoot, 'PROMPT.md')
  const projectPrompt = fs.existsSync(projectPromptPath)
    ? fs.readFileSync(projectPromptPath, 'utf8').toString()
    : ''
  const vars = {
    INSTALL_CMD: env.INSTALL_CMD ?? '',
    TEST_CMD: env.TEST_CMD ?? '',
    LINT_CMD: env.LINT_CMD ?? '',
    MAIN_BRANCH: env.MAIN_BRANCH ?? 'main',
    DEV_BRANCH: env.DEV_BRANCH ?? 'main',
    PR_TARGET: env.PR_TARGET ?? 'main',
    MERGE_STRATEGY: env.MERGE_STRATEGY ?? 'squash',
    MERGE_POLL_INTERVAL: env.MERGE_POLL_INTERVAL ?? '30',
    MERGE_POLL_MAX: env.MERGE_POLL_MAX ?? '40',
    RALPH_HEAVY_TIER: env.RALPH_HEAVY_TIER ?? '0',
    TASK_SOURCE: source,
    PROJECT_ROOT: projectRoot,
    PROJECT_PROMPT: projectPrompt,
  }
  // Compose the specialist roles into the template before interpolation so
  // each role's own {{TEST_CMD}}/{{LINT_CMD}} placeholders resolve in the same
  // pass.
  const composed = orchestratorTemplate
    .replace('{{ROLE_DEV}}', () => devRole)
    .replace('{{ROLE_QA}}', () => qaRole)
    .replace('{{ROLE_REVIEW}}', () => reviewerRole)
    .replace('{{ROLE_WRITER}}', () => writerRole)
    .replace('{{ROLE_EXPLORER}}', () => explorerRole)
  return interpolate(composed, vars, { stderr })
}

const invokedAsScript =
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (invokedAsScript) {
  process.stdout.write(buildPrompt())
}
