# Changelog

All notable changes to this project will be documented in this file.

English | [简体中文](CHANGELOG.zh-CN.md)

## [0.2.8]

- Start no longer overwrites a foreign package.json: when `dsh.pkgPath` points at a folder of your own that has dsh installed, the launcher leaves its manifest alone (it only ever writes its own install manifest).

## [0.2.7]

- pkg mode starts the installed dsh as-is: the channel (`dsh.npmChannel`) only decides what to install on first run and what the Update button targets — switching channels no longer reinstalls or downgrades at Start, and starting works offline.
- Start no longer stalls on a background reinstall that could fail on registry issues and block a working install.

## [0.2.6]

- Source mode shows an honest version: `git describe` output (e.g. `dsh-v0.1.2-rc.1` or `dsh-v0.1.2-rc.1-99-g76fda72`) instead of the checkout manifest's version, which only changes when a release is cut.
- Source-mode updates pin the newest official `dsh-v…` release tag (resolved straight from git: fetch that one tag, then a detached checkout) instead of `git pull` on master; the update check compares the checkout against that tag.
- Source mode detects when a checkout moved past its last build (the commit hash in dsh's own client build record vs. HEAD) and prompts to rebuild — previously only dependency changes triggered a rebuild, so a tag switch could serve stale web-client artifacts.
- Settings renamed for clarity: `dsh.mode` → `dsh.runMode`, `dsh.channel` → `dsh.npmChannel`, `dsh.path` → `dsh.srcPath`; values stored under the old keys migrate automatically on activation.
- `dsh.npmChannel` now accepts `alpha` (`latest` / `next` / `alpha`); it is an npm-only setting — source mode ignores it and always tracks the newest official release tag.
- Settings are ordered by relevance in the Settings UI.

## [0.2.5]

- Release-audit fixes: Stop no longer force-kills whatever owns the port when a tracked server exists (avoids taking down unrelated apps); the dsh version row no longer flashes a placeholder during first-run installs; a failed status refresh no longer unlocks the Check-updates button early or mislabels Start as "Install & Start"; concurrent busy operations each clear only their own spinner.
- The Browser dropdown now supports keyboard navigation (arrow keys / Home / End, Enter picks).
- Error messages mask user paths consistently (install/clone progress keeps full paths so you can see where things land).

## [0.2.4]

- The Dashboard visual style now follows the official DSH design style.

## [0.2.3]

- Added the `dsh.autoOpenBrowser` setting (Settings UI, default on): when off, Start no longer opens a browser tab automatically — keep your existing tab (the official page shows a reconnect prompt after a restart). The Start button's "New Tab" click still opens one per `dsh.browser`.

## [0.2.2]

- The launcher follows dsh 0.1.2-alpha.1's one-time-token web URL without breaking older versions: it extracts the token from the server output and probes both URLs, preferring the plain URL when the running dsh serves it and falling back to the token URL when the plain one answers 401 (a valid token answers with a 303 cookie-minting redirect, which the probe stops at and the browser completes) — previously the panel stayed on Starting forever and the browser never opened; the token is only used to open the browser and never shown in the status bar or panel URL.
- Source mode runs `pnpm run clean` before building (when the checkout provides the script): after a git pull upgrades a checkout to a version that removed packages, stale `lib/` leftovers no longer break the build with missing-export errors; the clean step is skipped for older checkouts without the script and a failed clean warns but does not block the build.
- A failed update check is reported as failed instead of "up to date": when the registry lookup or `git fetch` cannot run (for example a network timeout), the panel console now says "Update check failed" rather than wrongly claiming dsh is current.

## [0.2.1]

- The status bar shows the whale icon only (no "DSH" text) and opens a quick-pick command menu on click: Open Web UI / Open Dashboard / Stop while running, Open Dashboard / Stop while starting or installing, Start & Open Web UI / Open Dashboard when stopped, plus Open Settings.
- The whale artwork is Twemoji's spouting whale (Twitter, Inc., CC-BY 4.0 — see NOTICE) shown as a monochrome silhouette with the eye and a belly band punched through: consistent in the activity bar, the status bar icon font and the marketplace icon; the view title is plain "DSH WebUI" text.
- While starting or installing, the spout above the whale pulses between two animation frames every 150 ms (replacing the braille dots).
- Fixed: the status bar item no longer paints its text in the brand blue only — on themes with a blue status bar the text was invisible. When the server is running it now uses its own blue background with white foreground (theme colors `dsh.statusBar.runningBackground` / `dsh.statusBar.runningForeground`, overridable per theme), keeping readable contrast on every theme.

## [0.2.0]

- Source mode: a freshly cloned checkout is set up (`pnpm install` + build) automatically — the extra "Setup now?" prompt right after the clone is gone (existing checkouts still ask before being set up).
- Source mode builds the web UI with dsh's official client profile, so the top-left shows the same DeepSeek Harness brand as the packaged dsh instead of "DSH Local Build <commit>"; a checkout built before this change is rebuilt once automatically.
- The managed dirs (package/source/logs) now default to `<home>/.dsh-launcher-panel` (`%USERPROFILE%\.dsh-launcher-panel` on Windows) instead of the platform data dir (`%LOCALAPPDATA%` / Library/Application Support / XDG data home), where enterprise policies can block writes; the pkg install folder is named `package`, mirroring the `source` checkout.
- Choosing the install location on first install now writes it into `dsh.pkgPath` / `dsh.path` even when the default location is chosen, so the actual path is visible in Settings and stays pinned if the managed default ever changes.
- The DeepSeek pricing pill follows the updated peak/off-peak rule: weekends (Beijing time) are billed at the off-peak rate all day, effective 2026-08-23 00:00 Beijing time.
- Stop now terminates in-flight setup commands (clone / install / build); stopping during a start no longer deadlocks later starts or briefly reports the server as running.
- Added a `DSH Launcher Panel: Stop` command so the server can also be stopped from the command palette.
- Source mode reuses an existing deepseek-harness checkout when the chosen install location already is one, instead of trying to clone into it; a non-empty, non-checkout folder now fails with a clear message.
- pkg mode refuses to install dsh into a folder that already contains other files, so pointing `dsh.pkgPath` at an existing project can no longer overwrite its manifest.
- The panel now distinguishes Installing (first-run setup) / Starting / Stopping states, driven by an explicit server lifecycle state machine (the internal `starting`/`stopRequested` flags are gone).
- pkg run mode (default) installs dsh into a launcher-managed directory via `pnpm install` and runs `pnpm exec dsh web`, approving build scripts non-interactively (the same thing npm does by default). npx was dropped because npm's peer resolver hangs on dsh's dependency graph.
- Source mode clones deepseek-harness automatically into a managed directory (`dsh.path` is an optional override) and runs it via tsx.
- On the first install with no location configured, the user can pick the default or a custom folder (`dsh.pkgPath` / `dsh.path`); the install path is only shown once a location is chosen.
- The panel shows status + dsh version (with Update and Check update buttons) + the install location (labeled `package` or `source` by mode) + data together at the top (the separate Requirements card is gone); node and launcher versions sit at the bottom.
- The Start button reads "Install & Start" when dsh isn't installed yet.
- Update is unified across modes (pkg reinstalls the latest, source pulls the checkout).
- Log files live in the managed `logs` folder alongside the package/source dirs (previously under %TEMP%).
- When pnpm is missing, Start installs it automatically without prompting; the DeepSeek API Status card shows model names without the trailing "api".
- Fixed: source-mode setup counts as "starting"; Stop during setup is honoured; `--no-open` is decided from the exact version being run.
- Tests are TypeScript (run via tsx against the source directly).

## [0.1.5]

- dsh ≥ rc.8 passes `--no-open`, keeping the panel's `dsh.browser` choice as the only opener (rc.8 opens the system browser on its own).
- Added `dsh.channel` (`latest` / `next`) so npx can follow the prerelease channel — rc.8 is published to `next`; set it to `next` to run rc.8 via npx.
- Update checks report network failures in the console instead of silently showing "no update".

## [0.1.4] - 2026-08-18

- Dashboard: both log files (launcher activity + server output) now appear as masked, clickable paths with their sizes, and the Clear button clears both.
- Added a `debug on/off` pill next to the Console title (source mode only) that toggles `dsh.sourceDebug` (`NODE_DEBUG=module`); module-loading noise is filtered out of the console and shown as a periodic count, with full detail kept in the server log.
- Added `dsh.clearServerLogOnStart` (default on) so each launch starts with a fresh server log instead of accumulating across runs.
- Requirements card now shows Node and DSH only (npm version removed — it always ships with Node).
- DeepSeek API Status card shows a Peak / Off-peak pricing pill (computed in UTC; tooltip shows local times).
- Start waits for the web server to actually serve a page before opening the browser, avoiding a blank tab, and reports how long it took once ready.
- Network-unreachable installs fail fast with a clear message; npx uses `--loglevel=http` so downloads stream into the console.
- Unified all spinners to the same braille dot-matrix style; activity entries are structured (busy flag) instead of string-matching icon characters.
- Log files now live in `%TEMP%\dsh-launcher-panel\` as `client.log` (launcher activity) and `server.log` (server output), keeping the lock-prone server log separate and shortening the paths shown in the panel.
- Panel title is now "🐳DSH WebUI: Dashboard".
- Fixed: the balance query parses `.credentials.yaml` in flow style (`{ KEY: value }`) as well as block style, so it no longer reports "no key" after model settings are re-saved.
- Fixed: Stop now interrupts an in-flight start (it was previously ignored while starting), and stopping kills the whole process tree on Windows so the server cannot restart on its own.
- Added a unit test suite (`npm test`, Node's built-in test runner) covering the path-masking, credential-parsing and status-parsing helpers.

## [0.1.3] - 2026-08-17

- Fixed: the balance query now reads the DeepSeek API key from every location dsh does (env, `.credentials.yaml`, `.env`), so it no longer reports "no key" when dsh is already configured.
- Code cleanup: removed dead code and enabled stricter compiler flags.

## [0.1.2] - 2026-08-17

- Balance button: secondary style and instant feedback (disabled + "querying…" + a console log with the result).
- Removed the unused `dsh.host` setting; the extension always targets 127.0.0.1, where dsh binds.
- Docs: added a panel screenshot and corrected the source-run and update descriptions.

## [0.1.1] - 2026-08-16

- The "Starting…" status now reads "Starting DeepSeek Harness Web UI…".
- Removed pop-up notifications for the DSH Update action; results now appear only in the panel console.
- Improved the extension description and search keywords.

## [0.1.0] - 2026-08-16

- Initial release: start DeepSeek Harness (dsh) from VS Code and open its web UI.
- Dashboard panel with live server status, console log, DeepSeek API status, and account balance.
- npx / source run-mode toggle: asks before restarting a running server, and stays in sync with the dsh.mode / dsh.path settings.
- dsh detection via npx (npm) or a local git clone (source), with one-click checkout setup.
- DSH Update (git pull) for source checkouts.
- Built-in / external browser choice for the web UI.
- Hidden console on Windows to avoid cmd window flashes.
