// Server settings → Bots: the settings of Tags (who manages them, and the tags themselves), Suggestions (channel, staff,
// anonymous), Giveaways (staff) and Counting (channel, sums). Admins only; saved with one button, only what changed.
import { useEffect, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { Bots3Configs, Bots3Id, CountingConfig, SuggestionsConfig, Tag, TagsConfig } from '../../core/protocol'
import { errorMessage } from '../../i18n/errors'
import { getBots3Config, listTags, postSuggestPrompt, removeTag, saveTag, setBots3Config } from '../../state/bots3'
import { bots3Patch, filterTags, MAX_TAG_TEXT, MAX_TAGS, staffRoles, tagName, tagProblem } from '../../state/bots3Logic'
import { useServerRoles } from '../../state/roles'
import type { ServerState } from '../../state/store'
import '../moreBots.css'
import '../bots3.css'

type AnyConfig = Bots3Configs[Bots3Id]
type Fields = Partial<TagsConfig & SuggestionsConfig & CountingConfig>

export function Bots3Settings({ server, bot }: { server: ServerState; bot: Bots3Id }) {
  const { t } = useTranslation()
  const [saved, setSaved] = useState<AnyConfig | null>(null)
  const [draft, setDraft] = useState<AnyConfig | null>(null)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<{ kind: 'saved' | 'error'; text: string } | null>(null)

  useEffect(() => {
    let live = true
    getBots3Config(server.key, bot).then((config) => {
      if (!live) return
      setSaved(config)
      setDraft(config)
    }, (e) => live && setStatus({ kind: 'error', text: errorMessage(e) }))
    return () => { live = false }
  }, [server.key, bot])

  const roles = staffRoles(useServerRoles(server.key))
  const textChannels = server.channels.filter((c) => c.kind === 'text' && !c.e2ee).sort((a, b) => a.position - b.position)
  if (!draft || !saved) return <p className="muted">{status?.text ?? t('moreBots.settings.loading')}</p>

  const patch = bots3Patch(saved, draft)
  const changed = Object.keys(patch).length > 0
  const d = draft as Fields
  const update = (more: Fields) => {
    setDraft({ ...draft, ...more } as AnyConfig)
    setStatus(null)
  }

  async function save(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setStatus(null)
    try {
      const config = await setBots3Config(server.key, bot, patch)
      setSaved(config)
      setDraft(config)
      setStatus({ kind: 'saved', text: t('moreBots.settings.saved') })
    } catch (err) {
      setStatus({ kind: 'error', text: errorMessage(err) })
    } finally {
      setBusy(false)
    }
  }

  const roleField = (field: 'managerRoleId' | 'staffRoleId', label: string, hint: string) => (
    <>
      <label className="field">
        <span>{label}</span>
        <select value={d[field] ?? ''} disabled={busy} onChange={(e) => update({ [field]: e.target.value ? Number(e.target.value) : null })}>
          <option value="">{t('bots3.settings.adminsOnly')}</option>
          {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
      </label>
      <p className="muted small">{hint}</p>
    </>
  )
  const channelField = (hint: string) => (
    <>
      <label className="field">
        <span>{t('bots3.settings.channel')}</span>
        <select value={d.channelId ?? ''} disabled={busy} onChange={(e) => update({ channelId: e.target.value ? Number(e.target.value) : null })}>
          <option value="">{t('bots3.settings.channelNone')}</option>
          {textChannels.map((c) => <option key={c.id} value={c.id}>#{c.name}</option>)}
        </select>
      </label>
      <p className="muted small">{hint}</p>
    </>
  )

  return (
    <div className="more-bot-settings bots3-settings" data-testid={`builtin-${bot}-settings`}>
      <form onSubmit={(e) => void save(e)} className="bots3-settings-form">
        {bot === 'tags' && roleField('managerRoleId', t('bots3.tags.managers'), t('bots3.tags.managersHint'))}
        {bot === 'suggestions' && (
          <>
            {channelField(t('bots3.suggestions.channelHint'))}
            {roleField('staffRoleId', t('bots3.settings.staffRole'), t('bots3.suggestions.staffHint'))}
            <label className="checkbox">
              <input type="checkbox" checked={!!d.anonymous} disabled={busy} onChange={(e) => update({ anonymous: e.target.checked })} />
              <span>{t('bots3.suggestions.anonymous')}</span>
            </label>
            <p className="muted small">{t('bots3.suggestions.anonymousHint')}</p>
          </>
        )}
        {bot === 'giveaways' && (
          <>
            {roleField('staffRoleId', t('bots3.settings.staffRole'), t('bots3.giveaways.staffHint'))}
            <p className="muted small">{t('bots3.giveaways.hint')}</p>
          </>
        )}
        {bot === 'counting' && (
          <>
            {channelField(t('bots3.counting.channelHint'))}
            <label className="checkbox">
              <input type="checkbox" checked={!!d.math} disabled={busy} onChange={(e) => update({ math: e.target.checked })} />
              <span>{t('bots3.counting.math')}</span>
            </label>
            <p className="muted small">{t('bots3.counting.mathHint')}</p>
            <p className="muted small" data-testid="counting-stats">{t('bots3.counting.stats', { current: d.current ?? 0, best: d.best ?? 0 })}</p>
          </>
        )}
        <div className="more-bot-actions">
          <button type="submit" className="button primary small" disabled={busy || !changed}>{t('moreBots.settings.save')}</button>
          {bot === 'suggestions' && <PromptButton server={server} disabled={busy || changed || !d.channelId} />}
          {status && <span className={status.kind === 'error' ? 'error-text' : 'muted'} role="status">{status.text}</span>}
        </div>
      </form>
      {bot === 'tags' && <TagsEditor server={server} />}
    </div>
  )
}

function PromptButton({ server, disabled }: { server: ServerState; disabled: boolean }) {
  const { t } = useTranslation()
  const [state, setState] = useState<string | null>(null)
  return (
    <>
      <button type="button" className="button small" disabled={disabled} onClick={() => {
        setState(null)
        postSuggestPrompt(server.key).then(() => setState(t('bots3.suggestions.prompted')), (e) => setState(errorMessage(e)))
      }}>{t('bots3.suggestions.prompt')}</button>
      {state && <span className="muted small" role="status">{state}</span>}
    </>
  )
}

/** The tags: find, add, edit and remove (managers; admins always). */
function TagsEditor({ server }: { server: ServerState }) {
  const { t } = useTranslation()
  const [tags, setTags] = useState<Tag[] | null>(null)
  const [max, setMax] = useState(MAX_TAGS)
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null)

  const load = () => listTags(server.key).then((r) => { setTags(r.tags); setMax(r.max) }, (e) => setStatus({ ok: false, text: errorMessage(e) }))
  useEffect(() => { void load() }, [server.key]) // eslint-disable-line react-hooks/exhaustive-deps

  const problem = name || text ? tagProblem(name, text) : null
  const reset = () => { setEditing(null); setName(''); setText('') }

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (problem) return
    setBusy(true)
    setStatus(null)
    try {
      await saveTag(server.key, tagName(name), text)
      reset()
      setStatus({ ok: true, text: t('bots3.tags.saved') })
      await load()
    } catch (err) {
      setStatus({ ok: false, text: errorMessage(err) })
    } finally {
      setBusy(false)
    }
  }

  async function remove(tag: Tag) {
    if (!window.confirm(t('bots3.tags.removeConfirm', { name: tag.name }))) return
    setBusy(true)
    setStatus(null)
    try {
      await removeTag(server.key, tag.name)
      if (editing === tag.name) reset()
      setStatus({ ok: true, text: t('bots3.tags.removed') })
      await load()
    } catch (err) {
      setStatus({ ok: false, text: errorMessage(err) })
    } finally {
      setBusy(false)
    }
  }

  const shown = filterTags(tags ?? [], query)
  return (
    <section className="bots3-tags" aria-label={t('bots3.tags.title', { count: tags?.length ?? 0, max })}>
      <h4>{t('bots3.tags.title', { count: tags?.length ?? 0, max })}</h4>
      {tags && tags.length > 5 && (
        <input type="search" className="bots3-tags-search" value={query} placeholder={t('bots3.tags.search')} aria-label={t('bots3.tags.search')}
          onChange={(e) => setQuery(e.target.value)} />
      )}
      {tags && tags.length === 0 && <p className="muted small">{t('bots3.tags.none')}</p>}
      <ul className="bots3-tag-list">
        {shown.map((tag) => (
          <li key={tag.name} className={editing === tag.name ? 'editing' : ''}>
            <div className="bots3-tag-main">
              <code>{tag.name}</code>
              <span className="bots3-tag-text muted">{tag.text}</span>
            </div>
            <div className="bots3-tag-buttons">
              <button type="button" className="link" disabled={busy} onClick={() => { setEditing(tag.name); setName(tag.name); setText(tag.text); setStatus(null) }}>
                {t('bots3.tags.edit')}
              </button>
              <button type="button" className="link danger" disabled={busy} aria-label={`${t('bots3.tags.remove')} ${tag.name}`} onClick={() => void remove(tag)}>
                {t('bots3.tags.remove')}
              </button>
            </div>
          </li>
        ))}
      </ul>
      <form className="bots3-tag-form" onSubmit={(e) => void submit(e)}>
        <label className="field">
          <span>{t('bots3.tags.name')}</span>
          <input type="text" value={name} maxLength={32} disabled={busy || editing !== null} placeholder={t('bots3.tags.namePlaceholder')}
            autoCapitalize="off" spellCheck={false} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field">
          <span>{t('bots3.tags.text')}</span>
          <textarea rows={3} value={text} maxLength={MAX_TAG_TEXT} disabled={busy} placeholder={t('bots3.tags.textPlaceholder')}
            onChange={(e) => setText(e.target.value)} />
        </label>
        <p className="muted small">{t('bots3.tags.textHint')}{name && !problem && <> {t('bots3.tags.usage', { name: tagName(name) })}</>}</p>
        {problem && <p className="error-text">{t(`bots3.settings.invalid.${problem}`)}</p>}
        <div className="more-bot-actions">
          <button type="submit" className="button primary small" disabled={busy || !name || !text || !!problem}>
            {editing ? t('bots3.tags.save') : t('bots3.tags.add')}
          </button>
          {editing && <button type="button" className="button small" onClick={reset}>{t('bots3.tags.cancel')}</button>}
          {status && <span className={status.ok ? 'muted' : 'error-text'} role="status">{status.text}</span>}
        </div>
      </form>
    </section>
  )
}
