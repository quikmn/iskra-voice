// A component that throws shows a short note instead of blanking the app. "pane" wraps the main column (goes back
// to normal when `resetKey` changes, e.g. another channel); "app" wraps everything and offers a reload.
import { Component, type ErrorInfo, type ReactNode } from 'react'
import { t } from '../i18n'
import { errorFrame, recordDiagnostic } from '../state/bugReport/diagnostics'
import { openBugReport } from '../state/bugReport/bugReport'

interface Props {
  variant: 'app' | 'pane'
  resetKey?: string
  children: ReactNode
}

export class ErrorBoundary extends Component<Props, { failed: boolean; key?: string }> {
  state = { failed: false, key: this.props.resetKey }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  static getDerivedStateFromProps(props: Props, state: { failed: boolean; key?: string }) {
    return props.resetKey !== state.key ? { failed: false, key: props.resetKey } : null
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('UI error', error, info.componentStack)
    recordDiagnostic({ kind: 'error', source: 'render', name: error.name, frame: errorFrame(error.stack) })
  }

  render() {
    if (!this.state.failed) return this.props.children
    const app = this.props.variant === 'app'
    return (
      <div className={`crash-note ${app ? 'crash-app' : ''}`} role="alert">
        <h2>{t('app.crash.title')}</h2>
        <p className="muted">{app ? t('app.crash.appText') : t('app.crash.paneText')}</p>
        <div className="copy-row">
          {!app && <button className="button" onClick={() => this.setState({ failed: false })}>{t('common.tryAgain')}</button>}
          <button className={`button ${app ? 'primary' : ''}`} onClick={() => location.reload()}>{t('app.crash.reload')}</button>
          {!app && <button className="button" onClick={openBugReport}>{t('bugReport.open')}</button>}
        </div>
      </div>
    )
  }
}
