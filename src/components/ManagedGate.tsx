import React, { useState } from 'react'
import { configService } from '../services/configService'
import { managedService } from '../services/managedService'
import { useT } from '../services/i18nService'
import './ManagedGate.css'

// Full-screen sign-in gate shown while managed mode is enabled and no
// valid organization session exists. Rendered INSTEAD of the app shell
// (not as an overlay), so nothing underneath can receive input.
const ManagedGate: React.FC = () => {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirmDisable, setConfirmDisable] = useState(false)
  const t = useT()

  const serverUrl = configService.getManagedServerUrl()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (busy) return
    setError('')
    setBusy(true)
    try {
      await managedService.login(serverUrl, username, password)
      // managed-changed event flips the gate off in App
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  return (
    <div className="managed-gate">
      <div className="managed-gate-card">
        <h1 className="managed-gate-title">Teaspoon IDE</h1>
        <p className="managed-gate-subtitle">{t('Sign in to your organization')}</p>

        <form onSubmit={handleSubmit}>
          <label className="managed-gate-label" htmlFor="managed-server">
            {t('Server')}
          </label>
          <div id="managed-server" className="managed-gate-server">
            {serverUrl || '—'}
          </div>

          <label className="managed-gate-label" htmlFor="managed-username">
            {t('Username')}
          </label>
          <input
            id="managed-username"
            type="text"
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="managed-gate-input"
            autoFocus
          />

          <label className="managed-gate-label" htmlFor="managed-password">
            {t('Password')}
          </label>
          <input
            id="managed-password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="managed-gate-input"
          />

          {error && <p className="managed-gate-error">{error}</p>}

          <button
            type="submit"
            className="managed-gate-submit"
            disabled={busy || !username.trim() || !password}
          >
            {busy ? t('Signing in...') : t('Sign In')}
          </button>
        </form>

        <div className="managed-gate-footer">
          {confirmDisable ? (
            <>
              <span className="managed-gate-note">
                {t('Stop using organization sign-in on this device?')}
              </span>
              <button
                className="managed-gate-link"
                onClick={() => managedService.disable()}
              >
                {t('Disable')}
              </button>
              <button
                className="managed-gate-link"
                onClick={() => setConfirmDisable(false)}
              >
                {t('Cancel')}
              </button>
            </>
          ) : (
            <button
              className="managed-gate-link"
              onClick={() => setConfirmDisable(true)}
            >
              {t('Continue without an organization')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

export default ManagedGate
