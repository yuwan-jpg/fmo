import { defineStore } from 'pinia'
import { ref } from 'vue'
import {
  DEFAULT_LAYOUT,
  DEFAULT_SKIN,
  LAYOUTS,
  LAYOUT_KEY,
  SKINS,
  SKIN_KEY,
  THEME_KEY
} from '../core/theme'

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeStorage(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* ignore */
  }
}

/**
 * 主题 store：集中管理深/浅色 + 皮肤 + 布局。
 *
 * - dark / skin / layout 分别持久化到 fmo_theme / fmo_skin / fmo_layout
 * - 通过 document.documentElement 的 data-theme / data-skin / data-layout 应用，
 *   样式由 style.css（明暗）+ src/theme/skins.css（皮肤/布局）消费。
 * - 深色模式沿用旧键 fmo_theme，兼容历史选择。
 */
export const useThemeStore = defineStore('theme', () => {
  const isDarkTheme = ref(false)
  const skinId = ref(DEFAULT_SKIN)
  const layoutId = ref(DEFAULT_LAYOUT)

  function apply() {
    const el = document.documentElement
    el.dataset.theme = isDarkTheme.value ? 'dark' : 'light'
    el.dataset.skin = skinId.value
    el.dataset.layout = layoutId.value
  }

  async function init() {
    const storedTheme = readStorage(THEME_KEY)
    const prefersDark =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches
    isDarkTheme.value = storedTheme ? storedTheme === 'dark' : prefersDark

    const skin = readStorage(SKIN_KEY) || DEFAULT_SKIN
    skinId.value = SKINS.some((s) => s.id === skin) ? skin : DEFAULT_SKIN

    const layout = readStorage(LAYOUT_KEY) || DEFAULT_LAYOUT
    layoutId.value = LAYOUTS.some((l) => l.id === layout) ? layout : DEFAULT_LAYOUT

    apply()
  }

  async function setDark(v: boolean) {
    isDarkTheme.value = v
    writeStorage(THEME_KEY, v ? 'dark' : 'light')
    apply()
  }

  async function setSkin(id: string) {
    if (!SKINS.some((s) => s.id === id)) return
    skinId.value = id
    writeStorage(SKIN_KEY, id)
    apply()
  }

  async function setLayout(id: string) {
    if (!LAYOUTS.some((l) => l.id === id)) return
    layoutId.value = id
    writeStorage(LAYOUT_KEY, id)
    apply()
  }

  function toggleDark() {
    return setDark(!isDarkTheme.value)
  }

  return {
    // state
    isDarkTheme,
    skinId,
    layoutId,
    // actions
    init,
    setDark,
    setSkin,
    setLayout,
    toggleDark
  }
})
