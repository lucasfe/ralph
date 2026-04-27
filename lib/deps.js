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
    install: {
      mac: 'npm install -g @anthropic-ai/claude-code',
      linux: 'npm install -g @anthropic-ai/claude-code',
      wsl: 'npm install -g @anthropic-ai/claude-code',
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

export function checkDeps({ hasCommand, deps = REQUIRED_DEPS } = {}) {
  const results = []
  for (const [name, info] of Object.entries(deps)) {
    results.push({
      name,
      present: hasCommand(name),
      critical: info.critical,
      install: info.install,
    })
  }
  return results
}
