// Pure run_id builder. A run_id ties all per-issue events from one Ralph loop
// invocation together: `<tmux-session-name>-<start-epoch-seconds>`.

export function buildRunId(sessionName, startEpochSeconds) {
  return `${sessionName}-${startEpochSeconds}`
}
