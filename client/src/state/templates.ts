// Starter templates (docs/templates.md): "Save this server as a template" (the server builds it, without members,
// messages or secrets) and the checks the setup wizard's preview needs.
import { native } from '../platform/native'
import { connectionFor } from './store'
import { t } from '../i18n'
import type { TemplateChannelInfo } from '../platform/desktop'

/** A file name from the server's name: "Book club" → "book-club.iskra-template.json". */
export function templateFileName(serverName: string): string {
  const slug = serverName.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
  return `${slug || 'server'}.iskra-template.json`
}

/** The server's setup as template JSON, pretty-printed. */
export async function exportTemplate(serverKey: string): Promise<string> {
  const c = connectionFor(serverKey)
  if (!c) throw new Error(t('errors.codes.disconnected'))
  const { template } = await c.request('server.template.export', {})
  return JSON.stringify(template, null, 2) + '\n'
}

/** Desktop: the save dialog; browsers: a download; the phone app: the share sheet. */
export async function saveTemplateFile(json: string, name: string): Promise<void> {
  const file = new File([json], name, { type: 'application/json' })
  if (native) {
    await native.saveFile(file, file.name)
    return
  }
  const url = URL.createObjectURL(file)
  const link = document.createElement('a')
  link.href = url
  link.download = file.name
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
}

const ROLE_NAMES = ['owner', 'admin', 'trusted', 'member', 'guest']
const roleName = (role: string) => (ROLE_NAMES.includes(role) ? t(`roles.base.names.${role as 'owner'}`) : role)

/** The notes the preview shows under a channel: who can see and post (when not everyone), hi-fi, slowmode, role overrides, tags. */
export function channelNotes(c: TemplateChannelInfo): string[] {
  const notes: string[] = []
  const read = c.readRole ?? 'member'
  const write = c.writeRole ?? read
  if (read !== 'member') notes.push(t('templates.preview.whoRead', { role: roleName(read) }))
  if (write !== read) notes.push(t('templates.preview.whoWrite', { role: roleName(write) }))
  if (c.userLimit > 0) notes.push(t('hosting.wizard.upTo', { count: c.userLimit }))
  if (c.hifi) notes.push(t('templates.preview.hifi'))
  if (c.slowmode) notes.push(t('templates.preview.slowmode', { seconds: c.slowmode }))
  const perm = (p: string) => t(`templates.preview.perms.${p as 'view'}`)
  for (const o of c.overrides ?? []) {
    const changes = [
      ...(o.allow.length > 0 ? [t('templates.preview.allow', { what: o.allow.map(perm).join(', ') })] : []),
      ...(o.deny.length > 0 ? [t('templates.preview.deny', { what: o.deny.map(perm).join(', ') })] : []),
    ]
    notes.push(t('templates.preview.override', { role: o.role, changes: changes.join('; ') }))
  }
  if (c.tags && c.tags.length > 0) notes.push(t('templates.preview.tags', { tags: c.tags.join(', ') }))
  return notes
}
