export { commandExists } from './utils/which.js'

// The acli install hint for linux and wsl, named once because it is ~150 characters
// of URL, flags and `&&` (#125). Every other entry in this table repeats its short
// hint across the two platforms, which reads fine at `apt install git` and as a
// hazard at this length: deps.qa.test.js pins `linux === wsl` for this dep, and a
// shared const satisfies that BY CONSTRUCTION rather than by whoever edits one line
// remembering the other. WSL is Linux for installation purposes, which is how the
// whole table already treats the pair.
const ACLI_LINUX_INSTALL =
  'curl -LO https://acli.atlassian.com/linux/latest/acli_linux_amd64/acli && chmod +x acli && sudo install -o root -g root -m 0755 acli /usr/local/bin/acli'

export const REQUIRED_DEPS = {
  git: {
    critical: true,
    install: {
      mac: 'brew install git',
      linux: 'apt install git',
      wsl: 'apt install git',
    },
  },
  gh: {
    critical: true,
    // Source CLI: gh is only required for the github task source (#565). When
    // TASK_SOURCE is anything else, checkDeps skips it entirely so a folder-only
    // or Jira-only machine is never told to install gh. `source` defaults to
    // 'github' below. The gate is shared with every other dep carrying a `source`
    // — `acli` next door is the second — so a change to it is a change to all of
    // them; see the one line that implements it in checkDeps.
    source: 'github',
    install: {
      mac: 'brew install gh',
      linux: 'apt install gh',
      wsl: 'apt install gh',
    },
  },
  acli: {
    critical: true,
    // Source CLI: the Atlassian CLI, required only for the jira task source
    // (#125), through the SAME `source` gate gh rides on above. A github or
    // folder repo is never told to install it, and a Jira repo — which may have
    // no GitHub at all — is never told to install gh.
    //
    // Critical rather than optional because a jira run has no fallback path to a
    // ticket without it, exactly as a github run has none without gh. Note that
    // `acli` ON PATH and `acli` LOGGED IN are different questions: this entry is
    // the first, and lib/jira-auth.js is the second (reported by `ralph doctor`,
    // never enforced by it).
    source: 'jira',
    install: {
      // Homebrew's short form of Atlassian's documented tap,
      // `atlassian/homebrew-acli` — brew prepends `homebrew-` to a tap's repo
      // name, so the two spell the same tap. Worth saying, because a reader
      // checking the official docs will see the longer name and wonder.
      mac: 'brew tap atlassian/acli && brew install acli',
      // The documented BINARY download, x86-64 — hoisted to a const above, where
      // its length is argued. The documented `apt` route needs a keyring plus a
      // repo file, which does not fit on one hint line a user can paste, and a
      // hint that has to be edited before it works is worse than a longer one
      // that does not. On ARM64 the same URL with `acli_linux_arm64` in place of
      // `acli_linux_amd64` is the right build.
      linux: ACLI_LINUX_INSTALL,
      wsl: ACLI_LINUX_INSTALL,
    },
  },
  tmux: {
    critical: true,
    install: {
      mac: 'brew install tmux',
      linux: 'apt install tmux',
      wsl: 'apt install tmux',
    },
  },
  claude: {
    critical: true,
    // Agent CLI: only the SELECTED agent's CLI is treated as critical (see
    // checkDeps below). The other agent's CLI is not checked.
    agent: true,
    install: {
      mac: 'npm install -g @anthropic-ai/claude-code',
      linux: 'npm install -g @anthropic-ai/claude-code',
      wsl: 'npm install -g @anthropic-ai/claude-code',
    },
  },
  codex: {
    critical: true,
    agent: true,
    // Codex CLI package name (verified: `@openai/codex` publishes the `codex`
    // binary; the installed CLI reports `codex --version`).
    install: {
      mac: 'npm install -g @openai/codex',
      linux: 'npm install -g @openai/codex',
      wsl: 'npm install -g @openai/codex',
    },
  },
  node: {
    critical: true,
    install: {
      mac: 'brew install node',
      linux: 'apt install nodejs',
      wsl: 'apt install nodejs',
    },
  },
  npm: {
    critical: true,
    install: {
      mac: 'brew install node',
      linux: 'apt install npm',
      wsl: 'apt install npm',
    },
  },
  jq: {
    critical: false,
    install: {
      mac: 'brew install jq',
      linux: 'apt install jq',
      wsl: 'apt install jq',
    },
  },
  curl: {
    critical: false,
    install: {
      mac: 'brew install curl',
      linux: 'apt install curl',
      wsl: 'apt install curl',
    },
  },
}

// Agent- and source-aware dependency check (#554, #565). Shared deps (git/tmux/
// node/npm/jq/curl) are always checked. Of the agent CLIs, ONLY the selected
// agent's CLI is included — the other agent's CLI is skipped entirely, so a
// Codex-only machine is never told to install `claude` (and vice-versa).
// Source-gated deps (gh, acli) are included only when the active TASK_SOURCE
// matches (gh => github, acli => jira, #125); a folder-only machine is never told
// to install either. `agent` defaults to 'claude' and `source` to 'github' so
// existing callers see exactly today's behavior.
export function checkDeps({
  hasCommand,
  deps = REQUIRED_DEPS,
  agent = 'claude',
  source = 'github',
} = {}) {
  const results = []
  for (const [name, info] of Object.entries(deps)) {
    // Skip the non-selected agent's CLI.
    if (info.agent && name !== agent) continue
    // Skip source-gated deps (gh, acli) when the active source differs (#565,
    // #125). One line, every gated dep — adding a source adds no branch here.
    if (info.source && info.source !== source) continue
    results.push({
      name,
      present: hasCommand(name),
      critical: info.critical,
      install: info.install,
    })
  }
  return results
}
