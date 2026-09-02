# DSH Launcher Panel

[![Version](https://img.shields.io/github/package-json/v/peiyucn/dsh-launcher-panel?style=for-the-badge)](https://marketplace.visualstudio.com/items?itemName=peiyucn.dsh-launcher-panel)
[![VS Marketplace](https://img.shields.io/badge/VS%20Marketplace-dsh--launcher--panel-blue?style=for-the-badge)](https://marketplace.visualstudio.com/items?itemName=peiyucn.dsh-launcher-panel)
[![License](https://img.shields.io/github/license/peiyucn/dsh-launcher-panel?style=for-the-badge)](https://github.com/peiyucn/dsh-launcher-panel/blob/main/LICENSE)

English | [简体中文](README.zh-CN.md) | [GitHub](https://github.com/peiyucn/dsh-launcher-panel)

Start **DeepSeek Harness** (dsh) inside VS Code and open its web UI in the built-in browser.

![DSH Launcher Panel](https://raw.githubusercontent.com/peiyucn/dsh-launcher-panel/main/resources/dsh-launcher-panel.png)

> This extension does **not** ship an LLM model, DeepSeek Harness itself, or a DeepSeek API key.

## Principles

* **Loose coupling** — the extension starts dsh only through its public entry points (a launcher-managed pnpm install or a source checkout), reads only the stable `~/.dsh` data, and never depends on dsh internals — so your dsh plugins keep working as-is, and the launcher keeps working across dsh upgrades.

## Features

* **Start / Stop** — installs dsh into a launcher-managed location (first run), then runs `pnpm exec dsh web` and opens the web UI once it is ready.
* **Source run** — clones deepseek-harness automatically into a managed location and runs it (a custom `dsh.path` overrides the clone location); an existing checkout at that path is reused as-is. On first start it also runs `pnpm install` + build; the build is preceded by `pnpm run clean` (when the checkout provides the script) to clear stale build residue, and uses dsh's official build profile so the web UI shows the same DeepSeek Harness brand as the packaged dsh.
* **Dashboard panel** — server status, a live console (with clickable log files), the official DeepSeek API status with Peak / Off-peak pricing (weekends are billed at the off-peak rate), and your account balance.
* **DSH Update** — click the refresh button (⟳) to check; when a new version is available, an Update button appears next to the dsh version (pkg reinstalls the latest, source pulls the checkout).
* **Browser choice** — built-in or system browser.

## Usage

Click the 🐳DSH WebUI whale icon in the activity bar, then click **Start**. The status bar whale icon mirrors the launcher state (blue pill while running, pulsing spout while starting) — click it for a quick menu: Open Web UI / Open Dashboard / Stop / Open Settings.

## Settings

Settings → search "dsh":

| Key | Default | Description |
|---|---|---|
| dsh.mode | pnpm | `pnpm` installs dsh into a launcher-managed location and runs `pnpm exec dsh web`; `source` runs a local checkout via tsx |
| dsh.channel | latest | dist-tag pnpm resolves: `latest` (stable) or `next` (prereleases) |
| dsh.browser | built-in | `built-in` uses VS Code's Simple Browser (falls back to the system browser if unavailable); `external` opens the system browser |
| dsh.autoOpenBrowser | true | Automatically open the browser after Start; turn off to keep your current tab (the Start button's "New Tab" click still opens one per `dsh.browser`) |
| dsh.hideConsole | true | Hide the server console window on Windows |
| dsh.path | empty | Optional: path to an existing deepseek-harness clone for source mode. When empty, the extension clones the repo automatically. |
| dsh.pkgPath | empty | Optional: custom directory where pkg mode installs dsh. When empty, a managed default location is used. |
| dsh.nodePath | empty | Path to node.exe; empty uses the node on PATH |
| dsh.port | 3080 | Web UI port |
| dsh.sourceDebug | false | Print module-loading progress in source mode (NODE_DEBUG=module, very verbose; console shows a periodic count, full detail in the server log) |
| dsh.clearServerLogOnStart | true | Clear the server log file at the start of each launch so it only contains the current run |

## Notes

* The default pnpm mode installs dsh with pnpm (the tool the dsh repo itself uses) into a managed location and runs it directly — npm's peer resolver can hang indefinitely on dsh's dependency graph, so `npx` is not offered. On the first install the chosen location (default or custom) is recorded in `dsh.pkgPath` / `dsh.path`, so it shows up in Settings and stays pinned.
* The mode pill in the panel uses short labels: `pkg` = the pnpm mode, `src` = the source mode. When `dsh.path` does not point at an existing checkout, the launcher asks where to clone.
* The panel shows where dsh lives (`package` in pkg mode, `source` in source mode) and the `data` (`~/.dsh`) locations; the dsh row has Update and Check updates buttons.
* Start/stop is idempotent: it probes the port first and does not start twice.
* Closing VS Code does not stop the server; stop it from the panel or command palette.
* The 🐳 whale artwork (activity bar icon + status bar icon font) is Twemoji's spouting whale (Twitter, Inc., CC-BY 4.0) rendered as a monochrome silhouette with punched eye and belly-band details — see NOTICE.
* The **API Status** card supports DeepSeek only for now — it only shows when a DeepSeek model is configured in dsh.
* Log files: `~/.dsh-launcher-panel/logs/client.log` (launcher activity) and `server.log` (server output), alongside the managed package/source dirs; both are clickable in the panel. The managed dirs live directly under the user's home directory (`%USERPROFILE%` on Windows).
* DSH cannot run "minimal mode" properly on Windows for now.

## Environment

* **Node.js** — 22.x (22.19 or later) or >= 24 (the 23.x line is not supported)
* **pnpm** — required for the default pnpm mode; if missing, the extension installs it automatically (`npm install -g pnpm`) on first start
* **VS Code** — 1.85+
* **PowerShell 7** — optional; recommended on Windows (dsh's tool subprocesses use `pwsh`; the launcher itself works with any shell)

## License

MIT
