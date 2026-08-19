# Changelog

All notable changes to `@lucasfe/ralph` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.15.5](https://github.com/lucasfe/ralph/compare/v0.15.4...v0.15.5) (2026-08-19)


### Bug Fixes

* make `ralph start` folder-aware in TASK_SOURCE=folder mode ([#13](https://github.com/lucasfe/ralph/issues/13)) ([410ef9a](https://github.com/lucasfe/ralph/commit/410ef9a8aa3918c9300fcac18888445ca4aa93ad))

## [0.15.4](https://github.com/lucasfe/ralph/compare/v0.15.3...v0.15.4) (2026-08-13)


### Bug Fixes

* interactive global WhatsApp config setup in ralph init ([#5](https://github.com/lucasfe/ralph/issues/5)) ([#10](https://github.com/lucasfe/ralph/issues/10)) ([0517941](https://github.com/lucasfe/ralph/commit/05179411160b61c20df6145222e1d6cefea0d868))
* translate remaining Portuguese CLI/loop strings to English ([#6](https://github.com/lucasfe/ralph/issues/6)) ([#12](https://github.com/lucasfe/ralph/issues/12)) ([fc7bb7a](https://github.com/lucasfe/ralph/commit/fc7bb7a376a68f4467732218e6513420fb2e1aa2))

## [0.15.3](https://github.com/lucasfe/ralph/compare/v0.15.2...v0.15.3) (2026-08-13)


### Bug Fixes

* resolve WhatsApp creds from global config file ([#3](https://github.com/lucasfe/ralph/issues/3)) ([#7](https://github.com/lucasfe/ralph/issues/7)) ([8a0b885](https://github.com/lucasfe/ralph/commit/8a0b885f4fb0921fafd03d74bb1da57b11d86a4e))
* shell loop honors global config for notifications + smarter schedule warning ([#4](https://github.com/lucasfe/ralph/issues/4)) ([#9](https://github.com/lucasfe/ralph/issues/9)) ([462fb6d](https://github.com/lucasfe/ralph/commit/462fb6d58cdcf1b65603b3e9b5d36873eb3bda8f))

## [0.15.2](https://github.com/lucasfe/ralph/compare/v0.15.1...v0.15.2) (2026-08-12)


### Bug Fixes

* clarify cross-repo PRD links in README ([f804d63](https://github.com/lucasfe/ralph/commit/f804d638e33f58f023d320a4757298794056c76c))

## [0.15.1](https://github.com/lucasfe/agenthub/compare/ralph-v0.15.0...ralph-v0.15.1) (2026-08-07)


### Bug Fixes

* dev → main rollforward ([3f522dd](https://github.com/lucasfe/agenthub/commit/3f522dd6bf192f08d16b9463e9aadcbc5055a454))
* **ralph:** strip ANSI in doctor.test so it passes under CI color ([89139ca](https://github.com/lucasfe/agenthub/commit/89139ca2efb4c2325bf33ca4fd8db25f19343d46))

## [0.15.0](https://github.com/lucasfe/agenthub/compare/ralph-v0.14.0...ralph-v0.15.0) (2026-08-07)


### Features

* dev → main rollforward ([28f479b](https://github.com/lucasfe/agenthub/commit/28f479b449745c2d59ee924cfe6acc7f37cdfae0))
* **ralph:** agent selection in ralph init (flag, TTY prompt, non-interactive default) ([#588](https://github.com/lucasfe/agenthub/issues/588)) ([a22a7d5](https://github.com/lucasfe/agenthub/commit/a22a7d55654da452598902e16aafc08953fe16c7))
* **ralph:** configurable task source — GitHub issues or local folder ([#597](https://github.com/lucasfe/agenthub/issues/597)) ([8e7b90c](https://github.com/lucasfe/agenthub/commit/8e7b90cc3fad12589fd489f71a0eeded6f1b5d93))
* **ralph:** run config validation through the selected agent ([#591](https://github.com/lucasfe/agenthub/issues/591)) ([0789708](https://github.com/lucasfe/agenthub/commit/0789708bc10c4db271c99b627ad4c46c33cb7b81))

## [0.14.0](https://github.com/lucasfe/agenthub/compare/ralph-v0.13.0...ralph-v0.14.0) (2026-08-06)


### Features

* dev → main rollforward ([35136f4](https://github.com/lucasfe/agenthub/commit/35136f496d6807d12819e73bdbf54583220cc182))
* **ralph:** agent registry as single source of agent knowledge ([#577](https://github.com/lucasfe/agenthub/issues/577)) ([03fc888](https://github.com/lucasfe/agenthub/commit/03fc888b82e03b4c7ae1ae55c08471cf4ba46e0e))
* **ralph:** record resolved context_window on per-issue metrics events ([#573](https://github.com/lucasfe/agenthub/issues/573)) ([ed4d73b](https://github.com/lucasfe/agenthub/commit/ed4d73beaffe28b46ae60cfddeb90ef6c30f1fd9))
* **ralph:** support Codex as an alternative agent alongside Claude Code ([#574](https://github.com/lucasfe/agenthub/issues/574)) ([f3880f3](https://github.com/lucasfe/agenthub/commit/f3880f34a985e7f8401652751bf1aaac9a88a6b5))

## [0.13.0](https://github.com/lucasfe/agenthub/compare/ralph-v0.12.1...ralph-v0.13.0) (2026-06-18)


### Features

* dev → main rollforward ([ad156c9](https://github.com/lucasfe/agenthub/commit/ad156c95b320359ff077a8dc252a639b3e281b88))
* **ralph:** capture end-of-job context-window occupancy per issue ([#546](https://github.com/lucasfe/agenthub/issues/546)) ([9c7cad4](https://github.com/lucasfe/agenthub/commit/9c7cad48365906682d5d3b8cddef3c9c0605a067))
* **ralph:** per-issue event capture to issues.jsonl (minimal end-to-end) ([#535](https://github.com/lucasfe/agenthub/issues/535)) ([87955c5](https://github.com/lucasfe/agenthub/commit/87955c5ca5753ef932cec4f89584201a1628a533))
* **ralph:** real PR diff-stats in per-issue events ([#538](https://github.com/lucasfe/agenthub/issues/538)) ([9edd3e7](https://github.com/lucasfe/agenthub/commit/9edd3e7e42b20bed440687483fb7da5a8882c02e))


### Bug Fixes

* **ralph:** emit run event so ralph start runs reach the 24h rollup ([#540](https://github.com/lucasfe/agenthub/issues/540)) ([5856ee3](https://github.com/lucasfe/agenthub/commit/5856ee376988dc4099862ff4228188ac74202657))

## [0.12.1](https://github.com/lucasfe/agenthub/compare/ralph-v0.12.0...ralph-v0.12.1) (2026-06-13)


### Bug Fixes

* dev → main rollforward ([#524](https://github.com/lucasfe/agenthub/issues/524)) ([77f2d14](https://github.com/lucasfe/agenthub/commit/77f2d14d900bb915e34a5dabac5e9930bb41b3dc))

## [0.12.0](https://github.com/lucasfe/agenthub/compare/ralph-v0.11.0...ralph-v0.12.0) (2026-06-13)


### Features

* dev → main rollforward ([#519](https://github.com/lucasfe/agenthub/issues/519)) ([313c21b](https://github.com/lucasfe/agenthub/commit/313c21b8d119f895f0fa6d9ffb106cb2a8c88888))

## [0.11.0](https://github.com/lucasfe/agenthub/compare/ralph-v0.10.0...ralph-v0.11.0) (2026-06-13)


### Features

* dev → main rollforward ([#514](https://github.com/lucasfe/agenthub/issues/514)) ([3fc429e](https://github.com/lucasfe/agenthub/commit/3fc429e9d47c40a25543c05ae7c1975f0763e1e2))

## [0.10.0](https://github.com/lucasfe/agenthub/compare/ralph-v0.9.0...ralph-v0.10.0) (2026-06-13)


### Features

* dev → main rollforward ([#509](https://github.com/lucasfe/agenthub/issues/509)) ([42bc522](https://github.com/lucasfe/agenthub/commit/42bc52223add421da4e430d6c99c834a82858170))

## [0.9.0](https://github.com/lucasfe/agenthub/compare/ralph-v0.8.0...ralph-v0.9.0) (2026-06-13)


### Features

* add RALPH_HEAVY_TIER config flag + buildPrompt interpolation (dark-launch foundation) ([#490](https://github.com/lucasfe/agenthub/issues/490)) ([725dad0](https://github.com/lucasfe/agenthub/commit/725dad0472f2c7096d4680cc465309e1367a89f9))
* add sessionNameFor helper for per-project tmux session names ([#502](https://github.com/lucasfe/agenthub/issues/502)) ([b45f0cd](https://github.com/lucasfe/agenthub/commit/b45f0cd958e00dcb54ec9bf0b6b8d1f017c9e52b))
* dev → main rollforward ([1c6225a](https://github.com/lucasfe/agenthub/commit/1c6225a57fd66c08a1114b7257bb03dd41813616))
* Tier-2 explorer fan-out + inline synthesis (understand phase) ([#496](https://github.com/lucasfe/agenthub/issues/496)) ([3790c12](https://github.com/lucasfe/agenthub/commit/3790c1215ebefd2d9ff06d166dba32766b0df197))
* Tier-2 reviewer panel verify gate (3 diverse lenses, majority block) ([#499](https://github.com/lucasfe/agenthub/issues/499)) ([9545aee](https://github.com/lucasfe/agenthub/commit/9545aeea45b679ea8bb0a07b4078c697c70bdb83))

## [0.8.0](https://github.com/lucasfe/agenthub/compare/ralph-v0.7.0...ralph-v0.8.0) (2026-05-31)


### ⚠ BREAKING CHANGES

* **Ralph solo mode is permanently retired.** Team mode is now the only
  mode of operation — there is no activation flag to opt in or out.
  Every issue is resolved by the orchestrated team of specialists
  (dev → QA → review → writer, scaled by triage); the single-agent TDD
  loop now lives inside the dev role. The solo orchestrator template
  (`prompt-base.md`) has been removed, and a regression guard locks the
  retirement in so it cannot be silently reintroduced. ([#462](https://github.com/lucasfe/agenthub/issues/462))

### Features

* dev → main rollforward ([#457](https://github.com/lucasfe/agenthub/issues/457)) ([37d75f7](https://github.com/lucasfe/agenthub/commit/37d75f776029933d8a6e03e9f7e3d27677241037))
* dev → main rollforward ([#462](https://github.com/lucasfe/agenthub/issues/462)) ([c3d8719](https://github.com/lucasfe/agenthub/commit/c3d8719b9759a81d98da7143b6da2e6e37a742e1))

## [0.7.0](https://github.com/lucasfe/agenthub/compare/ralph-v0.6.0-rc.1...ralph-v0.7.0) (2026-05-31)


### Features

* add Ralph QA specialist role (augment-after-green, block-until-green) ([#447](https://github.com/lucasfe/agenthub/issues/447)) ([80a9a22](https://github.com/lucasfe/agenthub/commit/80a9a2224a24f5e98a5d1105360829a1ff0592bc))
* dev → main rollforward ([c5ced2c](https://github.com/lucasfe/agenthub/commit/c5ced2c175749d75f2cd78938c4a4661eb2bb83c))


### Miscellaneous Chores

* graduate ralph to 0.7.0 stable ([7d66159](https://github.com/lucasfe/agenthub/commit/7d661591b6f66c22d4910d814acc4bd05fb9ac55))

## [0.6.0-rc.1](https://github.com/lucasfe/agenthub/compare/ralph-v0.5.0-rc.1...ralph-v0.6.0-rc.1) (2026-05-31)


### Features

* add Ralph dev specialist role (inferred persona + TDD) ([#440](https://github.com/lucasfe/agenthub/issues/440)) ([0ec96e3](https://github.com/lucasfe/agenthub/commit/0ec96e3ef287523867956eeba2b47f72885d612d))
* add Ralph team-prompt orchestrator skeleton + composition seam ([#435](https://github.com/lucasfe/agenthub/issues/435)) ([75cbc85](https://github.com/lucasfe/agenthub/commit/75cbc8533184659d84a9bc657f7d0f816e90af99))
* dev → main rollforward ([3d1de04](https://github.com/lucasfe/agenthub/commit/3d1de04d653ae632d44d7b0fca4a426755d891a4))
* dev → main rollforward ([#433](https://github.com/lucasfe/agenthub/issues/433)) ([5246881](https://github.com/lucasfe/agenthub/commit/524688148ee59a7de46ffcbf210563cd10055691))

## [0.5.0-rc.1](https://github.com/lucasfe/agenthub/compare/ralph-v0.4.0-rc.1...ralph-v0.5.0-rc.1) (2026-04-30)


### Features

* dev → main rollforward ([#235](https://github.com/lucasfe/agenthub/issues/235)) ([e38068c](https://github.com/lucasfe/agenthub/commit/e38068c67bad4053c24c1e2ed555f652636b7e7c))
* dev → main rollforward ([#265](https://github.com/lucasfe/agenthub/issues/265)) ([958c923](https://github.com/lucasfe/agenthub/commit/958c9236ce4929218b947a229167f80d62c4cbad))

## [0.4.0-rc.1](https://github.com/lucasfe/agenthub/compare/ralph-v0.3.0-rc.1...ralph-v0.4.0-rc.1) (2026-04-29)


### Features

* **ralph:** TDD red-green-refactor enforcement in resolution loop ([6dd7b5b](https://github.com/lucasfe/agenthub/commit/6dd7b5bd55ae1a2e967b76ac3404157ad272d18b))

## [0.3.0-rc.1](https://github.com/lucasfe/agenthub/compare/ralph-v0.2.1-rc.1...ralph-v0.3.0-rc.1) (2026-04-29)


### Features

* **ralph:** pending-merge label for issues awaiting dev→main rollforward ([#130](https://github.com/lucasfe/agenthub/issues/130)) ([8e03b4a](https://github.com/lucasfe/agenthub/commit/8e03b4aabfe8ea9904a5b6fb878514dec99a0758))

## [0.2.1-rc.1](https://github.com/lucasfe/agenthub/compare/ralph-v0.2.0-rc.1...ralph-v0.2.1-rc.1) (2026-04-29)


### Bug Fixes

* ralph init preserves user credentials + chat selector bypass refactor ([#121](https://github.com/lucasfe/agenthub/issues/121)) ([9895b37](https://github.com/lucasfe/agenthub/commit/9895b372a634198c703ac3ebf411469c9c9c74e3))

## [0.2.0-rc.1](https://github.com/lucasfe/agenthub/compare/ralph-v0.1.0-rc.1...ralph-v0.2.0-rc.1) (2026-04-29)


### Features

* agent selector, ralph WhatsApp notifications, release-please bootstrap, pr-title gate ([#86](https://github.com/lucasfe/agenthub/issues/86)) ([81b86e9](https://github.com/lucasfe/agenthub/commit/81b86e94835c411fefed959ce979786337d2d9ea))

## [0.1.0] - Unreleased

First public release. Extracts the autonomous Ralph loop from the
`agenthub` repo into a reusable npm package, designed in [issue #13][prd]
and shipped across slices #14–#23.

[prd]: https://github.com/lucasfe/agenthub/issues/13

### Added

- `ralph` CLI binary with `init`, `start`, `stop`, `doctor`
  subcommands, plus `--version` and `--help` autogenerated by
  `commander`. (slice #1)
- `ralph start` and `ralph stop` wrap a tmux session named `ralph`,
  performing sanity checks before launch and a clean kill on stop.
  (slice #2)
- Bash loop (`ralph.sh`) shipped as a package template, with
  `PROJECT_ROOT` defense-in-depth: aborts when not in a git repo,
  refuses to run with `PROJECT_ROOT=$HOME` or `/`, and exports the
  resolved root for child tools. (slice #3)
- `detect-stack` module that maps manifest files (`package.json` +
  lockfiles, `pyproject.toml`, `requirements.txt`, `go.mod`,
  `Cargo.toml`, `Gemfile`, `composer.json`) to install/test/lint
  commands; falls back to empty when nothing matches. (slice #4)
- `ralph init` writes `ralph.config.sh`, `PROMPT.md` (project
  addendum), `.env.local.example`, `ralph-notify.sh.example`, and
  `.claude/commands/ralph.md`; appends `.ralph/`,
  `ralph-notify.sh`, and `.env.local` to `.gitignore` idempotently;
  prints a detected-values summary plus WhatsApp setup instructions.
  (slice #5)
- `ralph doctor` reports presence of required deps (`git`, `gh`,
  `tmux`, `claude`, `node`, `npm`) and optional deps (`jq`, `curl`),
  with platform-specific install commands for macOS, Linux, and WSL.
  (slice #6)
- Prompt split: `prompt-base.md` (in package, updated via `npm
  update`) holds the obligatory 8-step sequence and absolute
  restrictions; `PROMPT.md` (in project) holds the short addendum.
  An `interpolate` module fills `{{PROJECT_ROOT}}`, `{{INSTALL_CMD}}`,
  `{{PROJECT_PROMPT}}`, etc. at runtime. (slice #7)
- Lazy validation: `ralph.sh` computes `sha256(ralph.config.sh)` on
  every run; if it differs from `.ralph/state.json` (or
  `ralph_version` mismatched, or state absent), it invokes Claude
  one-shot via `templates/validate-config.md` to inspect manifests,
  fix the config, and rewrite the state. `rm -rf .ralph` forces
  revalidation. (slice #8)
- Notifications: built-in WhatsApp via CallMeBot when `.env.local`
  defines `CALLMEBOT_KEY` and `WHATSAPP_PHONE`; generic
  `./ralph-notify.sh` hook called with
  `(msg, status, ok_count, fail_count, duration_min)`; stdout
  always prints the summary. (slice #9)
- Startup WhatsApp ping: after `ralph start` successfully launches
  the tmux session, sends a WhatsApp notification announcing Ralph
  is online. Reuses the existing `CALLMEBOT_KEY` / `WHATSAPP_PHONE`
  credentials; the message body is configurable via
  `RALPH_STARTUP_MESSAGE` (defaults to a short "Ralph started" line).
  Skipped silently when credentials are absent; failures log a
  warning and never abort startup.
- Update check: `ralph start` runs `npm view @lucasfe/ralph version`
  with a 5s timeout, warns once per release, and stores
  `last_seen_release` in `.ralph/state.json` to dedupe the warning.
  Silent on network failure. (slice #10)
- Vitest infrastructure with `memfs` for hermetic tests on
  `detect-stack`, `init`, `doctor`, `interpolate`, `update-check`,
  `state`, `paths`, and the start/stop/env utilities.
- `ralph init --reset-prompt` flag for the rare case where the user
  wants to wipe `PROMPT.md` back to the package template after editing
  it. Default behavior is unchanged: `PROMPT.md` is preserved on
  re-run. The skip message now includes the `--reset-prompt` hint so
  users discover the opt-in. Tests in `lib/init.test.js` lock down the
  user-authored vs Ralph-authored file split: `.env.local`,
  `ralph-notify.sh`, `PROMPT.md` (without the flag), and
  `ralph.config.sh` are guaranteed untouched on re-run, so a future
  template-management refactor cannot silently overwrite credentials.
- `ralph schedule install / remove / pause / resume / status`:
  macOS-only launchd integration that runs `ralph cycle` on a timer
  (default 4h, configurable via `--interval`). `install` writes a
  per-repo plist under `~/Library/LaunchAgents/` and loads it via
  `launchctl`; `pause` / `resume` toggle the agent without deleting
  the plist; `status` reports loaded/paused state, last exit code,
  next-run interval, and live cycle-lock holder when present.
  (slices #220, #221)
- `ralph schedule heartbeat` + dual-plist install: in addition to the
  cycle agent, `ralph schedule install` writes a second plist
  (`com.lucasfe.ralph.heartbeat.<slug>.plist`) that fires daily at
  `RALPH_DAILY_SUMMARY_TIME` (default `09:00`) and sends a one-line
  WhatsApp summary of the last 24h of cycle logs — the *positive
  heartbeat* that proves Ralph is alive even on days when no issues
  moved. `pause`, `resume`, `remove`, and `status` operate on both
  plists transparently. Failures during summary aggregation degrade
  to `❌ Ralph 24h summary failed: <reason>` so silence never reads
  as healthy. (slice #223)

### Configuration

- `ralph.config.sh` schema: `INSTALL_CMD`, `TEST_CMD`, `LINT_CMD`,
  `MAIN_BRANCH`, `DEV_BRANCH`, `PR_TARGET`, `MERGE_STRATEGY`,
  `AUTO_MERGE`, `MERGE_POLL_INTERVAL`, `MERGE_POLL_MAX`.
- `.ralph/state.json` schema: `config_hash`, `validated_at`,
  `ralph_version`, `detected_stack`, `notes`, `last_seen_release`.
  Gitignored.

### Supported platforms

- Node ≥18 (ESM, no build step)
- macOS, Linux, WSL2 (Windows native is out of scope)
- Bash 3.2+ for the loop template

[0.1.0]: https://github.com/lucasfe/agenthub/releases/tag/ralph-v0.1.0
