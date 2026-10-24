/**
 * Pure model for the launcher's multi-instance settings.
 *
 * An instance is a *runtime coordinate*: a DSH home directory, a profile inside
 * that home, and the port its Web UI listens on. It deliberately carries no
 * model, provider, preset, credential or workspace fields — those belong to the
 * DSH profile and are owned by the user.
 *
 * Everything here is free of VS Code APIs so `test/instances.test.ts` can run it
 * directly with Node's type stripping. Filesystem checks (home exists, profile
 * exists, port binds) live in the runtime layer; this module only validates what
 * can be decided from the value itself.
 *
 * @module instances
 */

import { randomUUID } from 'node:crypto'
import * as path from 'node:path'
import { DEFAULT_PORT, MAX_PORT } from './env.ts'

/** Profile used by a fresh instance and by the legacy migration. */
export const DEFAULT_PROFILE = 'web'

/** Name of the instance synthesized from the legacy `dsh.port`. */
export const DEFAULT_INSTANCE_NAME = 'Default'

/** Longest display name accepted from settings or the panel form. */
export const MAX_INSTANCE_NAME_LENGTH = 64

/** Longest profile name accepted; DSH profile directories are ordinary names. */
export const MAX_PROFILE_LENGTH = 64

/** Stable id of the instance synthesized from the legacy single-instance settings. */
export const LEGACY_INSTANCE_ID = 'default'

/** Profile names become directory names under `<home>/profiles`; keep them path-safe. */
export const PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** Instance ids are used in log paths; keep them path-safe even when hand-edited. */
export const INSTANCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** One instance as persisted in `dsh.instances`. */
export interface DshInstance {
  /** Stable id; generated once and never edited. */
  id: string
  /** Display name; unique case-insensitively. */
  name: string
  /** `DSH_HOME`; empty string means the launcher's default home. */
  home: string
  /** Profile under `<home>/profiles`; defaults to `web`. */
  profile: string
  /** Web UI port; unique across configured instances. */
  port: number
  /** Optional per-instance override for `dsh.autoOpenBrowser`. */
  autoOpenBrowser?: boolean
  /** Optional per-instance override for `dsh.browser`. */
  browser?: 'built-in' | 'external'
}

/** Field an issue belongs to; `entry` covers a malformed list item. */
export type InstanceIssueField =
  | 'entry'
  | 'id'
  | 'name'
  | 'home'
  | 'profile'
  | 'port'
  | 'autoOpenBrowser'
  | 'browser'

/** Errors block an instance; warnings keep it usable but are shown in the panel. */
export type InstanceIssueSeverity = 'error' | 'warning'

/** One validation issue; `index` is the position in `dsh.instances`. */
export interface InstanceIssue {
  index: number
  field: InstanceIssueField
  severity: InstanceIssueSeverity
  message: string
}

/** Result of normalizing the persisted settings value. */
export interface NormalizedInstances {
  instances: DshInstance[]
  /** Active id from settings, or '' when missing/unknown. */
  activeId: string
  issues: InstanceIssue[]
}

/** Inputs that depend on the machine, injected so the model stays testable. */
export interface InstanceModelOptions {
  /** The user's home directory; used to expand a leading `~`. */
  homeDir: string
  /** The default DSH home, normally `~/.dsh`. */
  defaultHome: string
  /** Paths that may never be used as an instance home (launcher base, install dir). */
  forbiddenHomes?: readonly string[]
  /** Platform for path comparison; defaults to the running platform. */
  platform?: NodeJS.Platform
}

/** Raw shape accepted by the panel form before normalization. */
export interface InstanceInput {
  name: string
  home: string
  profile: string
  port: number
  autoOpenBrowser?: boolean
  browser?: 'built-in' | 'external'
}

/** Result of validating one create/edit submission. */
export interface ValidatedInstance {
  instance?: DshInstance
  issues: InstanceIssue[]
}

function issue(
  index: number,
  field: InstanceIssueField,
  severity: InstanceIssueSeverity,
  message: string,
): InstanceIssue {
  return { index, field, severity, message }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

function hasControlCharacters(value: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(value)
}

/** Expand `~` and resolve an absolute home; undefined for relative/blank input. */
export function normalizeHome(raw: string, options: InstanceModelOptions): string | undefined {
  const trimmed = raw.trim()
  if (trimmed === '') return path.resolve(options.defaultHome)
  let expanded = trimmed
  if (trimmed === '~' || trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    expanded = path.join(options.homeDir, trimmed.slice(1))
  }
  if (!path.isAbsolute(expanded)) return undefined
  return path.resolve(expanded)
}

/** Whether two normalized homes point at the same directory. */
export function sameHome(
  left: string,
  right: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (left === '' || right === '') return left === right
  const a = path.resolve(left)
  const b = path.resolve(right)
  return platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

/** Whether `child` is inside `parent` (not equal). */
export function isNestedHome(
  parent: string,
  child: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (parent === '' || child === '') return false
  const relative = path.relative(path.resolve(parent), path.resolve(child))
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return false
  return platform === 'win32' ? true : !relative.startsWith(`..${path.sep}`)
}

function forbiddenBy(options: InstanceModelOptions, home: string): string | undefined {
  for (const root of options.forbiddenHomes ?? []) {
    const normalized = path.resolve(root)
    if (sameHome(normalized, home, options.platform) || isNestedHome(normalized, home, options.platform)) {
      return normalized
    }
  }
  return undefined
}

function validateName(
  index: number,
  raw: unknown,
  existing: readonly DshInstance[],
  editingId: string | undefined,
  issues: InstanceIssue[],
): string | undefined {
  const name = nonEmptyString(raw)
  if (name === undefined) {
    issues.push(issue(index, 'name', 'error', 'name is required'))
    return undefined
  }
  if (name.length > MAX_INSTANCE_NAME_LENGTH) {
    issues.push(issue(index, 'name', 'error', `name must be at most ${MAX_INSTANCE_NAME_LENGTH} characters`))
    return undefined
  }
  if (hasControlCharacters(name)) {
    issues.push(issue(index, 'name', 'error', 'name must not contain control characters'))
    return undefined
  }
  const duplicate = existing.some((instance) => instance.id !== editingId && instance.name.toLowerCase() === name.toLowerCase())
  if (duplicate) {
    issues.push(issue(index, 'name', 'error', `name "${name}" is already used by another instance`))
    return undefined
  }
  return name
}

function validateProfile(index: number, raw: unknown, issues: InstanceIssue[]): string | undefined {
  const profile = nonEmptyString(raw) ?? DEFAULT_PROFILE
  if (profile.length > MAX_PROFILE_LENGTH || !PROFILE_PATTERN.test(profile)) {
    issues.push(issue(index, 'profile', 'error', 'profile must be a single path-safe name'))
    return undefined
  }
  return profile
}

function validatePort(
  index: number,
  raw: unknown,
  existing: readonly DshInstance[],
  editingId: string | undefined,
  issues: InstanceIssue[],
): number | undefined {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > MAX_PORT) {
    issues.push(issue(index, 'port', 'error', `port must be an integer between 1 and ${MAX_PORT}`))
    return undefined
  }
  if (existing.some((instance) => instance.id !== editingId && instance.port === raw)) {
    issues.push(issue(index, 'port', 'error', `port ${raw} is already used by another instance`))
    return undefined
  }
  return raw
}

function validateHome(
  index: number,
  raw: unknown,
  options: InstanceModelOptions,
  issues: InstanceIssue[],
): string | undefined {
  if (raw === undefined || raw === null) {
    issues.push(issue(index, 'home', 'error', 'home is required'))
    return undefined
  }
  if (typeof raw !== 'string') {
    issues.push(issue(index, 'home', 'error', 'home must be a string'))
    return undefined
  }
  const home = normalizeHome(raw, options)
  if (home === undefined) {
    issues.push(issue(index, 'home', 'error', 'home must be an absolute path (or empty for the default)'))
    return undefined
  }
  if (hasControlCharacters(home)) {
    issues.push(issue(index, 'home', 'error', 'home must not contain control characters'))
    return undefined
  }
  const forbidden = forbiddenBy(options, home)
  if (forbidden !== undefined) {
    issues.push(issue(index, 'home', 'error', `home must not be inside ${forbidden}`))
    return undefined
  }
  return home
}

function validateOptionalBrowser(
  index: number,
  raw: unknown,
  issues: InstanceIssue[],
): 'built-in' | 'external' | undefined {
  if (raw === undefined) return undefined
  if (raw === 'built-in' || raw === 'external') return raw
  issues.push(issue(index, 'browser', 'warning', 'browser must be "built-in" or "external"; using the global default'))
  return undefined
}

function validateOptionalAutoOpen(
  index: number,
  raw: unknown,
  issues: InstanceIssue[],
): boolean | undefined {
  if (raw === undefined) return undefined
  if (typeof raw === 'boolean') return raw
  issues.push(issue(index, 'autoOpenBrowser', 'warning', 'autoOpenBrowser must be a boolean; using the global default'))
  return undefined
}

function normalizeInstance(
  raw: unknown,
  index: number,
  options: InstanceModelOptions,
  seenIds: Set<string>,
  seenNames: Set<string>,
  issues: InstanceIssue[],
): DshInstance | undefined {
  if (!isRecord(raw)) {
    issues.push(issue(index, 'entry', 'error', 'instance must be an object'))
    return undefined
  }

  const id = nonEmptyString(raw.id)
  if (id === undefined || id.length > 80 || !INSTANCE_ID_PATTERN.test(id)) {
    issues.push(issue(index, 'id', 'error', 'id must be a path-safe, non-empty string'))
    return undefined
  }
  if (seenIds.has(id)) {
    issues.push(issue(index, 'id', 'error', `id "${id}" is duplicated`))
    return undefined
  }

  const name = validateName(index, raw.name, [], undefined, issues)
  if (name === undefined) return undefined
  if (seenNames.has(name.toLowerCase())) {
    issues.push(issue(index, 'name', 'error', `name "${name}" is duplicated`))
    return undefined
  }

  const home = validateHome(index, raw.home, options, issues)
  if (home === undefined) return undefined

  const profile = validateProfile(index, raw.profile, issues)
  if (profile === undefined) return undefined

  const port = validatePort(index, raw.port, [], undefined, issues)
  if (port === undefined) return undefined

  const autoOpenBrowser = validateOptionalAutoOpen(index, raw.autoOpenBrowser, issues)
  const browser = validateOptionalBrowser(index, raw.browser, issues)

  seenIds.add(id)
  seenNames.add(name.toLowerCase())
  return {
    id,
    name,
    home,
    profile,
    port,
    ...autoOpenBrowser === undefined ? {} : { autoOpenBrowser },
    ...browser === undefined ? {} : { browser },
  }
}

/**
 * Normalize the persisted `dsh.instances` value.
 *
 * Invalid entries are skipped and reported in `issues`; the settings value is
 * never rewritten here. Duplicate ports and shared homes are warnings, because
 * the runtime refuses the unsafe combination at start time rather than making
 * the settings unreadable.
 */
export function normalizeInstances(
  raw: unknown,
  activeRaw: unknown,
  options: InstanceModelOptions,
): NormalizedInstances {
  const issues: InstanceIssue[] = []
  if (raw === undefined || raw === null) {
    return { instances: [], activeId: '', issues }
  }
  if (!Array.isArray(raw)) {
    issues.push(issue(-1, 'entry', 'error', 'dsh.instances must be an array'))
    return { instances: [], activeId: '', issues }
  }

  const instances: DshInstance[] = []
  const seenIds = new Set<string>()
  const seenNames = new Set<string>()
  const seenPorts = new Map<number, string>()
  const seenHomes = new Map<string, string>()

  raw.forEach((entry, index) => {
    const instance = normalizeInstance(entry, index, options, seenIds, seenNames, issues)
    if (instance === undefined) return

    const portOwner = seenPorts.get(instance.port)
    if (portOwner !== undefined) {
      issues.push(issue(index, 'port', 'warning', `port ${instance.port} is also used by "${portOwner}"`))
    } else {
      seenPorts.set(instance.port, instance.name)
    }

    const homeKey = (options.platform ?? process.platform) === 'win32' ? instance.home.toLowerCase() : instance.home
    const homeOwner = seenHomes.get(homeKey)
    if (homeOwner !== undefined) {
      issues.push(issue(index, 'home', 'warning', `home is shared with "${homeOwner}"; only one can run at a time`))
    } else {
      seenHomes.set(homeKey, instance.name)
    }

    instances.push(instance)
  })

  const activeId = typeof activeRaw === 'string' && instances.some((instance) => instance.id === activeRaw)
    ? activeRaw
    : ''

  return { instances, activeId, issues }
}

/** Build the instance synthesized from the legacy single-instance settings. */
export function migrateLegacyInstance(legacyPort: unknown): DshInstance {
  const port = typeof legacyPort === 'number' && Number.isInteger(legacyPort) && legacyPort >= 1 && legacyPort <= MAX_PORT
    ? legacyPort
    : DEFAULT_PORT
  return {
    id: LEGACY_INSTANCE_ID,
    name: DEFAULT_INSTANCE_NAME,
    home: '',
    profile: DEFAULT_PROFILE,
    port,
  }
}

/** First port at or above `start` not present in `used`; undefined when exhausted. */
export function nextPort(used: ReadonlySet<number>, start: number = DEFAULT_PORT): number | undefined {
  for (let port = Math.max(1, Math.trunc(start)); port <= MAX_PORT; port++) {
    if (!used.has(port)) return port
  }
  return undefined
}

/** The per-instance server log path under the launcher base directory. */
export function instanceLogPath(baseDir: string, id: string): string {
  return path.join(baseDir, 'logs', 'instances', id, 'server.log')
}

/**
 * Validate one create/edit submission against the current instances.
 *
 * `editingId` is omitted for a create and supplied for an edit so the instance
 * being edited does not collide with itself. Errors suppress the returned
 * instance; warnings still return it.
 */
export function validateInstance(
  input: InstanceInput,
  options: InstanceModelOptions,
  existing: readonly DshInstance[],
  editingId?: string,
  idFactory: () => string = randomUUID,
): ValidatedInstance {
  const issues: InstanceIssue[] = []
  const name = validateName(0, input.name, existing, editingId, issues)
  const home = validateHome(0, input.home, options, issues)
  const profile = validateProfile(0, input.profile, issues)
  const port = validatePort(0, input.port, existing, editingId, issues)
  const autoOpenBrowser = validateOptionalAutoOpen(0, input.autoOpenBrowser, issues)
  const browser = validateOptionalBrowser(0, input.browser, issues)

  if (issues.some((entry) => entry.severity === 'error') || name === undefined || home === undefined || profile === undefined || port === undefined) {
    return { issues }
  }

  const duplicateHome = existing.find((instance) => instance.id !== editingId && sameHome(instanceHome(instance, options), home, options.platform))
  if (duplicateHome !== undefined) {
    issues.push(issue(0, 'home', 'warning', `home is shared with "${duplicateHome.name}"; only one can run at a time`))
  }
  const nestedHome = existing.find((instance) => instance.id !== editingId && (
    isNestedHome(instanceHome(instance, options), home, options.platform)
    || isNestedHome(home, instanceHome(instance, options), options.platform)
  ))
  if (nestedHome !== undefined) {
    issues.push(issue(0, 'home', 'warning', `home overlaps with "${nestedHome.name}"; keep separate roots for independent instances`))
  }

  return {
    instance: {
      id: editingId ?? idFactory(),
      name,
      home,
      profile,
      port,
      ...autoOpenBrowser === undefined ? {} : { autoOpenBrowser },
      ...browser === undefined ? {} : { browser },
    },
    issues,
  }
}

/** Resolve the effective home for a normalized instance. */
export function instanceHome(instance: DshInstance, options: InstanceModelOptions): string {
  return instance.home === '' ? path.resolve(options.defaultHome) : path.resolve(instance.home)
}
