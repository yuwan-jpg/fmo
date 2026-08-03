import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
// @ts-ignore - legacy JS
import {
  saveFmoAddresses,
  getFmoAddresses,
  getAllRecordsFromIndexedDB,
  getContactCountsFromIndexedDB
} from '../services/db'
// @ts-ignore - legacy JS
import { FmoApiClient } from '../services/fmoApi'
// @ts-ignore - legacy JS
import {
  buildBasicAuthHeader,
  buildWebSocketUrl,
  ensureBasicAuthCached,
  normalizeHost,
  parseAddressWithAuth
} from '../utils/urlUtils'
// @ts-ignore - legacy JS
import { downloadRemoteFile } from '../utils/exportFile'
import { getPlatform } from '../platform'

const AUDIO_VOLUME_KEY = 'fmo_audio_volume'
const AUDIO_PLAYING_KEY = 'fmo_audio_playing'
const PRIORITIZE_TODAY_KEY = 'fmo_prioritize_today'

interface UserInfo {
  callsign: string
  uid: number | null
  wlanIP: string
}

interface AddressItem {
  id: string
  numId?: number
  name: string
  host: string
  protocol: string
  username?: string
  password?: string
  userInfo?: UserInfo
}

interface AddressStorage {
  addresses: AddressItem[]
  activeId: string | null
  selectedIds: string[]
  multiSelectMode?: boolean
}

interface ActionResult {
  success: boolean
  message?: string
  reconnect?: boolean
  id?: string
}

/**
 * 设置/存储 store（替代 composables/useSettings.js）。
 *
 * 职责：
 * - 多地址管理（fmoAddresses 通过 db.js 的 IndexedDB 读写）
 * - 全局音量、音频播放状态（通过 platform.storage 跨端持久化）
 * - 今日通联呼号、通联次数（从 IndexedDB 派生）
 * - 备份导出、连接验证、用户信息刷新等 actions
 */
export const useSettingsStore = defineStore('settings', () => {
  // ========== state ==========
  const fmoAddressStorage = ref<AddressStorage>({
    addresses: [],
    activeId: null,
    selectedIds: []
  })
  const todayContactedCallsigns = ref<Set<string>>(new Set())
  const contactCounts = ref<Map<string, number>>(new Map())

  const selectedAddressIds = ref<string[]>([])
  const multiSelectMode = ref(false)

  const audioVolume = ref(100)
  const audioPlaying = ref(false)
  const prioritizeToday = ref(false)

  const isHttps = window.location.protocol === 'https:'
  const isMobileDevice = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
    navigator.userAgent
  )

  // ========== getters ==========
  const activeAddress = computed<AddressItem | null>(() => {
    if (!fmoAddressStorage.value.activeId) return null
    return (
      fmoAddressStorage.value.addresses.find((a) => a.id === fmoAddressStorage.value.activeId) ||
      null
    )
  })

  const fmoAddress = computed(() => activeAddress.value?.host || '')
  const protocol = computed(() => activeAddress.value?.protocol || 'ws')
  const addressList = computed(() => fmoAddressStorage.value.addresses)
  const activeAddressId = computed(() => fmoAddressStorage.value.activeId)

  const remoteControlUrl = computed(() => {
    if (!fmoAddress.value) return '#'
    const parsed = parseAddressWithAuth(fmoAddress.value)
    const active = activeAddress.value
    const username = active?.username || parsed.username
    const password = active?.password || parsed.password
    const host = parsed.host
    if (username) {
      return `http://${encodeURIComponent(username)}:${encodeURIComponent(password || '')}@${host}/remote.html`
    }
    return `http://${host}/remote.html`
  })

  // ========== 音量 / 播放状态（走 platform.storage） ==========
  async function initAudioVolume() {
    const saved = await getPlatform().storage.get(AUDIO_VOLUME_KEY)
    if (saved !== null) {
      const val = Number(saved)
      if (!isNaN(val) && val >= 0 && val <= 200) {
        audioVolume.value = val
      }
    }
  }

  async function setAudioVolume(value: number | string) {
    const num = Number(value)
    const val = Math.max(0, Math.min(200, isNaN(num) ? 100 : num))
    audioVolume.value = val
    await getPlatform().storage.set(AUDIO_VOLUME_KEY, String(val))
  }

  async function initAudioPlaying() {
    const saved = await getPlatform().storage.get(AUDIO_PLAYING_KEY)
    audioPlaying.value = saved === 'true'
  }

  async function setAudioPlaying(value: boolean) {
    audioPlaying.value = !!value
    await getPlatform().storage.set(AUDIO_PLAYING_KEY, String(!!value))
  }

  async function initPrioritizeToday() {
    const saved = await getPlatform().storage.get(PRIORITIZE_TODAY_KEY)
    prioritizeToday.value = saved === 'true'
  }

  async function setPrioritizeToday(value: boolean) {
    prioritizeToday.value = !!value
    await getPlatform().storage.set(PRIORITIZE_TODAY_KEY, String(!!value))
  }

  // ========== 地址初始化与管理 ==========
  async function initFmoAddress(): Promise<boolean> {
    await initAudioVolume()
    await initAudioPlaying()
    await initPrioritizeToday()

    const storage: AddressStorage = await getFmoAddresses()
    fmoAddressStorage.value = storage

    selectedAddressIds.value = storage.selectedIds || []
    multiSelectMode.value = storage.multiSelectMode || false

    if (storage.addresses.length > 0) {
      await saveFmoAddresses(storage)

      if (storage.activeId) {
        const activeAddr = storage.addresses.find((a) => a.id === storage.activeId)
        if (activeAddr) {
          // 预认证：带认证的地址需先缓存凭据，后续连接才能通过
          await preauthAddress(activeAddr)

          if (!activeAddr.userInfo) {
            try {
              const fullAddress = buildFullAddress(activeAddr)
              const client = new FmoApiClient(fullAddress)
              const userInfo = await client.getUserInfo()

              const index = fmoAddressStorage.value.addresses.findIndex(
                (a) => a.id === storage.activeId
              )
              if (index !== -1) {
                fmoAddressStorage.value.addresses[index] = {
                  ...fmoAddressStorage.value.addresses[index],
                  userInfo: {
                    callsign: userInfo.callsign || '',
                    uid: userInfo.uid || null,
                    wlanIP: userInfo.wlanIP || ''
                  }
                }
                await saveFmoAddresses(fmoAddressStorage.value)
              }
              client.close()
            } catch (err) {
              console.log('初始化时获取用户信息失败:', err)
            }
          }
        }
      }

      return true
    }

    return false
  }

  async function validateConnection(
    host: string,
    proto: string,
    username = '',
    password = ''
  ): Promise<boolean> {
    const parsed = parseAddressWithAuth(host)
    const normalizedHost = parsed.host
    const finalUsername = username || parsed.username
    const finalPassword = password || parsed.password
    if (finalUsername) {
      await ensureBasicAuthCached(
        normalizedHost,
        finalUsername,
        finalPassword,
        proto === 'wss' ? 'https' : 'http'
      )
    }
    const wsUrl = buildWebSocketUrl(normalizedHost, proto, '/ws')
    return new Promise((resolve) => {
      let settled = false
      let socket: WebSocket
      try {
        socket = new WebSocket(wsUrl)
      } catch {
        resolve(false)
        return
      }
      const finish = (ok: boolean) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        resolve(ok)
      }
      const timeout = setTimeout(() => {
        socket.close()
        finish(false)
      }, 8000)
      socket.onopen = () => {
        socket.close()
        finish(true)
      }
      socket.onerror = () => {
        socket.close()
        finish(false)
      }
      socket.onclose = () => {
        if (!settled) finish(false)
      }
    })
  }

  // ========== Basic Auth 认证支持 ==========

  /** 从地址项中解析凭据(兼容 host 里残留 user:pass@ 的旧数据) */
  function resolveAddressCredential(addr: AddressItem) {
    const parsed = parseAddressWithAuth(addr.host)
    return {
      host: parsed.host,
      username: addr.username || parsed.username,
      password: addr.password || parsed.password
    }
  }

  /** 组装完整 baseUrl，若带凭据则拼回 userinfo，供 FmoApiClient 解析 */
  function buildFullAddress(addr: AddressItem): string {
    const { host, username, password } = resolveAddressCredential(addr)
    if (username) {
      return `${addr.protocol}://${encodeURIComponent(username)}:${encodeURIComponent(
        password || ''
      )}@${host}`
    }
    return `${addr.protocol}://${host}`
  }

  /** 预认证：让浏览器缓存该 origin 的 Basic 凭据，后续 WebSocket 自动携带 */
  async function preauthAddress(addr: AddressItem | null) {
    if (!addr) return
    const { host, username, password } = resolveAddressCredential(addr)
    if (!username) return
    await ensureBasicAuthCached(host, username, password, addr.protocol === 'wss' ? 'https' : 'http')
  }

  function generateId(): string {
    return Date.now().toString(36) + Math.random().toString(36).substring(2, 11)
  }

  function generateNumId(): number {
    const usedIds = new Set(fmoAddressStorage.value.addresses.map((a) => a.numId).filter(Boolean))
    let id = 1
    while (usedIds.has(id)) id++
    return id
  }

  async function toggleAddressSelection(id: string) {
    const index = selectedAddressIds.value.indexOf(id)
    if (index === -1) {
      selectedAddressIds.value.push(id)
    } else {
      selectedAddressIds.value.splice(index, 1)
    }
    fmoAddressStorage.value.selectedIds = [...selectedAddressIds.value]
    await saveFmoAddresses(fmoAddressStorage.value)
  }

  async function setMultiSelectMode(value: boolean) {
    multiSelectMode.value = value
    fmoAddressStorage.value.multiSelectMode = value
    await saveFmoAddresses(fmoAddressStorage.value)
  }

  async function addFmoAddress(
    name: string,
    host: string,
    proto: string,
    username = '',
    password = ''
  ): Promise<ActionResult> {
    const parsed = parseAddressWithAuth(host)
    const normalizedHost = parsed.host
    const finalUsername = username || parsed.username
    const finalPassword = password || parsed.password

    const client = new FmoApiClient(`${proto}://${normalizedHost}`)
    if (!client.isValidAddress(normalizedHost)) {
      return { success: false, message: '请输入有效的IP地址或域名' }
    }

    const exists = fmoAddressStorage.value.addresses.some(
      (a) => normalizeHost(a.host) === normalizedHost && a.protocol === proto
    )
    if (exists) {
      return { success: false, message: '该地址已存在' }
    }

    // 预认证：缓存该 origin 的 Basic 凭据
    if (finalUsername) {
      await ensureBasicAuthCached(
        normalizedHost,
        finalUsername,
        finalPassword,
        proto === 'wss' ? 'https' : 'http'
      )
    }

    const id = generateId()
    const numId = generateNumId()
    const newAddress: AddressItem = {
      id,
      numId,
      name: name || normalizedHost,
      host: normalizedHost,
      protocol: proto,
      ...(finalUsername ? { username: finalUsername, password: finalPassword } : {})
    }

    let authFailed = false
    let authFailReason = ''
    try {
      const fullAddress = `${proto}://${normalizedHost}`
      const apiClient = new FmoApiClient(fullAddress)
      const userInfo = await apiClient.getUserInfo()
      newAddress.userInfo = {
        callsign: userInfo.callsign || '',
        uid: userInfo.uid || null,
        wlanIP: userInfo.wlanIP || ''
      }
      apiClient.close()
    } catch (err) {
      console.log('获取用户信息失败:', err)
      authFailed = !!finalUsername
      authFailReason = err?.message || String(err)
    }

    fmoAddressStorage.value.addresses.push(newAddress)
    fmoAddressStorage.value.activeId = id

    await saveFmoAddresses(fmoAddressStorage.value)
    if (authFailed) {
      return {
        success: true,
        message:
          `地址已添加，但认证未生效（${authFailReason}）。如连接不上，请检查用户名/密码是否正确，或在设置里重新点击该地址触发认证。`,
        id,
        reconnect: true
      }
    }
    return { success: true, message: '地址已添加', id, reconnect: true }
  }

  async function updateFmoAddress(
    id: string,
    name: string,
    host: string,
    proto: string,
    username = '',
    password = ''
  ): Promise<ActionResult> {
    const index = fmoAddressStorage.value.addresses.findIndex((a) => a.id === id)
    if (index === -1) {
      return { success: false, message: '地址不存在' }
    }

    const parsed = parseAddressWithAuth(host)
    const normalizedHost = parsed.host
    const finalUsername = username || parsed.username
    const finalPassword = password || parsed.password

    const client = new FmoApiClient(`${proto}://${normalizedHost}`)
    if (!client.isValidAddress(normalizedHost)) {
      return { success: false, message: '请输入有效的IP地址或域名' }
    }

    const duplicate = fmoAddressStorage.value.addresses.some(
      (a, i) => i !== index && normalizeHost(a.host) === normalizedHost && a.protocol === proto
    )
    if (duplicate) {
      return { success: false, message: '该地址已存在' }
    }

    if (finalUsername) {
      await ensureBasicAuthCached(
        normalizedHost,
        finalUsername,
        finalPassword,
        proto === 'wss' ? 'https' : 'http'
      )
    }

    fmoAddressStorage.value.addresses[index] = {
      ...fmoAddressStorage.value.addresses[index],
      name: name || normalizedHost,
      host: normalizedHost,
      protocol: proto,
      ...(finalUsername ? { username: finalUsername, password: finalPassword } : {})
    }

    await saveFmoAddresses(fmoAddressStorage.value)
    return { success: true, message: '地址已更新' }
  }

  async function deleteFmoAddress(id: string): Promise<ActionResult> {
    const index = fmoAddressStorage.value.addresses.findIndex((a) => a.id === id)
    if (index === -1) {
      return { success: false, message: '地址不存在' }
    }

    const wasActive = fmoAddressStorage.value.activeId === id
    fmoAddressStorage.value.addresses.splice(index, 1)

    if (wasActive) {
      if (fmoAddressStorage.value.addresses.length > 0) {
        fmoAddressStorage.value.activeId = fmoAddressStorage.value.addresses[0].id
      } else {
        fmoAddressStorage.value.activeId = null
      }
    }

    const selectedIndex = selectedAddressIds.value.indexOf(id)
    if (selectedIndex !== -1) {
      selectedAddressIds.value.splice(selectedIndex, 1)
    }

    fmoAddressStorage.value.selectedIds = [...selectedAddressIds.value]
    await saveFmoAddresses(fmoAddressStorage.value)
    return { success: true, message: '地址已删除', reconnect: wasActive }
  }

  async function selectFmoAddress(id: string): Promise<ActionResult> {
    const address = fmoAddressStorage.value.addresses.find((a) => a.id === id)
    if (!address) {
      return { success: false, message: '地址不存在' }
    }

    fmoAddressStorage.value.activeId = id

    await preauthAddress(address)

    try {
      const fullAddress = buildFullAddress(address)
      const client = new FmoApiClient(fullAddress)
      const userInfo = await client.getUserInfo()

      const index = fmoAddressStorage.value.addresses.findIndex((a) => a.id === id)
      if (index !== -1) {
        fmoAddressStorage.value.addresses[index] = {
          ...fmoAddressStorage.value.addresses[index],
          userInfo: {
            callsign: userInfo.callsign || '',
            uid: userInfo.uid || null,
            wlanIP: userInfo.wlanIP || ''
          }
        }
      }
      client.close()
    } catch (err) {
      console.log('切换地址后获取用户信息失败:', err)
    }

    await saveFmoAddresses(fmoAddressStorage.value)
    return { success: true, message: '已切换到: ' + address.name, reconnect: true }
  }

  async function clearAllAddresses(): Promise<ActionResult> {
    const hadAddresses = fmoAddressStorage.value.addresses.length > 0
    fmoAddressStorage.value.addresses = []
    fmoAddressStorage.value.activeId = null
    selectedAddressIds.value = []
    fmoAddressStorage.value.selectedIds = []
    await saveFmoAddresses(fmoAddressStorage.value)
    return { success: true, reconnect: hadAddresses }
  }

  async function refreshUserInfo(id: string): Promise<ActionResult> {
    const address = fmoAddressStorage.value.addresses.find((a) => a.id === id)
    if (!address) {
      return { success: false, message: '地址不存在' }
    }

    await preauthAddress(address)

    try {
      const fullAddress = buildFullAddress(address)
      const client = new FmoApiClient(fullAddress)
      const userInfo = await client.getUserInfo()

      const index = fmoAddressStorage.value.addresses.findIndex((a) => a.id === id)
      if (index !== -1) {
        fmoAddressStorage.value.addresses[index] = {
          ...fmoAddressStorage.value.addresses[index],
          userInfo: {
            callsign: userInfo.callsign || '',
            uid: userInfo.uid || null,
            wlanIP: userInfo.wlanIP || ''
          }
        }
        await saveFmoAddresses(fmoAddressStorage.value)
      }
      client.close()
      return { success: true, message: '用户信息已更新' }
    } catch (err) {
      console.log('刷新用户信息失败:', err)
      return { success: false, message: '获取用户信息失败' }
    }
  }

  async function validateAndSaveFmoAddress(): Promise<ActionResult> {
    const address = fmoAddress.value
    if (!address) {
      return { success: true, message: '设置已保存' }
    }

    const active = activeAddress.value
    const isConnected = await validateConnection(
      address,
      protocol.value,
      active?.username || '',
      active?.password || ''
    )
    if (isConnected) {
      return { success: true, message: '设置已保存', reconnect: true }
    } else {
      if (isHttps && protocol.value === 'ws') {
        return {
          success: false,
          message:
            '请确认 fmo 地址。提示：HTTPS 网站无法直接连接局域网设备，请按界面提示开启浏览器"不安全内容"访问权限，或选择 wss:// 协议。'
        }
      } else {
        return { success: false, message: '请确认fmo地址' }
      }
    }
  }

  async function backupLogs() {
    if (!fmoAddress.value) return

    let address = fmoAddress.value.trim()
    const httpProtocol = protocol.value === 'wss' ? 'https' : 'http'

    const parsed = parseAddressWithAuth(address)
    const active = activeAddress.value
    const username = active?.username || parsed.username
    const password = active?.password || parsed.password

    if (username) {
      await ensureBasicAuthCached(parsed.host, username, password, httpProtocol)
    }

    const url = `${httpProtocol}://${parsed.host}/api/qso/backup`
    const headers = username ? { Authorization: buildBasicAuthHeader(username, password) } : undefined
    return await downloadRemoteFile(url, `fmo-backup-${Date.now()}.db`, headers)
  }

  async function loadTodayContactedCallsigns(selectedFromCallsign: string) {
    if (!selectedFromCallsign) {
      todayContactedCallsigns.value = new Set()
      return
    }

    try {
      const allRecords = await getAllRecordsFromIndexedDB(1, 999999, '', selectedFromCallsign)
      const callsigns = new Set<string>()
      const today = new Date()

      for (const record of allRecords.data) {
        if (record.timestamp) {
          const contactDate = new Date(record.timestamp * 1000)
          const isToday =
            contactDate.getUTCFullYear() === today.getUTCFullYear() &&
            contactDate.getUTCMonth() === today.getUTCMonth() &&
            contactDate.getUTCDate() === today.getUTCDate()
          if (isToday && record.toCallsign) {
            callsigns.add(record.toCallsign)
          }
        }
      }

      todayContactedCallsigns.value = callsigns
    } catch (error) {
      console.error('查询今日通联呼号失败:', error)
      todayContactedCallsigns.value = new Set()
    }
  }

  async function loadContactCounts(selectedFromCallsign: string) {
    if (!selectedFromCallsign) {
      contactCounts.value = new Map()
      return
    }

    try {
      contactCounts.value = await getContactCountsFromIndexedDB(selectedFromCallsign)
    } catch (error) {
      console.error('加载通联次数失败:', error)
      contactCounts.value = new Map()
    }
  }

  async function setActiveAddressId(id: string) {
    fmoAddressStorage.value.activeId = id
    await saveFmoAddresses(fmoAddressStorage.value)
  }

  return {
    // state / getters
    fmoAddress,
    protocol,
    todayContactedCallsigns,
    isHttps,
    isMobileDevice,
    remoteControlUrl,
    addressList,
    activeAddressId,
    activeAddress,
    contactCounts,
    selectedAddressIds,
    multiSelectMode,
    audioVolume,
    audioPlaying,
    prioritizeToday,
    // actions
    initFmoAddress,
    validateAndSaveFmoAddress,
    backupLogs,
    loadTodayContactedCallsigns,
    loadContactCounts,
    addFmoAddress,
    updateFmoAddress,
    deleteFmoAddress,
    selectFmoAddress,
    clearAllAddresses,
    refreshUserInfo,
    validateConnection,
    toggleAddressSelection,
    setMultiSelectMode,
    setActiveAddressId,
    setAudioVolume,
    setAudioPlaying,
    setPrioritizeToday
  }
})
