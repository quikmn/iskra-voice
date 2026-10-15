// The team splitter: split the people in a voice channel into teams (random, balanced by skill, or captains pick),
// reshuffle or move people by hand, then "Go" moves everyone into their own team channel. While a split is on, the same
// dialog brings everyone back.
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Member, TeamSplit } from '../../core/protocol'
import { errorMessage } from '../../i18n/errors'
import { useServerRoles } from '../../state/roles'
import type { ServerState } from '../../state/store'
import { useApp } from '../../state/store'
import { canMove, canSplit, closeTeams, endTeams, setSkill, splitOf, startTeams, useSplits, useTeams } from '../../state/teams'
import {
  balancedTeams, canStart, draftTeams, MAX_SKILL, maxTeamsFor, MIN_SKILL, MIN_TEAMS, moveToTeam, nextPicker, randomTeams, skillsFor, spread,
  teamNames, teamTotal,
} from '../../state/teamsLogic'
import { Avatar, Modal } from '../bits'
import './teams.css'

type Mode = 'random' | 'balanced' | 'captains'

/** Mounted once (Shell): shows the splitter for whichever voice channel asked for it. */
export function TeamsLayer() {
  const open = useTeams((s) => s.open)
  const server = useApp((s) => (open ? s.servers[open.serverKey] : undefined))
  if (!open || !server) return null
  return <TeamsDialog key={`${open.serverKey}:${open.channelId}`} server={server} channelId={open.channelId} />
}

function TeamsDialog({ server, channelId }: { server: ServerState; channelId: number }) {
  const { t } = useTranslation()
  const roles = useServerRoles(server.key)
  const splits = useSplits(server.key)
  const channel = server.channels.find((c) => c.id === channelId)
  const active = splitOf(splits, channelId)
  const name = channel?.name ?? ''

  if (!canSplit(server, roles)) {
    return (
      <Modal title={t('teams.title')} onClose={closeTeams} footer={<button className="button" onClick={closeTeams}>{t('common.close')}</button>}>
        <p className="muted">{t('teams.noPower')}</p>
      </Modal>
    )
  }
  if (active) return <ActiveSplit server={server} split={active} />
  return <Splitter server={server} channelId={channelId} name={name} />
}

function Splitter({ server, channelId, name }: { server: ServerState; channelId: number; name: string }) {
  const { t } = useTranslation()
  const roles = useServerRoles(server.key)
  const skills = useTeams((s) => s.skills[server.key]) ?? NO_SKILLS
  const here = server.voice[channelId] ?? NO_ONE
  const members = server.members
  const people = here.map((p) => members[p.accountKey]).filter((m): m is Member => !!m)
    .sort((a, b) => a.name.localeCompare(b.name))
  const movable = people.filter((m) => canMove(server.me, m, roles)).map((m) => m.accountKey)
  const staying = people.filter((m) => !movable.includes(m.accountKey))
  const signature = movable.join(',')

  const [mode, setMode] = useState<Mode>('random')
  const [count, setCount] = useState(MIN_TEAMS)
  const [game, setGame] = useState('')
  const [teams, setTeams] = useState<string[][]>([])
  const [captains, setCaptains] = useState<string[]>([])
  const [picks, setPicks] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const teamCount = Math.min(count, maxTeamsFor(movable.length))
  const skill = useMemo(() => skillsFor(movable, skills), [signature, skills]) // eslint-disable-line react-hooks/exhaustive-deps

  const shuffleNow = () => {
    const list = signature ? signature.split(',') : []
    if (mode === 'random') setTeams(randomTeams(list, teamCount))
    else if (mode === 'balanced') setTeams(balancedTeams(list, teamCount, skillsFor(list, skills)))
  }
  // A new split whenever the way, the number of teams or who's here changes (skills too, when balancing).
  useEffect(() => {
    if (mode === 'captains') {
      setCaptains((c) => c.filter((k) => movable.includes(k)).slice(0, teamCount))
      setPicks((p) => p.filter((k) => movable.includes(k)))
    } else shuffleNow()
  }, [mode, teamCount, signature, mode === 'balanced' ? skills : null]) // eslint-disable-line react-hooks/exhaustive-deps

  const drafting = mode === 'captains' && captains.length === teamCount
  const shown = mode === 'captains' ? (drafting ? draftTeams(captains, picks) : []) : teams
  const unpicked = mode === 'captains' ? movable.filter((k) => !captains.includes(k) && !picks.includes(k)) : []
  const ready = canStart(shown) && unpicked.length === 0 && movable.length >= MIN_TEAMS
  const label = (n: number) => t('teams.teamN', { n })
  const nameOf = (key: string) => members[key]?.name ?? t('common.someone')

  async function go() {
    setBusy(true)
    setError(null)
    try {
      await startTeams(server.key, channelId, shown, teamNames(shown.length, game, label), game)
      closeTeams()
    } catch (e) {
      setError(errorMessage(e))
      setBusy(false)
    }
  }

  const modes: { id: Mode; label: string }[] = [
    { id: 'random', label: t('teams.mode.random') },
    { id: 'balanced', label: t('teams.mode.balanced') },
    { id: 'captains', label: t('teams.mode.captains') },
  ]

  return (
    <Modal
      title={t('teams.title')}
      heading={t('teams.heading', { channel: name })}
      onClose={closeTeams}
      wide
      className="teams-dialog"
      footer={
        <>
          {error && <span className="error-text" role="alert">{error}</span>}
          {mode !== 'captains' && <button className="button" disabled={movable.length < MIN_TEAMS} onClick={shuffleNow}>{t('teams.reshuffle')}</button>}
          {mode === 'captains' && (captains.length > 0 || picks.length > 0) && (
            <button className="button" onClick={() => (picks.length ? setPicks((p) => p.slice(0, -1)) : setCaptains((c) => c.slice(0, -1)))}>{t('teams.undo')}</button>
          )}
          <button className="button" onClick={closeTeams}>{t('common.cancel')}</button>
          <button className="button primary" data-testid="teams-go" disabled={!ready || busy} onClick={() => void go()}>{t('teams.go')}</button>
        </>
      }
    >
      {movable.length < MIN_TEAMS ? (
        <p className="muted teams-empty">{t('teams.needPeople')}</p>
      ) : (
        <>
          <div className="segmented" role="radiogroup" aria-label={t('teams.how')}>
            {modes.map((m) => (
              <button key={m.id} role="radio" aria-checked={mode === m.id} className={mode === m.id ? 'on' : ''} onClick={() => setMode(m.id)}>{m.label}</button>
            ))}
          </div>
          <div className="teams-options">
            <div className="field teams-count">
              <span id="teams-count-label">{t('teams.count')}</span>
              <div className="teams-stepper" role="group" aria-labelledby="teams-count-label">
                <button className="icon-button" aria-label={t('teams.fewer')} disabled={teamCount <= MIN_TEAMS} onClick={() => setCount(teamCount - 1)}>−</button>
                <output aria-live="polite">{teamCount}</output>
                <button className="icon-button" aria-label={t('teams.more')} disabled={teamCount >= maxTeamsFor(movable.length)} onClick={() => setCount(teamCount + 1)}>+</button>
              </div>
            </div>
            <label className="field teams-game">
              <span>{t('teams.game')}</span>
              <input value={game} maxLength={50} placeholder={t('teams.gamePlaceholder')} onChange={(e) => setGame(e.target.value)} />
            </label>
          </div>

          {mode === 'balanced' && (
            <details className="teams-skills" open>
              <summary>{t('teams.skills')}</summary>
              <p className="muted">{t('teams.skillsHint', { min: MIN_SKILL, max: MAX_SKILL })}</p>
              <ul>
                {movable.map((key) => (
                  <li key={key}>
                    <Avatar name={nameOf(key)} accountKey={key} size={24} />
                    <span className="teams-name">{nameOf(key)}</span>
                    <input
                      type="number"
                      inputMode="numeric"
                      min={MIN_SKILL}
                      max={MAX_SKILL}
                      value={skills[key] ?? ''}
                      placeholder={String(Math.round(skill[key] ?? 0))}
                      aria-label={t('teams.skillFor', { name: nameOf(key) })}
                      onChange={(e) => {
                        const v = e.target.value === '' ? null : Math.max(MIN_SKILL, Math.min(MAX_SKILL, Math.round(Number(e.target.value))))
                        setSkill(server.key, key, v === null || Number.isNaN(v) ? null : v)
                      }}
                    />
                  </li>
                ))}
              </ul>
            </details>
          )}

          {mode === 'captains' && !drafting && (
            <div className="teams-pick">
              <p className="teams-step">{t('teams.pickCaptains', { count: teamCount, picked: captains.length })}</p>
              <div className="teams-people">
                {movable.map((key) => {
                  const on = captains.includes(key)
                  return (
                    <button key={key} className={`teams-person ${on ? 'on' : ''}`} aria-pressed={on}
                      onClick={() => setCaptains((c) => (on ? c.filter((k) => k !== key) : c.length < teamCount ? [...c, key] : c))}>
                      <Avatar name={nameOf(key)} accountKey={key} size={24} /> <span className="teams-name">{nameOf(key)}</span>
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          {drafting && unpicked.length > 0 && (
            <div className="teams-pick">
              <p className="teams-step" aria-live="polite">
                {t('teams.picks', { captain: nameOf(captains[nextPicker(picks.length, teamCount)]), team: label(nextPicker(picks.length, teamCount) + 1) })}
              </p>
              <div className="teams-people">
                {unpicked.map((key) => (
                  <button key={key} className="teams-person" onClick={() => setPicks((p) => [...p, key])}>
                    <Avatar name={nameOf(key)} accountKey={key} size={24} /> <span className="teams-name">{nameOf(key)}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {shown.length > 0 && (
            <>
              <div className="teams-grid" data-testid="teams-preview">
                {shown.map((team, i) => (
                  <section key={i} className="teams-card" aria-label={label(i + 1)}>
                    <header>
                      <strong>{game.trim() ? `${game.trim()} · ${label(i + 1)}` : label(i + 1)}</strong>
                      {mode === 'balanced' && <span className="muted">{t('teams.total', { total: Math.round(teamTotal(team, skill)) })}</span>}
                    </header>
                    <ul>
                      {team.map((key, j) => (
                        <li key={key}>
                          {mode === 'captains' ? (
                            <span className="teams-member">
                              <Avatar name={nameOf(key)} accountKey={key} size={22} />
                              <span className="teams-name">{nameOf(key)}</span>
                              {j === 0 && <span className="pill">{t('teams.captain')}</span>}
                            </span>
                          ) : (
                            <button className="teams-member" title={t('teams.moveTo', { name: nameOf(key), team: label(((i + 1) % shown.length) + 1) })}
                              aria-label={t('teams.moveTo', { name: nameOf(key), team: label(((i + 1) % shown.length) + 1) })}
                              onClick={() => setTeams(moveToTeam(teams, key, (i + 1) % shown.length))}>
                              <Avatar name={nameOf(key)} accountKey={key} size={22} />
                              <span className="teams-name">{nameOf(key)}</span>
                            </button>
                          )}
                        </li>
                      ))}
                      {team.length === 0 && <li className="muted">{t('teams.emptyTeam')}</li>}
                    </ul>
                  </section>
                ))}
              </div>
              {mode === 'balanced' && <p className="muted teams-hint">{t('teams.gap', { gap: Math.round(spread(shown, skill)) })}</p>}
              {mode !== 'captains' && <p className="muted teams-hint">{t('teams.tapToMove')}</p>}
            </>
          )}
        </>
      )}
      {staying.length > 0 && (
        <p className="muted teams-hint">{t('teams.staying', { names: staying.map((m) => m.name).join(', ') })}</p>
      )}
    </Modal>
  )
}

function ActiveSplit({ server, split }: { server: ServerState; split: TeamSplit }) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const origin = server.channels.find((c) => c.id === split.channelId)
  async function bringBack() {
    setBusy(true)
    setError(null)
    try {
      await endTeams(server.key, split.id)
      closeTeams()
    } catch (e) {
      setError(errorMessage(e))
      setBusy(false)
    }
  }
  return (
    <Modal
      title={t('teams.title')}
      heading={split.game ? t('teams.activeGame', { game: split.game }) : t('teams.active')}
      onClose={closeTeams}
      className="teams-dialog"
      footer={
        <>
          {error && <span className="error-text" role="alert">{error}</span>}
          <button className="button" onClick={closeTeams}>{t('common.close')}</button>
          <button className="button primary" data-testid="teams-back" disabled={busy || !origin} onClick={() => void bringBack()}>{t('teams.bringBack')}</button>
        </>
      }
    >
      <p className="muted">{origin ? t('teams.activeHint', { channel: origin.name }) : t('teams.originGone')}</p>
      <div className="teams-grid">
        {split.teams.map((team) => {
          const people = server.voice[team.channelId] ?? []
          return (
            <section key={team.channelId} className="teams-card" aria-label={team.name}>
              <header><strong>{team.name}</strong><span className="muted">{t('teams.inVoice', { count: people.length })}</span></header>
              <ul>
                {people.map((p) => (
                  <li key={p.accountKey}>
                    <span className="teams-member">
                      <Avatar name={server.members[p.accountKey]?.name ?? ''} accountKey={p.accountKey} size={22} />
                      <span className="teams-name">{server.members[p.accountKey]?.name ?? t('common.someone')}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )
        })}
      </div>
    </Modal>
  )
}

const NO_SKILLS: Record<string, number> = {}
const NO_ONE: { accountKey: string }[] = []
