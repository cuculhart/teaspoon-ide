import { configService, ThemeMode } from './configService'

export type ResolvedTheme =
  'dark' | 'light' | 'quiet' | 'ocean' | 'console' | 'walnut' | 'heritage'

// Themes whose UI is light - nativeTheme and the OS-level chrome must be
// told 'light' for these even though their ids are custom.
const LIGHT_THEMES: ResolvedTheme[] = ['light', 'quiet', 'heritage']

const darkMediaQuery = window.matchMedia('(prefers-color-scheme: dark)')

class ThemeService {
  private mode: ThemeMode

  constructor() {
    this.mode = configService.getTheme()
  }

  init(): void {
    this.apply()
    this.applyFont()
    darkMediaQuery.addEventListener('change', this.handleSystemChange)
  }

  private handleSystemChange = () => {
    if (this.mode === 'system') {
      this.apply()
    }
  }

  getMode(): ThemeMode {
    return this.mode
  }

  getResolvedTheme(): ResolvedTheme {
    if (this.mode === 'system') {
      return darkMediaQuery.matches ? 'dark' : 'light'
    }
    return this.mode
  }

  setMode(mode: ThemeMode): void {
    this.mode = mode
    configService.setTheme(mode)
    this.apply()
  }

  private apply(): void {
    const resolved = this.getResolvedTheme()
    document.documentElement.setAttribute('data-theme', resolved)
    // nativeTheme only knows system/light/dark - custom themes map to the
    // nearest base (light variants -> 'light', dark variants -> 'dark')
    const native = this.mode === 'system'
      ? 'system'
      : LIGHT_THEMES.includes(this.mode as ResolvedTheme) ? 'light' : 'dark'
    window.electronAPI?.setThemeSource?.(native)
    window.dispatchEvent(new CustomEvent<ResolvedTheme>('theme-changed', { detail: resolved }))
  }

  applyFont(): void {
    const root = document.documentElement
    const family = configService.getUIFontFamily()
    const size = configService.getUIFontSize()

    if (family) {
      root.style.setProperty('--ui-font-family', family)
    } else {
      root.style.removeProperty('--ui-font-family')
    }
    if (size) {
      root.style.setProperty('--ui-font-size', `${size}px`)
    } else {
      root.style.removeProperty('--ui-font-size')
    }
    window.dispatchEvent(new CustomEvent('font-changed'))
  }
}

export const themeService = new ThemeService()
