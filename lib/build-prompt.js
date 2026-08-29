import { existsSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { join, resolve } from 'node:path'
import { interpolate } from './interpolate.js'
import { templatePath } from './paths.js'
import { resolveAgent, agentSpec } from './agent-registry.js'
import { resolveSource } from './task-source.js'
// #128: the two modules that already own "read a Jira key" and "make a foreign value safe to
// paste into one line". Both import nothing at all, so neither widens this module's graph.
import { usableJiraKey } from './jira-key.js'
import { oneLineEcho } from './one-line.js'

// #565 / #128: two task sources own the orchestrator template outright, because
// the delivery shape is a property of the SOURCE and not of the agent driving it
// — folder and jira both commit straight to DEV_BRANCH with no branch, no PR and
// no auto-merge, so claude and codex share one template per source. Every other
// source (github, plus anything unrecognized, which resolveSource() has already
// folded into the default) keeps the agent-selected template. A map rather than a
// second ternary: the arms are pure data and the fallback stays the one `??`.
const SOURCE_TEMPLATES = {
  folder: 'prompt-team-folder.md',
  jira: 'prompt-team-jira.md',
}

// #128: RALPH_TASK_KEY is the ONE var in the bag below whose value a REMOTE SYSTEM chose. It
// comes out of acli's own JSON, through lib/jira-queue.js's pick and bash's `export`, and it
// lands in NINE places in the rendered prompt (MEASURED: `grep -o '{{RALPH_TASK_KEY}}'
// templates/prompt-team-jira.md | wc -l` → 9), one of them a fenced
// `acli … view --key <KEY> --fields "*all" --json` a model reads as a command to run. So it is
// the one var treated like INPUT, and it is treated with the two modules that already own the
// job rather than a third spelling of validation here:
//
//   usableJiraKey (lib/jira-key.js) — the same call lib/jira-queue.js:273 already makes on the
//     pick, which is what closes the only reachable divergence: bash's `$task_key` is
//     post-`usableJiraKey`, so a prompt built from the RAW env value could quote
//     `logs/ralph-issue-  FOO-123  .log` for a file bash had written as
//     `logs/ralph-issue-FOO-123.log`. Same function, so the two agree by construction. It is
//     deliberately PERMISSIVE (read that module's header: the grammar VALIDATES and never
//     GATES) — a project key its regex has never seen is still the ticket acli said was next,
//     and refusing it would be Ralph's regex overruling the board.
//   oneLineEcho (lib/one-line.js) — exactly as lib/agent-registry.js:237 does for RALPH_AGENT
//     (#108). `usableJiraKey` trims but does not reject INTERIOR whitespace, so
//     `FOO-1<LF>rm -rf /` used to render as TWO lines inside that fenced block, the second one
//     carrying Ralph's own remaining flags after text Ralph never wrote. Every control code
//     point becomes U+FFFD, one for one.
//
//     ITS 200-CODE-POINT CAP (DIAGNOSTIC_MAX_CHARS, lib/one-line.js:52) IS KEPT ON PURPOSE,
//     and it is the one place this diverges from "echo back what was set". #108's bound exists
//     for a terminal box; here the argument is the 9 above — an N-character key is 9N
//     characters of remote-chosen text in the model's context, so the shared bound holds that
//     at 1800 instead of at nothing. Truncation is not silent either: `cap` ends the value with
//     `…`, which no key contains, so the agent's own `acli … view` fails on a name that
//     visibly is not one rather than on a plausible key naming a different ticket. A second,
//     jira-specific bound was the alternative and was rejected — two bounds is two things to
//     keep in sync, and nothing here needs a different number.
//
// AND A JIRA RENDER WITH NO USABLE KEY IS LOUD. `env.RALPH_TASK_KEY ?? ''` made unset and `''`
// byte-identical and produced a WELL-FORMED prompt with holes in it — `--key  --fields`,
// `"fix: <description> ()"`, `Resolves ` with nothing after it — and because the var is PRESENT
// in the bag, interpolate() has nothing to report and the `/\{\{[A-Z_]+\}\}/` sweep has no
// token to find, so nothing anywhere told anybody. The prompt still renders those holes and it
// WARNS rather than THROWS: templates/ralph.sh pipes `node lib/build-prompt.js` straight into
// the agent, so a throw would turn a nameless ticket into a dead invocation — the one outcome
// every other failure in the jira arm is written to avoid.
//
// ONLY FOR JIRA, both the warning and the read. MEASURED: `{{RALPH_TASK_KEY}}` appears in
// prompt-team-jira.md and in no other file under templates/ except ralph.sh's own comment, so a
// warning on the other sources would be noise about a value nothing renders — and many existing
// tests assert an empty `stderr` for a github/folder build. Returning '' for them also means an
// ambient RALPH_TASK_KEY (a previous jira run in the same shell, a developer's export) cannot
// reach a github prompt even if a later template edit added the placeholder to one.
function jiraTaskKey(source, env, stderr) {
  if (source !== 'jira') return ''
  const key = usableJiraKey(env.RALPH_TASK_KEY)
  if (key !== null) return oneLineEcho(key)
  // Which of the two states it was is the actionable half — "bash never exported a key" and "a
  // jira arm exported an empty one" have different causes — so the echo distinguishes them even
  // though the rendered prompt cannot. Sanitised on the way out for the same reason as above:
  // this line shares a stream with the agent's output.
  const setting =
    env.RALPH_TASK_KEY === undefined ? 'unset' : `'${oneLineEcho(env.RALPH_TASK_KEY)}'`
  stderr.write(
    `⚠️  build-prompt: TASK_SOURCE=jira but RALPH_TASK_KEY is ${setting} — the prompt names no work item\n`,
  )
  return ''
}

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
  // #565 / #128: when the resolved source has a template of its own (see
  // SOURCE_TEMPLATES above), it overrides the agent's; the github path (default)
  // is the existing agent-selected template, unchanged.
  const { agent } = resolveAgent(env)
  const source = resolveSource(env)
  const templateName = SOURCE_TEMPLATES[source] ?? agentSpec(agent).orchestratorTemplate
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
    // #128: the Jira ticket key the loop already selected and claimed. NOT a 1:1
    // env→placeholder pass-through like RALPH_HEAVY_TIER above it — see
    // `jiraTaskKey`, which is where the whole argument lives. The RALPH_ prefix is
    // what test/setup/hermetic-env.js neutralizes and test/helpers/env-surface.js
    // discovers by scan, so no hand-maintained list needs an entry.
    RALPH_TASK_KEY: jiraTaskKey(source, env, stderr),
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
