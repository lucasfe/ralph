export { commandExists } from './utils/which.js'

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
    install: {
      mac: 'brew install gh',
      linux: 'apt install gh',
      wsl: 'apt install gh',
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

// Agent-aware dependency check (#554). Shared deps (git/gh/tmux/node/npm/jq/
// curl) are always checked. Of the agent CLIs, ONLY the selected agent's CLI is
// included — the other agent's CLI is skipped entirely, so a Codex-only machine
// is never told to install `claude` (and vice-versa). `agent` defaults to
// 'claude' so existing callers see exactly today's behavior.
export function checkDeps({ hasCommand, deps = REQUIRED_DEPS, agent = 'claude' } = {}) {
  const results = []
  for (const [name, info] of Object.entries(deps)) {
    // Skip the non-selected agent's CLI.
    if (info.agent && name !== agent) continue
    results.push({
      name,
      present: hasCommand(name),
      critical: info.critical,
      install: info.install,
    })
  }
  return results
}
