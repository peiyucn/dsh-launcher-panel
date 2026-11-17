import { isObservedInstance, type DshInstance } from './model.ts'

export interface TakeoverFacts {
  command?: string
}

export function buildTakeoverInfo(instance: DshInstance, facts: TakeoverFacts = {}): string {
  const observed = isObservedInstance(instance)
  const lines = [
    '# DSH Launcher takeover brief',
    '',
    `- Instance: ${instance.name}`,
    `- DSH_HOME: ${instance.home === '' ? '(unknown — ask the user)' : instance.home}`,
    `- Profile: ${instance.profile}`,
    `- Port: ${instance.port}`,
  ]
  if (facts.command !== undefined && facts.command.trim() !== '') {
    lines.push(`- Detected command: \`${facts.command.trim()}\``)
  }
  lines.push(
    ...(observed
      ? ['- Mode: observed (read-only) — the launcher never starts, stops or updates this process.']
      : []),
    '',
    '## Goal',
    '',
    'Turn this dsh into a launcher-managed instance without moving or copying its data.',
    '',
    '## Steps',
    '',
    '1. Ask the user to stop and disable the external manager (systemd/docker/manual) first; do not kill or restart it yourself.',
    '2. Make the same dsh version available in a launcher-managed install (pkg or source layout), and point the launcher at that install.',
    '3. Keep DSH_HOME, profile and port unchanged. Do not copy or move sessions, credentials or profile data.',
    '4. Remove this observed entry and create a normal launcher instance with the same home/profile/port (or convert it after the user confirms).',
    '5. Verify: Start/attach, Open Web UI, then Stop and Start again.',
    '',
    '## Constraints',
    '',
    '- Never print, copy or persist launch tokens.',
    '- Ask the user before any irreversible change (installing, deleting, changing ports or home paths).',
    '- Do not modify external manager configuration unless the user asks.',
  )
  return lines.join('\n') + '\n'
}
