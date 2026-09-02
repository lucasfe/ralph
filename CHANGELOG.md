# Changelog

All notable changes to `@lucasfe/ralph` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.25.3](https://github.com/lucasfe/ralph/compare/v0.25.2...v0.25.3) (2026-09-02)


### Bug Fixes

* make the npm 403 diagnosable — surface the OIDC token exchange ([#191](https://github.com/lucasfe/ralph/issues/191)) ([7322baa](https://github.com/lucasfe/ralph/commit/7322baa9b66f56bc828390785826ffaea65136aa))

## [0.25.2](https://github.com/lucasfe/ralph/compare/v0.25.1...v0.25.2) (2026-09-02)


### Bug Fixes

* npm publish 403 — setup-node's registry-url was configuring a placeholder token ([#189](https://github.com/lucasfe/ralph/issues/189)) ([1ee3157](https://github.com/lucasfe/ralph/commit/1ee3157457b77eac55a530082372344af1e1b33e))

## [0.25.1](https://github.com/lucasfe/ralph/compare/v0.25.0...v0.25.1) (2026-09-01)


### Bug Fixes

* unblock the npm publish — two red guards that only fire at release time ([#187](https://github.com/lucasfe/ralph/issues/187)) ([1388080](https://github.com/lucasfe/ralph/commit/138808042330d1bffedb4fc85b54da61b42940ac))

## [0.25.0](https://github.com/lucasfe/ralph/compare/v0.24.0...v0.25.0) (2026-09-01)


### Features

* `ralph live` attaches to this repo's running loop, on a shared session module ([#167](https://github.com/lucasfe/ralph/issues/167)) ([#182](https://github.com/lucasfe/ralph/issues/182)) ([d222020](https://github.com/lucasfe/ralph/commit/d222020f57f9855e4eca42476381bd1139a594c4))
* the launch box, `start`'s session-exists abort and `ralph status` advertise `ralph live` ([#169](https://github.com/lucasfe/ralph/issues/169)) ([#184](https://github.com/lucasfe/ralph/issues/184)) ([1068e0b](https://github.com/lucasfe/ralph/commit/1068e0b7882b3acc1833dc1956abde14026188f9))


### Bug Fixes

* `ralph stop` resolves its session through the shared module and works from a subdirectory ([#168](https://github.com/lucasfe/ralph/issues/168)) ([#183](https://github.com/lucasfe/ralph/issues/183)) ([50dee86](https://github.com/lucasfe/ralph/commit/50dee8644f0ea21110759f955b1306c1d128c3db))
* a blanked config assignment makes the identity box name values the loop will not use ([#149](https://github.com/lucasfe/ralph/issues/149)) ([#179](https://github.com/lucasfe/ralph/issues/179)) ([2155ef2](https://github.com/lucasfe/ralph/commit/2155ef237d6389563232dc4108fd591015d40fb2))
* the identity box prints beside the sprite instead of under it ([#161](https://github.com/lucasfe/ralph/issues/161)) ([#181](https://github.com/lucasfe/ralph/issues/181)) ([74898c2](https://github.com/lucasfe/ralph/commit/74898c257cd5317b6c5f12e505acdbf9ce01d521))

## [0.24.0](https://github.com/lucasfe/ralph/compare/v0.23.0...v0.24.0) (2026-08-31)


### Features

* `ralph cycle` aborts when acli is not authed ([#134](https://github.com/lucasfe/ralph/issues/134)) ([#162](https://github.com/lucasfe/ralph/issues/162)) ([55056d5](https://github.com/lucasfe/ralph/commit/55056d525c85b7877965b454cf806615b62d9e6d))
* `ralph init` asks for the task source and the Jira knobs ([#133](https://github.com/lucasfe/ralph/issues/133)) ([#160](https://github.com/lucasfe/ralph/issues/160)) ([f16181d](https://github.com/lucasfe/ralph/commit/f16181d85ae0be5feb19f10bc5f1f58a88b7065c))
* `ralph start` warns when retired labels are still present ([#141](https://github.com/lucasfe/ralph/issues/141)) ([#172](https://github.com/lucasfe/ralph/issues/172)) ([d18d620](https://github.com/lucasfe/ralph/commit/d18d62082f30d40b023f9b3ce339c7d5b1602313))
* `ralph status` shows the Jira key and ticket summary ([#132](https://github.com/lucasfe/ralph/issues/132)) ([#159](https://github.com/lucasfe/ralph/issues/159)) ([ef26678](https://github.com/lucasfe/ralph/commit/ef26678a28bc11f50f221abe6f07b1c2b2c19f13))
* banner reports agent, model, context window, task source and repo ([#69](https://github.com/lucasfe/ralph/issues/69)) ([#115](https://github.com/lucasfe/ralph/issues/115)) ([8710eb2](https://github.com/lucasfe/ralph/commit/8710eb2e5e261004163bc81ef75f3e24ef0a1840))
* compose the Jira JQL and count the Jira queue ([#126](https://github.com/lucasfe/ralph/issues/126)) ([#152](https://github.com/lucasfe/ralph/issues/152)) ([557fc99](https://github.com/lucasfe/ralph/commit/557fc998e8ec30dd26c4a8a1c06fdca138dd4bc3))
* Jira completion — transition, done label, and a comment carrying the SHA ([#129](https://github.com/lucasfe/ralph/issues/129)) ([#156](https://github.com/lucasfe/ralph/issues/156)) ([4030c2d](https://github.com/lucasfe/ralph/commit/4030c2d575ddd764718679d04e0720da2d99ae36))
* Jira drain guarantee — sweep an unfinished ticket to `failed` ([#130](https://github.com/lucasfe/ralph/issues/130)) ([#157](https://github.com/lucasfe/ralph/issues/157)) ([16549e4](https://github.com/lucasfe/ralph/commit/16549e4e2d885fbbe2c9cd31ca68fdb52366cd7a))
* per-task table and progress against a live denominator in `ralph status` ([#56](https://github.com/lucasfe/ralph/issues/56)) ([#113](https://github.com/lucasfe/ralph/issues/113)) ([9aa49fc](https://github.com/lucasfe/ralph/commit/9aa49fce85f4b8269071ee550b89312c29552fd8))
* per-ticket telemetry carries the Jira key ([#131](https://github.com/lucasfe/ralph/issues/131)) ([#158](https://github.com/lucasfe/ralph/issues/158)) ([c505323](https://github.com/lucasfe/ralph/commit/c505323e594cda29248948e84266b3146c2f0788))
* register `jira` as a task source that `ralph doctor` validates ([#125](https://github.com/lucasfe/ralph/issues/125)) ([#151](https://github.com/lucasfe/ralph/issues/151)) ([1a6454d](https://github.com/lucasfe/ralph/commit/1a6454d15b1f08c9aa21940da211670ef602594b))
* rename `claude-working`/`claude-failed` to `in-progress`/`failed` ([#140](https://github.com/lucasfe/ralph/issues/140)) ([#165](https://github.com/lucasfe/ralph/issues/165)) ([d2069d4](https://github.com/lucasfe/ralph/commit/d2069d4c6314797c3fa93d8b467aef8ae9917e03))
* select a Jira ticket and claim it with `in-progress` ([#127](https://github.com/lucasfe/ralph/issues/127)) ([#153](https://github.com/lucasfe/ralph/issues/153)) ([e19c29a](https://github.com/lucasfe/ralph/commit/e19c29a647a24fb68d35a0626eaa71d6f3e1dda9))
* the Jira orchestrator prompt drives one ticket to a local commit ([#128](https://github.com/lucasfe/ralph/issues/128)) ([#155](https://github.com/lucasfe/ralph/issues/155)) ([aebae63](https://github.com/lucasfe/ralph/commit/aebae63b541ca88ce292f38d9051244c74c744cf))


### Bug Fixes

* read GH_REPO config-first, like every neighbouring knob ([#120](https://github.com/lucasfe/ralph/issues/120)) ([#146](https://github.com/lucasfe/ralph/issues/146)) ([53b2c91](https://github.com/lucasfe/ralph/commit/53b2c91f8d3c705da4049a481b8aa8036a66efa2))
* replace the warning-consumer source sweep with behavioural assertions ([#119](https://github.com/lucasfe/ralph/issues/119)) ([#145](https://github.com/lucasfe/ralph/issues/145)) ([1428ce3](https://github.com/lucasfe/ralph/commit/1428ce3617a110c8a9597671c9330b29f5d0c8fd))
* the assignment grammar refuses two spellings bash does not assign ([#147](https://github.com/lucasfe/ralph/issues/147)) ([#175](https://github.com/lucasfe/ralph/issues/175)) ([77b0cd9](https://github.com/lucasfe/ralph/commit/77b0cd96b12fce2ca6c42eb196d902ad37086314))
* warn on a typo'd RALPH_AGENT at launch, on stderr ([#118](https://github.com/lucasfe/ralph/issues/118)) ([#144](https://github.com/lucasfe/ralph/issues/144)) ([e36c4a3](https://github.com/lucasfe/ralph/commit/e36c4a38be56d20f7df88015d0348abcb1434b39))

## [0.23.0](https://github.com/lucasfe/ralph/compare/v0.22.0...v0.23.0) (2026-08-28)


### Features

* `ralph changelog` command, rendering the shipped changelog ([#71](https://github.com/lucasfe/ralph/issues/71)) ([#102](https://github.com/lucasfe/ralph/issues/102)) ([e521fcb](https://github.com/lucasfe/ralph/commit/e521fcb7467742d757f02ce375d64af90740c648))
* `RALPH_BANNER` setting with environment override ([#74](https://github.com/lucasfe/ralph/issues/74)) ([#105](https://github.com/lucasfe/ralph/issues/105)) ([532f486](https://github.com/lucasfe/ralph/commit/532f4867b567497d22d250a0af32c8b3e0cdfd5a))
* banner width degradation — unbox under 44 columns, drop sprite under 26 ([#72](https://github.com/lucasfe/ralph/issues/72)) ([#103](https://github.com/lucasfe/ralph/issues/103)) ([58e9ff4](https://github.com/lucasfe/ralph/commit/58e9ff4a6415591e0aefe1b761e1d557e31ae210))
* identity box in `ralph doctor` ([#75](https://github.com/lucasfe/ralph/issues/75)) ([#106](https://github.com/lucasfe/ralph/issues/106)) ([4a217ca](https://github.com/lucasfe/ralph/commit/4a217ca5392fb267cc513aadfcc34151759f2bb0))
* identity box in `ralph status` ([#76](https://github.com/lucasfe/ralph/issues/76)) ([#109](https://github.com/lucasfe/ralph/issues/109)) ([19257ff](https://github.com/lucasfe/ralph/commit/19257ff5b522b2e85f1467e2b997c423373bf6b4))
* one-shot splash animation that settles to a static frame ([#73](https://github.com/lucasfe/ralph/issues/73)) ([#104](https://github.com/lucasfe/ralph/issues/104)) ([32a10f4](https://github.com/lucasfe/ralph/commit/32a10f467f2fe854491d346ebd56f81a553b9eff))
* the banner's identity box with version and update hint ([#68](https://github.com/lucasfe/ralph/issues/68)) ([#100](https://github.com/lucasfe/ralph/issues/100)) ([5c85e01](https://github.com/lucasfe/ralph/commit/5c85e01f21779c0f1f2b5d5e753c9ca3858b3847))
* What's new bullets in the banner, parsed from the shipped CHANGELOG ([#70](https://github.com/lucasfe/ralph/issues/70)) ([#101](https://github.com/lucasfe/ralph/issues/101)) ([fd4b3ba](https://github.com/lucasfe/ralph/commit/fd4b3bad4b42817854b9f44cff8b28b66d6355b1))


### Bug Fixes

* sanitise the RALPH_AGENT echo so no value can forge a line ([#108](https://github.com/lucasfe/ralph/issues/108)) ([#112](https://github.com/lucasfe/ralph/issues/112)) ([2aeadba](https://github.com/lucasfe/ralph/commit/2aeadba145d45d7eae7f6f562f88a190a3d56a30))
* scope the banner's no-escape assertions to the sprite, not all ANSI ([#67](https://github.com/lucasfe/ralph/issues/67)) ([#98](https://github.com/lucasfe/ralph/issues/98)) ([5d2de88](https://github.com/lucasfe/ralph/commit/5d2de880d3667177a8fb3ffc1df75ef68230014e))

## [0.22.0](https://github.com/lucasfe/ralph/compare/v0.21.0...v0.22.0) (2026-08-27)


### Features

* `ralph digest --loop` + a digest window in the tmux session ([#62](https://github.com/lucasfe/ralph/issues/62)) ([#95](https://github.com/lucasfe/ralph/issues/95)) ([a2f9464](https://github.com/lucasfe/ralph/commit/a2f9464f63accb38808ee7541694e0ee74af39c9))
* `ralph digest` one-shot — no-tool narration on a cheap model ([#61](https://github.com/lucasfe/ralph/issues/61)) ([#93](https://github.com/lucasfe/ralph/issues/93)) ([6687570](https://github.com/lucasfe/ralph/commit/6687570de85934b65597f22746e7e86f501e2e1e))
* a digest section in `ralph status` ([#63](https://github.com/lucasfe/ralph/issues/63)) ([#96](https://github.com/lucasfe/ralph/issues/96)) ([a6c37ba](https://github.com/lucasfe/ralph/commit/a6c37ba02d4ab248dac470e14dbbf8ad4a6fa87d))
* commit the sprite asset and show it statically in `ralph start` ([#67](https://github.com/lucasfe/ralph/issues/67)) ([#97](https://github.com/lucasfe/ralph/issues/97)) ([541616f](https://github.com/lucasfe/ralph/commit/541616fc2de65fe376dcad7dfc5993816572e8f2))

## [0.21.0](https://github.com/lucasfe/ralph/compare/v0.20.0...v0.21.0) (2026-08-26)


### Features

* GIF-to-sprite generator and pure half-block renderer ([#66](https://github.com/lucasfe/ralph/issues/66)) ([#87](https://github.com/lucasfe/ralph/issues/87)) ([6d1834b](https://github.com/lucasfe/ralph/commit/6d1834b540a5a55c8a8a7b01aedd478ca874e9b1))
* idle post-mortem and never-run pointer in `ralph status` ([#59](https://github.com/lucasfe/ralph/issues/59)) ([#91](https://github.com/lucasfe/ralph/issues/91)) ([46ddd1e](https://github.com/lucasfe/ralph/commit/46ddd1e184a90c036956a3c98ec50730bb66e544))


### Bug Fixes

* never finish a turn with a subagent in flight ([#88](https://github.com/lucasfe/ralph/issues/88)) ([#89](https://github.com/lucasfe/ralph/issues/89)) ([c18ea21](https://github.com/lucasfe/ralph/commit/c18ea2141236f0d04959c8af8c8b3efb6db60cf8))

## [0.20.0](https://github.com/lucasfe/ralph/compare/v0.19.1...v0.20.0) (2026-08-26)


### Features

* `ralph status --json` ([#58](https://github.com/lucasfe/ralph/issues/58)) ([#84](https://github.com/lucasfe/ralph/issues/84)) ([15c8ae0](https://github.com/lucasfe/ralph/commit/15c8ae0c3c6cd5e1fac5d4451e12b7f88e3115f4))
* launch projection and `ralph status` hint in the `ralph start` box ([#60](https://github.com/lucasfe/ralph/issues/60)) ([#85](https://github.com/lucasfe/ralph/issues/85)) ([ec042ac](https://github.com/lucasfe/ralph/commit/ec042acdc1dbedb3074a65b84e30244400da99c6))
* observed pace, ETA with range, and spend projection in `ralph status` ([#57](https://github.com/lucasfe/ralph/issues/57)) ([#83](https://github.com/lucasfe/ralph/issues/83)) ([89da13d](https://github.com/lucasfe/ralph/commit/89da13da9f63646187e1ab36682e544b455dc9a2))
* print the update notice in `ralph cycle` ([#51](https://github.com/lucasfe/ralph/issues/51)) ([#79](https://github.com/lucasfe/ralph/issues/79)) ([2cde79f](https://github.com/lucasfe/ralph/commit/2cde79ffb43800a2b63c3ee29ab28f14024c8c6f))
* run-state file + `ralph status` reporting the in-flight task ([#55](https://github.com/lucasfe/ralph/issues/55)) ([#82](https://github.com/lucasfe/ralph/issues/82)) ([330cedf](https://github.com/lucasfe/ralph/commit/330cedf582597674c9986e42f08bad5a5be1d771))
* TTY-gated update prompt in `ralph cycle`, stopping the drain after an install ([#52](https://github.com/lucasfe/ralph/issues/52)) ([#81](https://github.com/lucasfe/ralph/issues/81)) ([c4a9ec8](https://github.com/lucasfe/ralph/commit/c4a9ec88622a06b7a07c8c0f36efe625de4eabc0))

## [0.19.1](https://github.com/lucasfe/ralph/compare/v0.19.0...v0.19.1) (2026-08-25)


### Miscellaneous Chores

* release 0.19.1 ([28fabbe](https://github.com/lucasfe/ralph/commit/28fabbeb27f6da29a853e0adcd306e0aac7c951b))


### Notes

* **No change to the published package** — the tarball is identical to 0.19.0. The only work since v0.19.0 is test infrastructure: the suite is now hermetic against the ambient environment, so a local `npm test` and a CI `npm test` agree ([#41](https://github.com/lucasfe/ralph/issues/41)) ([#47](https://github.com/lucasfe/ralph/issues/47)). It touches `test/`, `vitest.config.js` and `CONTRIBUTING.md`, none of which ship in `bin`/`lib`/`templates`. Released for the tag and changelog record only.

## [0.19.0](https://github.com/lucasfe/ralph/compare/v0.18.0...v0.19.0) (2026-08-24)


### Features

* weekly prompt throttle + prompt-from-cache when offline ([#26](https://github.com/lucasfe/ralph/issues/26)) ([#42](https://github.com/lucasfe/ralph/issues/42)) ([85c8bc8](https://github.com/lucasfe/ralph/commit/85c8bc8670802ea042896c6f533b0bebf655fd6f))


### Bug Fixes

* clear stale claude-working label on every terminal outcome ([#40](https://github.com/lucasfe/ralph/issues/40)) ([#46](https://github.com/lucasfe/ralph/issues/46)) ([2b804de](https://github.com/lucasfe/ralph/commit/2b804de02501e8c9201dbe17d4616b3fbf472f6b))
* honor is_error so a failed run is never reported as success ([#39](https://github.com/lucasfe/ralph/issues/39)) ([#45](https://github.com/lucasfe/ralph/issues/45)) ([aa3fc33](https://github.com/lucasfe/ralph/commit/aa3fc33cb49da439a62b52f2a3c7f0f59ce73a4f))

## [0.18.0](https://github.com/lucasfe/ralph/compare/v0.17.0...v0.18.0) (2026-08-23)


### Features

* cached installed-vs-latest version line in `ralph doctor` ([#27](https://github.com/lucasfe/ralph/issues/27)) ([#38](https://github.com/lucasfe/ralph/issues/38)) ([325c31e](https://github.com/lucasfe/ralph/commit/325c31ef2f4e443f6ee1c1a3fbec05f37728c30d))
* TTY-gated update prompt in `ralph start` ([#25](https://github.com/lucasfe/ralph/issues/25)) ([#36](https://github.com/lucasfe/ralph/issues/36)) ([c594f6e](https://github.com/lucasfe/ralph/commit/c594f6e5f000071f2055c4eee2885d76f0c08cb0))

## [0.17.0](https://github.com/lucasfe/ralph/compare/v0.16.0...v0.17.0) (2026-08-23)


### Features

* weekly cache-backed update check + notice in `ralph start` ([#24](https://github.com/lucasfe/ralph/issues/24)) ([#34](https://github.com/lucasfe/ralph/issues/34)) ([1dfe663](https://github.com/lucasfe/ralph/commit/1dfe663cb8df3da07db40d18c52086b93a827802))


### Bug Fixes

* classify pnpm/yarn/bun global, npx cache, and linked installs ([#22](https://github.com/lucasfe/ralph/issues/22)) ([#31](https://github.com/lucasfe/ralph/issues/31)) ([d499528](https://github.com/lucasfe/ralph/commit/d4995284ab9c6b92e354c6c54f9f7b8057f409d7))
* install-failure diagnostics for `ralph update` ([#23](https://github.com/lucasfe/ralph/issues/23)) ([#33](https://github.com/lucasfe/ralph/issues/33)) ([15b3cfb](https://github.com/lucasfe/ralph/commit/15b3cfb6302974e3ccdaf94838e3274a6a718dbd))

## [0.16.0](https://github.com/lucasfe/ralph/compare/v0.15.6...v0.16.0) (2026-08-22)


### Features

* add `ralph update` for npm-global installs ([#21](https://github.com/lucasfe/ralph/issues/21)) ([#29](https://github.com/lucasfe/ralph/issues/29)) ([9d80afe](https://github.com/lucasfe/ralph/commit/9d80afe9c39fa2b168dc36b4947a8444fbe151c4))

## [0.15.6](https://github.com/lucasfe/ralph/compare/v0.15.5...v0.15.6) (2026-08-19)


### Bug Fixes

* make `ralph init` fail outside a git repository ([#16](https://github.com/lucasfe/ralph/issues/16)) ([#19](https://github.com/lucasfe/ralph/issues/19)) ([0282971](https://github.com/lucasfe/ralph/commit/028297140f74144580f55905ccfd24163c17a2be))
* replace contentless tool_result flood with informative tool_use lines ([#15](https://github.com/lucasfe/ralph/issues/15)) ([#17](https://github.com/lucasfe/ralph/issues/17)) ([13b957f](https://github.com/lucasfe/ralph/commit/13b957f9b16d0b32208ee7df52f83f7dd1f87525))

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
