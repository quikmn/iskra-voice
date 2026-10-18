// The join questions as a member answers them: one card per question, then the channels your answers suggest.
// Each step is saved when you go on (the server gives or takes the roles); what you hold comes from `member.updated`.
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { JoinAnswer, RoleGroup, ServerRole } from '../../core/protocol'
import { errorMessage } from '../../i18n/errors'
import { useServerRoleGroups, useServerRoles } from '../../state/roles'
import { answerQuestion, loadMyAnswers, useMyAnswers } from '../../state/joinQuestions'
import {
  answerName, askableQuestions, canContinue, chosenFor, shownAnswers, suggestedChannels, toggleAnswer,
} from '../../state/joinQuestionsLogic'
import { selectChannel, selectServer, type ServerState } from '../../state/store'
import { Modal } from '../bits'
import './joinQuestions.css'

const same = (a: number[], b: number[]) => a.length === b.length && a.every((x) => b.includes(x))

const roleNames = (ids: number[], roles: ServerRole[]) =>
  ids.map((id) => roles.find((r) => r.id === id)?.name).filter(Boolean).join(', ')

function AnswerOption({ answer, roles, on, multi, disabled, onToggle }: {
  answer: JoinAnswer; roles: ServerRole[]; on: boolean; multi: boolean; disabled: boolean; onToggle: () => void
}) {
  const { t } = useTranslation()
  const name = answerName(answer, roles)
  const gives = answer.label.trim() !== '' && answer.roles.length > 0
  return (
    <button type="button" className={`jq-answer ${on ? 'on' : ''}`} role={multi ? 'checkbox' : 'radio'} aria-checked={on} aria-label={name}
      disabled={disabled} onClick={onToggle}>
      <span className="jq-check" aria-hidden>{on ? '✓' : ''}</span>
      {answer.emoji && <span className="jq-emoji" aria-hidden>{answer.emoji}</span>}
      <span className="jq-answer-text">
        <span className="jq-answer-name">{name}</span>
        {gives && <span className="jq-gives muted">{t('joinQuestions.flow.gives', { roles: roleNames(answer.roles, roles) })}</span>}
      </span>
    </button>
  )
}

/** The questions, one at a time, then a short "all set" card. */
export function JoinQuestionsFlow({ server, welcome, onClose }: { server: ServerState; welcome: boolean; onClose: () => void }) {
  const { t } = useTranslation()
  const roles = useServerRoles(server.key)
  const questions = askableQuestions(useServerRoleGroups(server.key), roles)
  const mine = useMyAnswers(server.key)
  const myRoles = server.me?.roles ?? []
  const [step, setStep] = useState(0)
  const [drafts, setDrafts] = useState<Record<number, number[]>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void loadMyAnswers(server.key)
  }, [server.key])

  if (questions.length === 0) {
    return (
      <Modal title={t('joinQuestions.flow.titleChange', { server: server.name })} onClose={onClose} className="jq-modal"
        footer={<button className="button primary" onClick={onClose}>{t('joinQuestions.flow.done')}</button>}>
        <p className="muted">{t('joinQuestions.flow.none')}</p>
      </Modal>
    )
  }

  const title = t(welcome ? 'joinQuestions.flow.titleWelcome' : 'joinQuestions.flow.titleChange', { server: server.name })
  const done = step >= questions.length
  const anyRequired = questions.some((q) => q.required)

  if (done) {
    const visible = server.channels.map((c) => c.id)
    const suggested = suggestedChannels(questions, mine, visible)
      .map((id) => server.channels.find((c) => c.id === id)!)
    const open = (id: number) => {
      selectServer(server.key)
      selectChannel(server.key, id)
      onClose()
    }
    return (
      <Modal title={title} onClose={onClose} className="jq-modal"
        footer={<button className="button primary" onClick={onClose} data-testid="join-questions-done">{t('joinQuestions.flow.done')}</button>}>
        <div className="jq-done" data-testid="join-questions-finished">
          <div className="jq-done-mark" aria-hidden>✓</div>
          <h3>{t('joinQuestions.flow.doneTitle')}</h3>
          <p className="muted">{t('joinQuestions.flow.doneText')}</p>
          {suggested.length > 0 && (
            <section className="jq-suggested" aria-labelledby="jq-suggested">
              <h4 id="jq-suggested">{t('joinQuestions.flow.suggested')}</h4>
              <ul>
                {suggested.map((c) => (
                  <li key={c.id}>
                    <button className="jq-channel" onClick={() => open(c.id)} aria-label={t('joinQuestions.flow.openChannel', { name: c.name })}>
                      <span className="hash" aria-hidden>#</span>
                      <span>{c.name}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </Modal>
    )
  }

  const q: RoleGroup = questions[step]
  const saved = chosenFor(q, mine, myRoles)
  const selected = drafts[q.id] ?? saved
  const answers = shownAnswers(q, roles)
  const last = step === questions.length - 1
  const ok = canContinue(q, selected)

  async function next() {
    if (!ok) return setError(t('joinQuestions.flow.needAnswer'))
    setBusy(true)
    setError(null)
    try {
      if (!same(selected, saved)) await answerQuestion(server.key, q, selected)
      setStep(step + 1)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const primary = last ? t('joinQuestions.flow.finish') : selected.length === 0 && !q.required ? t('joinQuestions.flow.skip') : t('joinQuestions.flow.next')

  return (
    <Modal title={title} onClose={onClose} className="jq-modal"
      footer={(
        <div className="jq-footer">
          {step > 0 && <button className="button" disabled={busy} onClick={() => { setError(null); setStep(step - 1) }}>{t('joinQuestions.flow.back')}</button>}
          {step === 0 && !anyRequired && <button className="button" onClick={onClose}>{t('joinQuestions.flow.skipAll')}</button>}
          <span className="spacer" />
          <button className="button primary" disabled={busy || !ok} onClick={() => void next()} data-testid="join-questions-next">{primary}</button>
        </div>
      )}>
      {step === 0 && <p className="muted jq-intro">{t('joinQuestions.flow.intro', { server: server.name })}</p>}
      <div className="jq-progress" aria-hidden>
        {questions.map((x, i) => <span key={x.id} className={i < step ? 'past' : i === step ? 'now' : ''} />)}
      </div>
      <section className="jq-card" aria-labelledby={`jq-q-${q.id}`}>
        <div className="jq-step muted">
          {t('joinQuestions.flow.step', { n: step + 1, total: questions.length })}
          {q.required && <span className="badge jq-required">{t('joinQuestions.flow.required')}</span>}
        </div>
        <h3 id={`jq-q-${q.id}`}>{q.question || q.title}</h3>
        {q.question && <p className="jq-title muted">{q.title}</p>}
        <p className="jq-how muted">{q.multi ? t('joinQuestions.flow.pickAny') : t('joinQuestions.flow.pickOne')}</p>
        <div className="jq-answers" role={q.multi ? 'group' : 'radiogroup'} aria-labelledby={`jq-q-${q.id}`}>
          {answers.map((a) => (
            <AnswerOption key={a.id} answer={a} roles={roles} multi={q.multi} on={selected.includes(a.id)} disabled={busy}
              onToggle={() => {
                setError(null)
                setDrafts({ ...drafts, [q.id]: toggleAnswer(selected, a.id, q.multi) })
              }} />
          ))}
        </div>
      </section>
      {error && <p className="error-text" role="alert">{error}</p>}
    </Modal>
  )
}
