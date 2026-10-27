/**
 * Launcher-managed DSH Web branding.
 *
 * The launcher cannot reach into the Web UI from the outside: the page is a
 * separate browser surface and its brand is rendered by the Web client. This
 * module therefore writes a tiny, fixed-purpose client bundle into the
 * instance's profile. DSH loads it as an ordinary profile bundle; the bundle
 * only appends the instance name under the official wordmark in the sidebar
 * logo row, leaving the official mark and wordmark untouched.
 *
 * The line is a DOM overlay rather than a `sidebar.brand.name` occupant: the
 * shell's brand slot is a fixed 24px row whose overflow rules clip a second
 * line. The overlay lives in the 60px logo row, follows locale changes and is
 * re-attached if the sidebar re-renders.
 *
 * Everything here is local to one profile. No npm install, no plugin market and
 * no global dsh modification are involved.
 *
 * @module server/instance-brand
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { dbg } from './activity.ts'

export const INSTANCE_BRAND_PACKAGE = '@dsh-launcher/instance-brand'
const INSTANCE_BRAND_ID = 'launcher-instance-brand'

/** Prefix DSH gives a profile manifest's `name` (`dsh-profile-<profile>`). */
const DSH_PROFILE_NAME_PREFIX = 'dsh-profile-'

/** Skip reasons already written to the debug log (one line per distinct reason). */
const loggedSkipReasons = new Set<string>()

/**
 * Record why branding was skipped, once per distinct reason.
 *
 * Nothing here is allowed to throw into the start flow, and the generated
 * client depends on dsh's internal DOM contract, so a refusal/failure must be
 * diagnosable from client.log without spamming it on every Start (this runs
 * before each one).
 */
function reportSkip(reason: string): void {
  if (loggedSkipReasons.has(reason)) return
  loggedSkipReasons.add(reason)
  dbg(`instance brand skipped: ${reason}`)
}

/** Directory of the generated bundle inside one profile. */
export function instanceBrandDir(home: string, profile: string): string {
  return path.join(home, 'profiles', profile, 'node_modules', ...INSTANCE_BRAND_PACKAGE.split('/'))
}

/** The profile manifest the bundle is appended to. */
function profileManifestPath(home: string, profile: string): string {
  return path.join(home, 'profiles', profile, 'package.json')
}

/** Read a JSON object; undefined when the file is absent, malformed or not an object. */
function readJsonObject(file: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * Whether a manifest identifies a DSH profile rather than some other
 * `package.json` at the same path. Both markers are accepted because the name
 * convention and the `dsh.profile` block are the two things DSH itself writes.
 */
function isDshProfileManifest(manifest: Record<string, unknown>): boolean {
  const name = manifest.name
  if (typeof name === 'string' && name.startsWith(DSH_PROFILE_NAME_PREFIX)) return true
  const dsh = manifest.dsh
  return isRecord(dsh) && isRecord(dsh.profile)
}

/** Whether the bundle directory is one this extension generated (safe to rewrite/delete). */
function isOwnedBundleDir(dir: string): boolean {
  const manifest = readJsonObject(path.join(dir, 'package.json'))
  return manifest !== undefined && manifest.name === INSTANCE_BRAND_PACKAGE
}

/**
 * Generate/update the bundle and make sure the profile loads it.
 * Safe to call before every Start; the generated files are deterministic.
 *
 * Refuses to touch a profile manifest or bundle directory it does not own, and
 * never throws: branding is a cosmetic overlay and must not break Start.
 */
export function ensureInstanceBrand(home: string, profile: string, name: string): boolean {
  const manifestFile = profileManifestPath(home, profile)
  if (!fs.existsSync(manifestFile)) return false
  const manifest = readJsonObject(manifestFile)
  if (manifest === undefined || !isDshProfileManifest(manifest)) {
    reportSkip(`refusing to edit non-DSH profile manifest ${manifestFile}`)
    return false
  }
  const dir = instanceBrandDir(home, profile)
  if (fs.existsSync(dir) && !isOwnedBundleDir(dir)) {
    reportSkip(`refusing to overwrite foreign package at ${dir}`)
    return false
  }
  try {
    writeBundle(dir, name || 'instance')
    updateProfileBundles(manifestFile, true)
    return true
  } catch (error) {
    reportSkip(`write failed: ${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}

/** Remove the generated bundle and its profile bundle entry. */
export function removeInstanceBrand(home: string, profile: string): void {
  const dir = instanceBrandDir(home, profile)
  const manifestFile = profileManifestPath(home, profile)
  try {
    if (fs.existsSync(manifestFile)) {
      const manifest = readJsonObject(manifestFile)
      if (manifest === undefined || !isDshProfileManifest(manifest)) {
        reportSkip(`refusing to edit non-DSH profile manifest ${manifestFile}`)
        return
      }
      updateProfileBundles(manifestFile, false)
    }
    if (!fs.existsSync(dir)) return
    if (!isOwnedBundleDir(dir)) {
      reportSkip(`refusing to remove foreign package at ${dir}`)
      return
    }
    fs.rmSync(dir, { recursive: true, force: true })
  } catch (error) {
    reportSkip(`remove failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

let tempFileSeq = 0

/**
 * Write a file atomically: full content to a sibling temp file, then rename it
 * over the destination. A crash mid-write therefore leaves the previous version
 * intact instead of a truncated profile manifest (which would stop the profile
 * from loading); the destination is never observed half-written.
 */
function writeFileAtomic(file: string, content: string): void {
  const temp = `${file}.${process.pid}.${++tempFileSeq}.tmp`
  fs.writeFileSync(temp, content, 'utf8')
  try {
    fs.renameSync(temp, file)
  } catch (error) {
    try {
      fs.rmSync(temp, { force: true })
    } catch {
      // leave cleanup to the next write
    }
    throw error
  }
}

function writeBundle(dir: string, name: string): void {
  const lib = path.join(dir, 'lib')
  fs.mkdirSync(lib, { recursive: true })
  writeFileAtomic(path.join(dir, 'package.json'), `${JSON.stringify(bundleManifest(), null, 2)}\n`)
  writeFileAtomic(path.join(dir, 'cordis.patch.yml'), bundlePatch())
  writeFileAtomic(path.join(lib, 'index.js'), 'export function apply() {}\n')
  writeFileAtomic(path.join(lib, 'client.js'), clientSource(name))
}

function bundleManifest(): Record<string, unknown> {
  return {
    name: INSTANCE_BRAND_PACKAGE,
    version: '0.0.0',
    private: true,
    type: 'module',
    main: 'lib/index.js',
    exports: {
      '.': './lib/index.js',
      './client': './lib/client.js',
      './package.json': './package.json',
    },
    dsh: {
      bundle: { patch: './cordis.patch.yml' },
      client: {
        platform: 'web',
        inject: [
          '@deepseek-ai/dsh-client-ui-renderer',
          '@deepseek-ai/dsh-client-ui-sidebar',
          '@deepseek-ai/dsh-client-locale',
        ],
      },
    },
  }
}

function bundlePatch(): string {
  return [
    '# Generated by the DSH Launcher Panel. Do not edit; it is rewritten on Start.',
    '- insert:',
    `    - id: ${INSTANCE_BRAND_ID}`,
    `      name: '${INSTANCE_BRAND_PACKAGE}'`,
    '',
  ].join('\n')
}

/**
 * Add/remove our package in `dsh.profile.bundles` without touching the rest of
 * the user's profile manifest.
 *
 * Re-checks ownership here (not only in the callers) because this is the write
 * that can damage a user's profile; the manifest is also rewritten atomically.
 */
function updateProfileBundles(manifestFile: string, enabled: boolean): void {
  const raw = fs.readFileSync(manifestFile, 'utf8')
  const manifest = JSON.parse(raw) as Record<string, unknown>
  if (!isRecord(manifest) || !isDshProfileManifest(manifest)) {
    reportSkip(`refusing to edit non-DSH profile manifest ${manifestFile}`)
    return
  }
  const dsh = isRecord(manifest.dsh) ? manifest.dsh : {}
  const profile = isRecord(dsh.profile) ? dsh.profile : {}
  const current = Array.isArray(profile.bundles) ? profile.bundles.filter((item): item is string => typeof item === 'string') : []
  const without = current.filter((item) => item !== INSTANCE_BRAND_PACKAGE)
  const next = enabled ? [...without, INSTANCE_BRAND_PACKAGE] : without
  if (sameList(current, next)) return
  dsh.profile = { ...profile, bundles: next }
  manifest.dsh = dsh
  writeFileAtomic(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

/**
 * The generated client half. The sidebar's brand slot is a fixed 24px row
 * owned by the official wordmark, so a second line inside that slot is clipped
 * by the shell's overflow rules. Instead this client half keeps the official
 * brand subtree untouched and appends one absolutely-positioned line to the
 * logo row, under the official wordmark. Locale changes update the label in
 * place; a MutationObserver re-adds the line if the sidebar re-renders.
 */
function clientSource(name: string): string {
  const instanceName = JSON.stringify(name)
  const css = JSON.stringify([
    '[class*="_logoRow"]{position:relative!important;overflow:visible!important}',
    '[class*="_logoRow"]:has(.launcher-instance-line){height:68px!important}',
    '.launcher-instance-line{position:absolute;left:36px;right:36px;bottom:4px;display:flex;align-items:baseline;gap:4px;overflow:hidden;white-space:nowrap;font-size:10px;line-height:14px;letter-spacing:.02em;color:var(--dsw-alias-label-secondary);pointer-events:none;font-family:inherit}',
    '.launcher-instance-line-label{flex:none;font-size:9px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;opacity:.72}',
    '.launcher-instance-line-name{color:var(--dsw-alias-label-primary);font-size:10.5px;font-weight:600;letter-spacing:0;overflow:hidden;text-overflow:ellipsis}',
  ].join(''))
  return `window.__ModuleLoader__.load({
  id: ${JSON.stringify(INSTANCE_BRAND_PACKAGE)},
  factory: (require) => {
    var module = { exports: {} }
    Object.defineProperty(module.exports, Symbol.toStringTag, { value: "Module" })
    var INSTANCE_NAME = ${instanceName}
    var CSS = ${css}
    var LINE_CLASS = "launcher-instance-line"
    var inject = []
    function localeOf(ctx) {
      try {
        var snapshot = ctx.locale.getLocale()
        if (snapshot && snapshot.active) return String(snapshot.active)
      } catch (e) {}
      try {
        var html = document.documentElement
        if (html && html.lang) return String(html.lang)
      } catch (e) {}
      try { return String(navigator.language || "en") } catch (e) { return "en" }
    }
    function labelFor(locale) {
      return String(locale || "").toLowerCase().indexOf("zh") === 0 ? "运行实例：" : "Instance:"
    }
    function apply(ctx) {
      try {
        var old = document.querySelector('style[data-dsh-instance-brand]')
        if (old) old.remove()
        var style = document.createElement("style")
        style.setAttribute("data-dsh-instance-brand", "")
        style.textContent = CSS
        document.head.appendChild(style)

        var lineEl = null
        var labelEl = null
        var frame = 0
        function removeLine() {
          if (lineEl && lineEl.parentNode) lineEl.parentNode.removeChild(lineEl)
          lineEl = null
          labelEl = null
        }
        function ensure() {
          var row = document.querySelector('[class*="_logoRow"]')
          var identity = row && row.querySelector('[class*="_brandIdentity"]')
          if (!row || !identity) { removeLine(); return }
          var existing = row.querySelector("." + LINE_CLASS)
          if (existing) {
            lineEl = existing
            labelEl = existing.querySelector("." + LINE_CLASS + "-label")
            return
          }
          var line = document.createElement("span")
          line.className = LINE_CLASS
          line.title = INSTANCE_NAME
          labelEl = document.createElement("span")
          labelEl.className = LINE_CLASS + "-label"
          labelEl.textContent = labelFor(localeOf(ctx))
          var nameEl = document.createElement("span")
          nameEl.className = LINE_CLASS + "-name"
          nameEl.textContent = INSTANCE_NAME
          line.appendChild(labelEl)
          line.appendChild(nameEl)
          row.appendChild(line)
          lineEl = line
        }
        function schedule() {
          if (frame) return
          frame = requestAnimationFrame(function () {
            frame = 0
            ensure()
          })
        }
        function syncLabel() {
          if (labelEl) labelEl.textContent = labelFor(localeOf(ctx))
        }
        var off = null
        if (typeof ctx.on === "function") {
          try { off = ctx.on("locale/change", syncLabel) } catch (e) {}
        }
        var observer = new MutationObserver(schedule)
        observer.observe(document.body, { childList: true, subtree: true })
        schedule()
        if (typeof ctx.effect === "function") {
          ctx.effect(function () {
            return function () {
              observer.disconnect()
              if (frame) cancelAnimationFrame(frame)
              if (typeof off === "function") off()
              style.remove()
              removeLine()
            }
          })
        }
      } catch (error) {
        console.warn("[dsh-instance-brand] inactive", error)
      }
    }
    module.exports.apply = apply
    module.exports.inject = inject
    return module.exports
  }
})
`
}
