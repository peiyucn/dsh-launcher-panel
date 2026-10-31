# 🐳dsh-launcher-panel

[![Version](https://img.shields.io/github/package-json/v/peiyucn/dsh-launcher-panel?color=007ec6)](https://marketplace.visualstudio.com/items?itemName=peiyucn.dsh-launcher-panel) [![CI](https://img.shields.io/github/actions/workflow/status/peiyucn/dsh-launcher-panel/ci.yml?branch=main&label=ci)](https://github.com/peiyucn/dsh-launcher-panel/actions/workflows/ci.yml) [![VS Marketplace](https://img.shields.io/badge/VS%20Marketplace-dsh--launcher--panel-blue)](https://marketplace.visualstudio.com/items?itemName=peiyucn.dsh-launcher-panel) [![License](https://img.shields.io/github/license/peiyucn/dsh-launcher-panel)](https://github.com/peiyucn/dsh-launcher-panel/blob/main/LICENSE)

English | [简体中文](README.zh-CN.md) | [GitHub](https://github.com/peiyucn/dsh-launcher-panel)

Start **DeepSeek Harness** (dsh) inside VS Code and open its web UI in the built-in browser.

![DSH Launcher Panel](https://raw.githubusercontent.com/peiyucn/dsh-launcher-panel/main/resources/dsh-launcher-panel.png "ratio:0.62")

> This extension does **not** ship an LLM model, DeepSeek Harness itself, or a DeepSeek API key.

## Installation

Install from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=peiyucn.dsh-launcher-panel): open the Extensions view, search for **DSH Launcher Panel**, and click Install. Alternatively, download the latest `.vsix` from the [Releases page](https://github.com/peiyucn/dsh-launcher-panel/releases) and run `code --install-extension <file>.vsix`. Reload the window if the whale icon does not appear after installing. See [Environment](#environment) for the Node.js / pnpm prerequisites.

## Principles

* **Loose coupling** — the extension starts dsh only through its public entry points (a launcher-managed pnpm install or a source checkout) and reads only the stable `~/.dsh` data. It never depends on dsh internals, so your dsh plugins keep working, and the launcher keeps working across dsh upgrades.

## Features

* **Start / Stop** — installs dsh into a launcher-managed location on first run, then runs it and opens the web UI once it is ready.
* **Source run** — clones deepseek-harness into a managed location and runs it (`dsh.srcPath` overrides the location; an existing checkout there is reused). Installs deps and builds when they are missing, stale, or the checkout moved past its last build; the build runs `pnpm run clean` first and uses dsh's official profile so the web UI carries the same branding as the packaged dsh.
* **Dashboard panel** — server status, a live console (log files are clickable), DeepSeek's official API status with Peak / Off-peak pricing (weekends and Chinese public holidays bill at off-peak), and your account balance.
* **Multiple instances** — each instance owns a DSH home (`DSH_HOME`) and a profile inside it; the launcher assigns its Web UI port (`Default` keeps 3080, new instances get a five-digit port). The panel shows one tab per instance plus a `+` tab to create another; each tab can start/stop/open that instance, edit its name, home, auto-open and browser overrides, and delete it (stop first; the DSH data is never deleted). All instances share one dsh install and the global `dsh.runMode`.
* **DSH Update** — the ⟳ button checks for a new version and reveals Update when there is one (pkg reinstalls the channel's latest; source checks out the newest official `dsh-v…` tag, never upstream master). The check only lists tags and compares commits, so it downloads nothing; the actual source update fetches that tag first and can take a while on a checkout that is far behind. All instances must be stopped for an update.
* **Browser choice** — built-in or system browser.

## Usage

Click the 🐳DSH WebUI whale icon in the activity bar, then click **Start**. The status bar whale icon mirrors the launcher state (blue pill while running, pulsing spout while starting) — click it for a quick menu: its top line summarizes the current run (state, mode, dsh version and, while running, the web address); below that, every instance is listed with its port, state and home (the active one is marked), and picking one offers that instance's actions (Open / Start / Restart / Stop / Make Active). The bottom of the menu has the global actions (Open Web UI, Open Dashboard, Stop, Open Global Settings).

The panel's tab strip is the instance list. `+` opens the create form; each instance tab's Start/Stop/Open acts on that instance. Edit changes its name, home, auto-open and browser overrides; the home field follows `.dsh-{name}` until you edit it by hand, and new instances always use the `web` profile. Delete removes the instance from the launcher only. Ports are assigned by the launcher and are not edited in the panel — the running URL shows the active port. Creating an instance does not install or start anything by itself; the first Start creates the home/profile as needed.

## Settings

Settings → search "dsh":

| Key | Default | Description |
|---|---|---|
| dsh.runMode | pnpm | `pnpm` installs dsh into a launcher-managed location and runs `pnpm exec dsh web`; `source` runs a local checkout via tsx. Shared by every instance; stop all instances before switching. Machine-local, not synced: source mode depends on this machine's checkout and toolchain. |
| dsh.npmChannel | latest | npm dist-tag pkg mode installs from on first install, and what the Update button targets: `latest`, `next` (rc), or `alpha`. An installed dsh always starts as-is — the channel never downgrades or auto-upgrades it. Source mode ignores this and tracks the newest official `dsh-v…` tag instead. |
| dsh.pkgPath | empty | Optional: custom directory where pkg mode installs dsh. Empty uses a managed default. Machine-local path, not synced. |
| dsh.srcPath | empty | Optional: path to an existing deepseek-harness clone for source mode. Empty clones automatically. Machine-local path, not synced. |
| dsh.nodePath | empty | Path to node.exe; empty uses the node on PATH. Machine-local path, not synced. |
| dsh.port | 3080 | Legacy single-instance port. Read once to create the `Default` instance. Machine-local, not synced. |
| dsh.instancePortBase | 31000 | Five-digit base for ports assigned to new instances: the first gets base+1, the next base+2, and so on. The `Default` instance keeps 3080. Range 10000–65535; ports are not edited in the panel. Machine-local, not synced. |
| dsh.autoOpenBrowser | true | Default for instances that do not set their own override. Turn off to keep your current tab (the official page shows a reconnect prompt after a restart); the Start button's "New Tab" click still opens one per `dsh.browser`. |
| dsh.browser | built-in | Default browser for instances that do not set their own override. `built-in` uses VS Code's Simple Browser (falling back to the external browser when the built-in one is disabled); `external` opens the system browser. |
| dsh.hideConsole | true | Hide the console window on Windows so neither dsh nor its tool subprocesses flash a cmd window; turn off to show it for debugging. |
| dsh.clearServerLogOnStart | true | Clear each instance's server log at launch, so it holds only the current run. |
| dsh.sourceDebug | false | Print module-loading progress in source mode (`NODE_DEBUG=module`). Very verbose: the console shows a periodic count, the full detail goes to the server log. |
| dsh.instances | `[]` | Managed instances. Each entry has `{ id, name, home, profile, port, autoOpenBrowser?, browser? }`. `home` is `DSH_HOME` (empty means the default home); `profile` is a profile under `<home>/profiles`; `port` is assigned by the launcher and unique. Machine-local, not synced. |
| dsh.activeInstance | empty | Initial active instance for a newly opened window. Each window keeps its own active instance while open, so switching in another window does not change this one. Empty falls back to the first instance. Machine-local, not synced. |
| dsh.instanceBrand | true | Show the instance name below the official DeepSeek Harness wordmark in the Web UI. The launcher maintains a tiny local client bundle per profile; the line follows the current DSH language. No manual plugin install. Machine-local, not synced. |

## Notes

* pkg mode installs dsh with pnpm (the tool the dsh repo itself uses) and runs it directly. `npx` is not offered: npm's peer resolver can hang indefinitely on dsh's dependency graph. The first install records where it went in `dsh.pkgPath` / `dsh.srcPath`, so it shows up in Settings and stays pinned on that machine. These two (and `dsh.nodePath`) are machine-local paths and are deliberately not synchronized between machines; a `dsh.pkgPath` left over from another machine whose drive does not exist here is ignored in favor of the managed location.
* The panel's mode pill uses short labels: `pkg` = the pnpm mode, `src` = the source mode. The mode is global: every instance runs the same shared dsh tree, and switching it requires stopping all instances.
* Each instance is a runtime coordinate only: a `DSH_HOME`, a profile inside it, and an auto-assigned port. Its model/provider/preset/credential configuration lives in that home's profile and is not managed by the launcher. Two instances may point at the same home, but only one can run at a time (DSH's sessions/workspaces/credentials are shared); the panel shows a warning.
* Delete removes the instance from `dsh.instances` only. It never deletes the home, sessions or workspaces; remove those yourself if you want them gone.
* Start probes the instance's port first and adopts a server that is already running (for example after a VS Code reload), then opens its Web UI. Stop stops the server the launcher started; an adopted server is identified by its command line (`--port` plus the dsh entry) and stopped directly, without a confirmation dialog. If the port is held by a process the launcher cannot identify as this instance's DSH server, Stop leaves it running and says so in the panel and activity log instead of killing it.
* **Runtime** is the first section and shows the shared `deepseek harness` version, `pkg`/`src` mode and Update controls. The **Instances** section shows `home` and the shared package/source path and contains Start / New Tab / Stop. The DeepSeek API section is collapsed by default (title + Peak/Off-peak); expanding it shows model and other APIs in two columns. **Settings** at the bottom has no frame.
* Update checks/updates the one shared dsh install and requires all instances stopped.
* Closing VS Code does not stop the servers. Stop them from the panel or the command palette.
* The API Status card supports DeepSeek only, and appears only when the active instance's home has a DeepSeek model configured. Balance is queried with the active instance's credentials.
* Log files are per instance: `~/.dsh-launcher-panel/logs/instances/<id>/client.log` (that instance's launcher activity) and `.../server.log` (dsh's own output). Both follow the active tab and are clickable in the panel. Extension-wide events (dsh install/update/detection, window activity) go to the shared `~/.dsh-launcher-panel/logs/client.log`. The legacy single-instance `logs/server.log` is still read when the default instance adopts an old run. Those dirs live directly under your home directory (`%USERPROFILE%` on Windows).
* The 🐳 artwork (activity bar icon and status bar icon font) is Twemoji's spouting whale (Twitter, Inc., CC-BY 4.0), rendered as a monochrome silhouette — see NOTICE.

## Known limitations

* **Voice input does not work in the built-in browser.** If you enable dsh's voice input plugin, recording in VS Code's built-in browser fails with *Unable to decode audio data* when you stop, so no text is inserted; the microphone itself works (the level meter reacts while you speak). This is a limitation of the built-in browser's audio decoding, not of this extension or of dsh's speech recognition — reproduced on VS Code 1.139.1 (Windows x64), where the same dsh dictates fine in the system browser. Set `dsh.browser` to `external` until this is fixed upstream.
* **Instances share one dsh install and one run mode.** pkg/src is global, not per instance; switching it requires stopping every instance. Instance-specific data is only the home/profile/port.
* **Editing an instance's home only repoints it.** The launcher never moves or copies DSH data; do that yourself before starting the instance at the new location.
* **The per-instance browser/auto-open overrides apply to Start and Open.** The footer browser selector still changes the global default.

## Environment

* **Node.js** — 22.x (22.19 or later) or >= 24 (the 23.x line is not supported)
* **pnpm** — required for the default pnpm mode; if missing, the extension installs it automatically (`npm install -g pnpm`) on first start
* **VS Code** — 1.85+
* **PowerShell 7** — optional; recommended on Windows (dsh's tool subprocesses use `pwsh`). The launcher itself never runs a shell.
* **C toolchain** — source mode on macOS/Linux only: dsh's build compiles a small native helper, so `cc` and Node's development headers (`include/node`, shipped by official Node installs) must be present. Windows builds skip the native step, and pkg mode never needs a compiler.

## License

MIT
