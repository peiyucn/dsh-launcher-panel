import { randomUUID } from 'node:crypto'
import * as path from 'node:path'
import { DEFAULT_PORT, MAX_PORT } from '../shared/env.ts'

export const DEFAULT_PROFILE = 'web'

const DEFAULT_INSTANCE_NAME = 'Default'
const MAX_INSTANCE_NAME_LENGTH = 64
const MAX_PROFILE_LENGTH = 64
const LEGACY_INSTANCE_ID = 'default'
const PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const INSTANCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

// An instance is only a runtime coordinate (DSH home, profile, port); model and credentials belong to the profile.
export interface DshInstance {
  id: string
  name: string
  home: string
  profile: string
  port: number
  autoOpenBrowser?: boolean
  browser?: 'built-in' | 'external'
}

type InstanceIssueField =
  | 'entry'
  | 'id'
  | 'name'
  | 'home'
  | 'profile'
  | 'port'
  | 'autoOpenBrowser'
  | 'browser'

// Errors block an instance; warnings keep it usable but are shown in the panel.
type InstanceIssueSeverity = 'error' | 'warning'

export interface InstanceIssue {
  index: number
  field: InstanceIssueField
  severity: InstanceIssueSeverity
  message: string
}

export interface NormalizedInstances {
  instances: DshInstance[]
  activeId: string
  issues: InstanceIssue[]
}

export interface InstanceModelOptions {
  homeDir: string
  defaultHome: string
  forbiddenHomes?: readonly string[]
  platform?: NodeJS.Platform
}

export interface InstanceInput {
  name: string
  home: string
  profile: string
  port: number
  autoOpenBrowser?: boolean
  browser?: 'built-in' | 'external'
}

type ValidatedInstance = {
  instance?: DshInstance
  issues: InstanceIssue[]
}

type InitialInstances = NormalizedInstances & {
  synthesized: boolean
  stored: DshInstance[]
}

function pushIssue(
  index: number,
  field: InstanceIssueField,
  severity: InstanceIssueSeverity,
  message: string,
  issues: InstanceIssue[],
): undefined {
  issues.push({ index, field, severity, message })
  return undefined
}

function fail(index: number, field: InstanceIssueField, message: string, issues: InstanceIssue[]): undefined {
  return pushIssue(index, field, 'error', message, issues)
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

// Empty means the default home; relative paths are rejected because DSH resolves DSH_HOME against its own cwd.
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

// Windows compares paths case-insensitively.
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
  if (name === undefined) return fail(index, 'name', 'name is required', issues)
  if (name.length > MAX_INSTANCE_NAME_LENGTH) {
    return fail(index, 'name', `name must be at most ${MAX_INSTANCE_NAME_LENGTH} characters`, issues)
  }
  if (hasControlCharacters(name)) return fail(index, 'name', 'name must not contain control characters', issues)
  if (existing.some((instance) => instance.id !== editingId && instance.name.toLowerCase() === name.toLowerCase())) {
    return fail(index, 'name', `name "${name}" is already used by another instance`, issues)
  }
  return name
}

function validateProfile(index: number, raw: unknown, issues: InstanceIssue[]): string | undefined {
  const profile = nonEmptyString(raw) ?? DEFAULT_PROFILE
  if (profile.length > MAX_PROFILE_LENGTH || !PROFILE_PATTERN.test(profile)) {
    return fail(index, 'profile', 'profile must be a single path-safe name', issues)
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
    return fail(index, 'port', `port must be an integer between 1 and ${MAX_PORT}`, issues)
  }
  if (existing.some((instance) => instance.id !== editingId && instance.port === raw)) {
    return fail(index, 'port', `port ${raw} is already used by another instance`, issues)
  }
  return raw
}

function validateHome(
  index: number,
  raw: unknown,
  options: InstanceModelOptions,
  issues: InstanceIssue[],
): string | undefined {
  if (raw === undefined || raw === null) return fail(index, 'home', 'home is required', issues)
  if (typeof raw !== 'string') return fail(index, 'home', 'home must be a string', issues)
  const home = normalizeHome(raw, options)
  if (home === undefined) return fail(index, 'home', 'home must be an absolute path (or empty for the default)', issues)
  if (hasControlCharacters(home)) return fail(index, 'home', 'home must not contain control characters', issues)
  const forbidden = forbiddenBy(options, home)
  if (forbidden !== undefined) return fail(index, 'home', `home must not be inside ${forbidden}`, issues)
  return home
}

function validateOptionalBrowser(
  index: number,
  raw: unknown,
  issues: InstanceIssue[],
): 'built-in' | 'external' | undefined {
  if (raw === undefined) return undefined
  if (raw === 'built-in' || raw === 'external') return raw
  return pushIssue(index, 'browser', 'warning', 'browser must be "built-in" or "external"; using the global default', issues)
}

function validateOptionalAutoOpen(index: number, raw: unknown, issues: InstanceIssue[]): boolean | undefined {
  if (raw === undefined) return undefined
  if (typeof raw === 'boolean') return raw
  return pushIssue(index, 'autoOpenBrowser', 'warning', 'autoOpenBrowser must be a boolean; using the global default', issues)
}

function normalizeInstance(
  raw: unknown,
  index: number,
  options: InstanceModelOptions,
  seenIds: Set<string>,
  seenNames: Set<string>,
  issues: InstanceIssue[],
): DshInstance | undefined {
  if (!isRecord(raw)) return fail(index, 'entry', 'instance must be an object', issues)
  const id = nonEmptyString(raw.id)
  if (id === undefined || id.length > 80 || !INSTANCE_ID_PATTERN.test(id)) {
    return fail(index, 'id', 'id must be a path-safe, non-empty string', issues)
  }
  if (seenIds.has(id)) return fail(index, 'id', `id "${id}" is duplicated`, issues)

  const name = validateName(index, raw.name, [], undefined, issues)
  if (name === undefined) return undefined
  if (seenNames.has(name.toLowerCase())) return fail(index, 'name', `name "${name}" is duplicated`, issues)

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

// Invalid entries are skipped and reported; the settings value is never rewritten here.
export function normalizeInstances(
  raw: unknown,
  activeRaw: unknown,
  options: InstanceModelOptions,
): NormalizedInstances {
  const issues: InstanceIssue[] = []
  if (raw === undefined || raw === null) return { instances: [], activeId: '', issues }
  if (!Array.isArray(raw)) {
    fail(-1, 'entry', 'dsh.instances must be an array', issues)
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
      pushIssue(index, 'port', 'warning', `port ${instance.port} is also used by "${portOwner}"`, issues)
    } else {
      seenPorts.set(instance.port, instance.name)
    }
    const homeKey = (options.platform ?? process.platform) === 'win32' ? instance.home.toLowerCase() : instance.home
    const homeOwner = seenHomes.get(homeKey)
    if (homeOwner !== undefined) {
      pushIssue(index, 'home', 'warning', `home is shared with "${homeOwner}"; only one can run at a time`, issues)
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

export function migrateLegacyInstance(legacyPort: unknown): DshInstance {
  const port = typeof legacyPort === 'number' && Number.isInteger(legacyPort) && legacyPort >= 1 && legacyPort <= MAX_PORT
    ? legacyPort
    : DEFAULT_PORT
  return { id: LEGACY_INSTANCE_ID, name: DEFAULT_INSTANCE_NAME, home: '', profile: DEFAULT_PROFILE, port }
}

// A freshly installed extension may not be able to persist dsh.instances yet, so the synthesized
// Default must come from the read alone; the caller saves it best-effort.
export function resolveInitialInstances(
  raw: unknown,
  activeRaw: unknown,
  legacyPort: unknown,
  listAuthoritative: boolean,
  options: InstanceModelOptions,
): InitialInstances {
  const current = normalizeInstances(raw, activeRaw, options)
  if (current.instances.length > 0 || listAuthoritative) {
    return { ...current, synthesized: false, stored: current.instances }
  }
  const migrated = migrateLegacyInstance(legacyPort)
  const normalized = normalizeInstances([migrated], migrated.id, options)
  return {
    instances: normalized.instances,
    activeId: normalized.activeId,
    // Keep normalization errors so a broken settings value is reported, not silently replaced.
    issues: [...current.issues, ...normalized.issues],
    synthesized: normalized.instances.length > 0,
    stored: [migrated],
  }
}

export function nextPort(used: ReadonlySet<number>, start: number = DEFAULT_PORT): number | undefined {
  for (let port = Math.max(1, Math.trunc(start)); port <= MAX_PORT; port++) {
    if (!used.has(port)) return port
  }
  return undefined
}

export function instanceLogPath(baseDir: string, id: string): string {
  return path.join(baseDir, 'logs', 'instances', id, 'server.log')
}

// `editingId` keeps the instance being edited from colliding with itself.
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

  if (issues.some((entry) => entry.severity === 'error')
    || name === undefined || home === undefined || profile === undefined || port === undefined) {
    return { issues }
  }

  const duplicateHome = existing.find((instance) => instance.id !== editingId && sameHome(instanceHome(instance, options), home, options.platform))
  if (duplicateHome !== undefined) {
    pushIssue(0, 'home', 'warning', `home is shared with "${duplicateHome.name}"; only one can run at a time`, issues)
  }
  const nestedHome = existing.find((instance) => instance.id !== editingId && (
    isNestedHome(instanceHome(instance, options), home, options.platform)
    || isNestedHome(home, instanceHome(instance, options), options.platform)
  ))
  if (nestedHome !== undefined) {
    pushIssue(0, 'home', 'warning', `home overlaps with "${nestedHome.name}"; keep separate roots for independent instances`, issues)
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

export function instanceHome(instance: DshInstance, options: InstanceModelOptions): string {
  return instance.home === '' ? path.resolve(options.defaultHome) : path.resolve(instance.home)
}
