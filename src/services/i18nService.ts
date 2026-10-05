import { useSyncExternalStore } from 'react'
import { configService } from './configService'

// Simple i18n: language files live in <resources>/lang (packaged) or
// <projectRoot>/lang (dev) as <code>.json mapping English source -> localized.
// English is the source language, so 'en' needs no file.
const EVENT = 'teaspoon:language-changed'

class I18nService {
  private dict: Record<string, string> = {}
  private code = 'en'

  get language(): string {
    return this.code
  }

  // English key -> localized string (falls back to the key itself)
  t(key: string): string {
    return this.dict[key] ?? key
  }

  async setLanguage(code: string): Promise<void> {
    this.code = code
    configService.setLanguage(code)
    // The main process keeps its own copy of the dict for menus,
    // native dialogs, and IPC error strings.
    window.electronAPI?.setLanguage?.(code)
    if (code === 'en') {
      this.dict = {}
    } else {
      const result = await window.electronAPI!.loadLanguage(code)
      this.dict = result.success && result.dict ? result.dict : {}
    }
    window.dispatchEvent(new Event(EVENT))
  }

  async init(): Promise<void> {
    const saved = configService.getLanguage()
    if (saved && saved !== 'en') {
      await this.setLanguage(saved)
    }
  }

  subscribe(cb: () => void): () => void {
    window.addEventListener(EVENT, cb)
    return () => window.removeEventListener(EVENT, cb)
  }
}

export const i18nService = new I18nService()

// React hook: re-renders the component when the language changes
export function useT(): (key: string) => string {
  useSyncExternalStore(
    (cb) => i18nService.subscribe(cb),
    () => i18nService.language,
  )
  return (key: string) => i18nService.t(key)
}
