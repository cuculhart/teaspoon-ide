import React from 'react'
import { useT } from '../services/i18nService'
import iconUrl from '../../assets/icon.png'
import './About.css'

interface AboutProps {
  onClose: () => void
}

const About: React.FC<AboutProps> = ({ onClose }) => {
  const t = useT()

  const openSite = () => {
    window.electronAPI?.openExternal('https://cuculhart.com')
  }

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-modal about-modal" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <h2>{t('About Teaspoon IDE')}</h2>
          <button className="close-button" onClick={onClose}>×</button>
        </div>
        <div className="settings-content about-content">
          <img src={iconUrl} className="about-icon" alt="Teaspoon IDE" />
          <h3 className="about-app-name">Teaspoon IDE</h3>
          <p className="about-version">Version 0.8.0</p>
          <p className="about-tagline">
            {t('Standalone, Privacy-First AI IDE')}
          </p>
          <p className="about-license">
            {t('License')}: FSL-1.1-MIT
          </p>
          <table className="about-table">
            <tbody>
              <tr>
                <td className="about-label">{t('Author')}</td>
                <td>Eiji Arai</td>
              </tr>
              <tr>
                <td className="about-label">{t('Web Site')}</td>
                <td>
                  <button className="about-link" onClick={openSite}>
                    https://cuculhart.com
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

export default About
