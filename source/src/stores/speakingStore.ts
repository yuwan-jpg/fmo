import { defineStore } from 'pinia'
import { ref, computed, reactive } from 'vue'
// @ts-ignore - legacy JS
import { buildWebSocketUrl, normalizeHost } from '../utils/urlUtils'
// @ts-ignore - legacy JS
import { gridToAddress } from '../services/gridService'
import { addDiagnosticLog } from '../services/diagnosticLog'
import { isTauriDesktop } from '../utils/desktopBridge'
import { getPlatform } from '../platform'
import type { ServerInfo, EventsStatus } from '../platform/types/speaking'

// 是否由原生侧（Android）托管 events：连接池、快照、通知栏等
const hasNativeEvents = getPlatform().capabilities.hasNativeEvents
const DUPLICATE_SPEAKING_EVENT_MS = 2500

interface SpeakingRecord {
  callsign: string
  grid?: string
  startTime: number
  endTime: number | null
  serverName?: string
  serverUid?: string
}

function getStorageKey(addressId: string) {
  return `fmo_speaking_history_${addressId}`
}

function loadFromStorage(addressId: string): SpeakingRecord[] {
  if (hasNativeEvents) return []
  try {
    const raw = localStorage.getItem(getStorageKey(addressId))
    if (!raw) return []
    const list: SpeakingRecord[] = JSON.parse(raw)
    // 永久保存通联记录：不做时间清理，跨会话/重连恢复的全部保留
    const now = Date.now()
    // 上次会话“正在发言”（endTime 为空）的记录：若发生在近期（15 分钟内），
    // 大概率当前仍在发言，保留为 LIVE 当前呼叫，让重新打开后立即显示当前呼号，
    // 不依赖 events 补推（FMO 只在状态变化时推送）；超过 15 分钟才视为已结束，
    // 避免重启后一直停留在旧呼号。
    const activeCutoff = now - 15 * 60 * 1000
    return list.map((h) => ({
      ...h,
      endTime: h.endTime == null && h.startTime >= activeCutoff ? null : h.endTime || h.startTime
    }))
  } catch (err) {
    console.error(`[${addressId}] 加载发言历史失败:`, err)
    return []
  }
}

function saveToStorage(addressId: string, list: SpeakingRecord[]) {
  if (hasNativeEvents) return
  try {
    localStorage.setItem(getStorageKey(addressId), JSON.stringify(list))
  } catch (err) {
    console.error(`[${addressId}] 保存发言历史失败:`, err)
  }
}

function formatAddr(data: any): string {
  if (!data) return ''
  return data.city || data.province || ''
}

/**
 * Speaking 状态 store（替代 composables/useSpeakingStatus.js 中的业务态部分）。
 *
 * 职责：
 * - 订阅 platform.events 推送的 onMessage/onStatus/onServerInfo
 * - 按 addressId 维护：当前发言人、发言历史、地址、host 标记、serverInfo
 * - Web 端 localStorage 持久化；Android 由原生 SharedPreferences 兜底
 * - 暴露 connect/disconnect 等 actions 驱动 platform.events
 */
export const useSpeakingStatusStore = defineStore('speakingStatus', () => {
  // ========== 核心 state（按 addressId 隔离） ==========
  const currentSpeakerMap = reactive(new Map<string, string>())
  const speakingHistoryMap = reactive(new Map<string, SpeakingRecord[]>())
  const speakerAddressMap = reactive(new Map<string, string>())
  const isHostSpeakingMap = reactive(new Map<string, boolean>())
  const serverInfoMap = reactive(new Map<string, ServerInfo>())

  const connectionConfigs = new Map<
    string,
    { host: string; protocol: string; isPrimary: boolean }
  >()
  const statusMap = reactive(new Map<string, EventsStatus>())
  const changeCounter = ref(0)
  let unsubMsg: (() => void) | null = null
  let unsubStatus: (() => void) | null = null
  let unsubInfo: (() => void) | null = null
  let visibilityBound = false
  let listenersInstalled = false

  // 状态补偿：events 连接后若迟迟收不到"当前正在发言"事件（FMO 只在状态变化时推送，
  // 首次打开时正在通话的人不会主动补发），主动重连 events 让 FMO 补推当前状态，
  // 避免首次打开一直显示"无人发言"，无需用户手动清理缓存触发。
  // 关键点：只有收到 isSpeaking=true 的实时发言事件才算确认当前状态；只收到"停止"
  // 事件（很可能是连接前残留的陈旧事件）时仍会再补偿一轮，避免陈旧停止事件把
  // 正在发言的人盖掉；重连时先短暂断开再以全新订阅接入，FMO 才会补推当前状态。
  const COMPENSATION_DELAY_MS = 3000
  const COMPENSATION_MAX_ATTEMPTS = 6
  let receivedSpeakingSinceConnect = false
  let receivedStopSinceConnect = false
  let compensationTimer: any = null
  let compensationAttempts = 0
  // 诊断：记录已收到过的呼号事件，避免日志刷屏（仅保留前若干条）
  const msgLogged: string[] = []

  function markSpeakingReceived() {
    receivedSpeakingSinceConnect = true
  }

  function markStopReceived() {
    receivedStopSinceConnect = true
  }

  function resetSpeakingCompensation() {
    if (compensationTimer) {
      clearTimeout(compensationTimer)
      compensationTimer = null
    }
    compensationAttempts = 0
    receivedSpeakingSinceConnect = false
    receivedStopSinceConnect = false
  }

  function scheduleSpeakingCompensation(addressId: string) {
    if (compensationAttempts >= COMPENSATION_MAX_ATTEMPTS) return
    if (compensationTimer) clearTimeout(compensationTimer)
    compensationTimer = setTimeout(async () => {
      compensationTimer = null
      if (receivedSpeakingSinceConnect) return
      // 已收到过"停止"事件且已重连确认过一轮仍无"正在发言"→ 视为确认无人发言
      if (receivedStopSinceConnect && compensationAttempts >= 1) return
      compensationAttempts++
      console.warn(
        `[Speaking] events 已连接但未确认当前发言状态，主动重连补偿 (第 ${compensationAttempts} 次)`
      )
      await reconnectEventWs(addressId)
    }, COMPENSATION_DELAY_MS)
  }

  const primaryAddressId = ref<string | null>(null)
  const primaryConnected = ref(false)

  let onMessageCallback: ((data: any) => void) | null = null

  // 后台保活标记：events 有连接时启用，全部断开后停用。
  // 与 audioPlayerStore 共用 platform.background（引用计数），互不干扰。
  let eventsKeepAliveActive = false

  function enableKeepAliveIfNeeded() {
    if (connectionConfigs.size > 0 && !eventsKeepAliveActive) {
      eventsKeepAliveActive = true
      getPlatform()
        .background.enable()
        .catch(() => {})
    }
  }

  function disableKeepAliveIfNeeded() {
    if (connectionConfigs.size === 0 && eventsKeepAliveActive) {
      eventsKeepAliveActive = false
      getPlatform()
        .background.disable()
        .catch(() => {})
    }
  }

  // ========== 桌面端跨窗口同步（主窗口 ↔ 浮窗） ==========
  // 浮窗是独立 Tauri 窗口，各自维护独立的 /events 连接与 Pinia state。
  // 主窗口隐藏后 WebView 定时器被节流，连接可能静默断开而不同步。
  // 方案：本地收到 events 原始消息时转发给另一窗口；对端若已有真实连接则忽略
  // （自己会收到原消息，避免重复处理）；另在窗口可见时请求对端状态快照补齐。
  let crossWindowBound = false

  async function tauriEmit(event: string, payload?: any) {
    if (!isTauriDesktop()) return
    try {
      const { emit } = await import('@tauri-apps/api/event')
      await emit(event, payload)
    } catch {
      /* ignore */
    }
  }

  /** 本地事件流收到原始消息 → 转发给另一窗口（仅本地路径转发，避免回环） */
  function forwardMessageToOtherWindow(addressId: string, data: string) {
    if (isTauriDesktop()) tauriEmit('fmo:events-message', { addressId, data })
  }

  /** 仅当本窗口对该地址没有真实连接时应用对端转发的消息 */
  function handleForwardedMessage(addressId: string, data: string) {
    if (!addressId || typeof data !== 'string') return
    const eventsSvc: any = getPlatform().events
    const hasLive =
      typeof eventsSvc.isOpen === 'function'
        ? eventsSvc.isOpen(addressId)
        : statusMap.get(addressId) === 'connected'
    if (hasLive) return
    handleRawMessage(addressId, data)
  }

  /** 把当前已连接地址的发言状态打包为快照，供对端窗口补齐 */
  function buildStateSnapshot() {
    const connections: any[] = []
    for (const addressId of connectionConfigs.keys()) {
      if (statusMap.get(addressId) !== 'connected') continue
      const hist = speakingHistoryMap.get(addressId) || []
      const speaker = currentSpeakerMap.get(addressId) || ''
      let grid = ''
      const active = hist.find((h) => !h.endTime && h.callsign === speaker)
      if (active) grid = active.grid || ''
      const sInfo = serverInfoMap.get(addressId)
      connections.push({
        addressId,
        currentSpeaker: speaker,
        currentGrid: grid,
        currentIsHost: isHostSpeakingMap.get(addressId) || false,
        serverName: sInfo?.name || '',
        history: hist
      })
    }
    return connections
  }

  async function emitEventsStateToOthers() {
    if (!isTauriDesktop()) return
    const connections = buildStateSnapshot()
    if (connections.length === 0) return
    await tauriEmit('fmo:events-state', { connections })
  }

  async function requestCrossWindowState() {
    if (isTauriDesktop()) await tauriEmit('fmo:request-events-state')
  }

  /** 绑定桌面端跨窗口事件（应用生命周期内一次） */
  function installCrossWindowSync() {
    if (!isTauriDesktop() || crossWindowBound) return
    crossWindowBound = true
    import('@tauri-apps/api/event')
      .then(({ listen }) =>
        Promise.all([
          listen('fmo:events-message', (e: any) => {
            const payload = e?.payload || {}
            handleForwardedMessage(payload.addressId, payload.data)
          }),
          listen('fmo:request-events-state', () => {
            emitEventsStateToOthers()
          }),
          listen('fmo:events-state', (e: any) => {
            const payload = e?.payload || {}
            const list = payload.connections || []
            for (const entry of list) applyNativeSnapshot(entry)
          })
        ])
      )
      .catch(() => {})
  }

  // ========== 派生 getter ==========
  const eventsConnected = computed(() => {
    changeCounter.value
    for (const s of statusMap.values()) {
      if (s === 'connected') return true
    }
    return false
  })

  const currentSpeaker = computed(() => {
    if (!primaryAddressId.value) return ''
    return currentSpeakerMap.get(primaryAddressId.value) || ''
  })

  const speakingHistory = computed<SpeakingRecord[]>(() => {
    if (!primaryAddressId.value) return []
    return speakingHistoryMap.get(primaryAddressId.value) || []
  })

  const currentSpeakerGrid = computed(() => {
    if (!primaryAddressId.value) return ''
    const callsign = currentSpeakerMap.get(primaryAddressId.value)
    if (!callsign) return ''
    const hist = speakingHistoryMap.get(primaryAddressId.value) || []
    const rec = hist.find((h) => !h.endTime && h.callsign === callsign)
    return rec?.grid || ''
  })

  const currentSpeakerAddress = computed(() => {
    if (!primaryAddressId.value) return ''
    return speakerAddressMap.get(primaryAddressId.value) || ''
  })

  const isHostSpeaking = computed(() => {
    if (!primaryAddressId.value) return false
    return isHostSpeakingMap.get(primaryAddressId.value) || false
  })

  const primaryServerInfo = computed<ServerInfo | null>(() => {
    if (!primaryAddressId.value) return null
    return serverInfoMap.get(primaryAddressId.value) || null
  })

  const allSpeakingHistories = computed(() => {
    changeCounter.value
    const all: any[] = []
    for (const [addressId, hist] of speakingHistoryMap.entries()) {
      for (const r of hist) all.push({ ...r, addressId })
    }
    return all.sort((a, b) => b.startTime - a.startTime)
  })

  const allCurrentSpeakers = computed(() => {
    changeCounter.value
    const out: any[] = []
    for (const [addressId, callsign] of currentSpeakerMap.entries()) {
      if (callsign) {
        out.push({ addressId, callsign, address: speakerAddressMap.get(addressId) || '' })
      }
    }
    return out
  })

  // ========== 内部：处理 events 原始消息 ==========
  function handleRawMessage(addressId: string, data: string) {
    const cfg = connectionConfigs.get(addressId)
    if (!cfg) return
    const isPrimary = cfg.isPrimary

    const messages = data.split('}{').map((msg, index, arr) => {
      if (arr.length === 1) return msg
      if (index === 0) return msg + '}'
      if (index === arr.length - 1) return '{' + msg
      return '{' + msg + '}'
    })

    let history = speakingHistoryMap.get(addressId)
    if (!history) {
      history = []
      speakingHistoryMap.set(addressId, history)
    }
    let changed = false

    for (const msgStr of messages) {
      try {
        const msg: any = JSON.parse(msgStr)
        if (msg.type === 'qso' && msg.subType === 'callsign' && msg.data) {
          const { callsign, isSpeaking } = msg.data
          if (!msgLogged.includes(`${callsign}|${isSpeaking}`)) {
            msgLogged.push(`${callsign}|${isSpeaking}`)
            if (msgLogged.length <= 30) {
              addDiagnosticLog('info', `收到发言事件: 呼号=${callsign || '(空)'} isSpeaking=${isSpeaking}`)
            }
          }
          const isHost = !!msg.data.isHost
          const now = Date.now()

          if (isSpeaking && callsign) {
            markSpeakingReceived()
            const grid = msg.data.grid || ''
            const currentSpeaker = currentSpeakerMap.get(addressId) || ''
            const activeRecord = history.find((h) => !h.endTime && h.callsign === callsign)
            if (
              currentSpeaker === callsign &&
              activeRecord &&
              now - activeRecord.startTime < DUPLICATE_SPEAKING_EVENT_MS
            ) {
              continue
            }

            if (grid) {
              gridToAddress(grid)
                .then((r: any) => {
                  // 校验当前发言人仍是本呼号，避免异步回包把别的发言人的地址覆盖掉
                  if (currentSpeakerMap.get(addressId) === callsign) {
                    speakerAddressMap.set(addressId, formatAddr(r))
                  }
                })
                .catch(() => {
                  if (currentSpeakerMap.get(addressId) === callsign) {
                    speakerAddressMap.set(addressId, '')
                  }
                })
            } else {
              speakerAddressMap.set(addressId, '')
            }

            history.forEach((h) => {
              if (!h.endTime) h.endTime = now
            })
            currentSpeakerMap.set(addressId, callsign)
            isHostSpeakingMap.set(addressId, isHost)

            const sInfo = serverInfoMap.get(addressId)
            const existingIdx = history.findIndex((h) => h.callsign === callsign)
            if (existingIdx >= 0) {
              const existing = history.splice(existingIdx, 1)[0]
              existing.startTime = now
              existing.endTime = null
              existing.grid = grid
              if (sInfo) {
                existing.serverName = sInfo.name
                existing.serverUid = sInfo.uid
              }
              history.unshift(existing)
            } else {
              const rec: SpeakingRecord = {
                callsign,
                grid,
                startTime: now,
                endTime: null
              }
              if (sInfo) {
                rec.serverName = sInfo.name
                rec.serverUid = sInfo.uid
              }
              history.unshift(rec)
            }
            changed = true
            saveToStorage(addressId, history)
          } else {
            markStopReceived()
            history.forEach((h) => {
              if (!h.endTime) h.endTime = now
            })
            currentSpeakerMap.set(addressId, '')
            isHostSpeakingMap.set(addressId, false)
            changed = true
            saveToStorage(addressId, history)
          }
        } else if (msg.type === 'message' && msg.subType === 'summary') {
          if (isPrimary && onMessageCallback) {
            onMessageCallback(msg.data)
          }
        }
      } catch {
        /* ignore parse error */
      }
    }

    if (changed) {
      speakingHistoryMap.set(addressId, [...history])
      changeCounter.value++
    }
  }

  // ========== 内部：应用原生快照 ==========
  function applyNativeSnapshot(entry: any) {
    if (!entry || !entry.addressId) return
    const { addressId, currentSpeaker, currentGrid, currentIsHost, history: nativeHistory } = entry
    if (!connectionConfigs.has(addressId)) return

    currentSpeakerMap.set(addressId, currentSpeaker || '')
    isHostSpeakingMap.set(addressId, !!currentIsHost)

    if (currentGrid) {
      gridToAddress(currentGrid)
        .then((r: any) => {
          // 校验当前发言人仍是快照中的呼号，避免异步回包错配地址
          if (currentSpeakerMap.get(addressId) === (currentSpeaker || '')) {
            speakerAddressMap.set(addressId, formatAddr(r))
          }
        })
        .catch(() => {
          if (currentSpeakerMap.get(addressId) === (currentSpeaker || '')) {
            speakerAddressMap.set(addressId, '')
          }
        })
    } else {
      speakerAddressMap.set(addressId, '')
    }

    const existing = speakingHistoryMap.get(addressId) || []
    const sInfo = serverInfoMap.get(addressId)
    const merged = new Map<string, SpeakingRecord>()

    function toRecord(h: any): SpeakingRecord {
      const rec: SpeakingRecord = {
        callsign: h.callsign,
        grid: h.grid || '',
        startTime: h.startTime,
        endTime: h.endTime == null ? null : h.endTime
      }
      // 优先保留记录自带的服务器名（JS 侧已按事件到达时的中继打标、
      // 原生快照持久化后也带 serverName），只有缺失时才回退当前连接的中继，
      // 避免切换中继后被统一覆盖成当前中继名。
      const serverName = h.serverName || (sInfo ? sInfo.name : '') || ''
      const serverUid = h.serverUid || (sInfo ? sInfo.uid : '') || ''
      if (serverName) {
        rec.serverName = serverName
        rec.serverUid = serverUid
      }
      return rec
    }

    function mergeRecord(a: SpeakingRecord | undefined, b: SpeakingRecord): SpeakingRecord {
      if (!a) return b
      // 优先保留带明确中继名的记录，避免无中继名（原生旧数据）覆盖正确中继名；
      // 二者相同则保留更新的记录。
      const aHas = !!a.serverName
      const bHas = !!b.serverName
      if (aHas !== bHas) return aHas ? a : b
      return (b.startTime || 0) >= (a.startTime || 0) ? b : a
    }

    // 永久保存通联记录：快照合并不做时间清理
    for (const h of nativeHistory || []) {
      merged.set(h.callsign, mergeRecord(merged.get(h.callsign), toRecord(h)))
    }
    for (const h of existing) {
      merged.set(h.callsign, mergeRecord(merged.get(h.callsign), toRecord(h)))
    }

    const list = Array.from(merged.values()).sort((a, b) => b.startTime - a.startTime)
    speakingHistoryMap.set(addressId, list)
    saveToStorage(addressId, list)
    changeCounter.value++
  }

  async function syncFromNativeSnapshot(addressId?: string) {
    if (!hasNativeEvents) return
    try {
      const snap = await getPlatform().events.getSnapshot(addressId)
      for (const entry of snap.connections || []) applyNativeSnapshot(entry)
    } catch (err) {
      console.warn('[Events] syncFromNativeSnapshot failed', err)
    }
  }

  // ========== 内部：订阅 platform.events ==========
  function installListeners() {
    if (listenersInstalled) return
    listenersInstalled = true
    const p = getPlatform()

    unsubMsg = p.events.onMessage((addressId, data) => {
      handleRawMessage(addressId, data)
      // 桌面端：转发给另一窗口（浮窗/主窗口），对端按需应用
      forwardMessageToOtherWindow(addressId, data)
    })

    unsubStatus = p.events.onStatus((addressId, status) => {
      const cfg = connectionConfigs.get(addressId)
      statusMap.set(addressId, status)
      changeCounter.value++
      if (cfg?.isPrimary) {
        addDiagnosticLog('info', `events 状态变化: ${addressId} → ${status}`)
      }
      if (status === 'connected') {
        if (cfg?.isPrimary) primaryConnected.value = true
        if (hasNativeEvents) syncFromNativeSnapshot(addressId)
        // 连接成功但收不到当前发言状态时，主动重连一次让 FMO 补推当前状态
        scheduleSpeakingCompensation(addressId)
      } else if (status === 'reconnecting') {
        if (cfg?.isPrimary) primaryConnected.value = false
      } else if (status === 'disconnected') {
        if (cfg?.isPrimary) primaryConnected.value = false
      }
    })

    unsubInfo = p.events.onServerInfo((addressId, info) => {
      serverInfoMap.set(addressId, info)
      changeCounter.value++
    })

    if (!visibilityBound) {
      document.addEventListener('visibilitychange', onVisibilityChange)
      visibilityBound = true
    }

    // 桌面端：跨窗口同步（消息转发 + 状态快照）
    installCrossWindowSync()
  }

  function onVisibilityChange() {
    if (document.visibilityState !== 'visible') return
    // 原生端：从原生侧快照恢复后台期间累积的状态
    if (hasNativeEvents) syncFromNativeSnapshot()
    // 桌面端：请求另一窗口的当前状态，补齐隐藏期间丢失的数据
    requestCrossWindowState()
    // 回到前台：连接着但还没确认当前发言状态时，重新触发补偿，避免后台期间
    // 错过了实时事件导致一直停在"无人发言"
    for (const addressId of connectionConfigs.keys()) {
      if (statusMap.get(addressId) === 'connected' && !currentSpeakerMap.get(addressId)) {
        scheduleSpeakingCompensation(addressId)
      }
    }
  }

  function pushCachedServerNameIfAny(addressId: string) {
    if (!hasNativeEvents || !addressId) return
    const info = serverInfoMap.get(addressId)
    const name = info?.name || ''
    if (!name) return
    getPlatform().events.updateServerName(addressId, name)
  }

  // ========== 公共 actions ==========
  function buildWsUrl(host: string, protocol: string) {
    const normalizedHost = normalizeHost(host)
    return {
      wsUrl: buildWebSocketUrl(normalizedHost, protocol, '/events'),
      // 完整的 station WebSocket URL，调用端直接使用，不再自行拼接 /ws
      apiUrl: buildWebSocketUrl(normalizedHost, protocol, '/ws')
    }
  }

  function connectEventWs(host: string, protocol: string) {
    if (!host) return
    installListeners()
    const addressId = 'single'
    // 若已连接/连接中，忽略
    if (statusMap.get(addressId) === 'connected') {
      if (hasNativeEvents) syncFromNativeSnapshot(addressId)
      return
    }

    resetSpeakingCompensation()
    primaryAddressId.value = addressId
    connectionConfigs.set(addressId, { host, protocol, isPrimary: true })
    speakingHistoryMap.set(addressId, loadFromStorage(addressId))

    if (hasNativeEvents) {
      pushCachedServerNameIfAny(addressId)
      getPlatform().events.setPrimary(addressId)
    }
    const { wsUrl, apiUrl } = buildWsUrl(host, protocol)
    getPlatform()
      .events.connect({ addressId, url: wsUrl, apiUrl })
      .catch((err) => {
        console.warn(`[${addressId}] connect failed`, err)
      })
    // events 有连接 → 启用后台保活
    enableKeepAliveIfNeeded()
  }

  function disconnectEventWs(addressId: string) {
    resetSpeakingCompensation()
    connectionConfigs.delete(addressId)
    getPlatform()
      .events.disconnect(addressId)
      .catch(() => {})

    currentSpeakerMap.delete(addressId)
    speakingHistoryMap.delete(addressId)
    speakerAddressMap.delete(addressId)
    isHostSpeakingMap.delete(addressId)
    serverInfoMap.delete(addressId)
    statusMap.delete(addressId)

    if (addressId === primaryAddressId.value) {
      primaryConnected.value = false
      primaryAddressId.value = null
      if (hasNativeEvents) getPlatform().events.setPrimary('')
    }
    changeCounter.value++
    // 最后一个 events 连接断开 → 关闭后台保活
    disableKeepAliveIfNeeded()
  }

  function connectMultipleEventWs(
    addresses: Array<{ id: string; host: string; protocol: string }>,
    primaryId: string
  ) {
    if (!addresses || addresses.length === 0) return
    installListeners()

    // 先断开所有旧连接
    disconnectAllEventWs()
    primaryAddressId.value = primaryId

    if (hasNativeEvents) {
      pushCachedServerNameIfAny(primaryId)
      getPlatform().events.setPrimary(primaryId || '')
    }

    for (const addr of addresses) {
      const isPrimary = addr.id === primaryId
      connectionConfigs.set(addr.id, { host: addr.host, protocol: addr.protocol, isPrimary })
      speakingHistoryMap.set(addr.id, loadFromStorage(addr.id))
      const { wsUrl, apiUrl } = buildWsUrl(addr.host, addr.protocol)
      getPlatform()
        .events.connect({ addressId: addr.id, url: wsUrl, apiUrl })
        .catch((err) => console.warn(`[${addr.id}] connect failed`, err))
    }
    // events 有连接 → 启用后台保活
    enableKeepAliveIfNeeded()
  }

  function disconnectAllEventWs() {
    resetSpeakingCompensation()
    getPlatform()
      .events.disconnectAll()
      .catch(() => {})

    connectionConfigs.clear()
    currentSpeakerMap.clear()
    speakingHistoryMap.clear()
    speakerAddressMap.clear()
    isHostSpeakingMap.clear()
    serverInfoMap.clear()
    statusMap.clear()

    primaryConnected.value = false
    primaryAddressId.value = null
    if (hasNativeEvents) getPlatform().events.setPrimary('')
    changeCounter.value++
    // 全部断开 → 关闭后台保活
    disableKeepAliveIfNeeded()
  }

  function getSpeakingHistoryFor(addressId: string): SpeakingRecord[] {
    return speakingHistoryMap.get(addressId) || []
  }

  function isAddressConnected(addressId: string): boolean {
    return statusMap.get(addressId) === 'connected'
  }

  async function getServerInfo(
    addressId: string,
    forceRefresh = false
  ): Promise<ServerInfo | null> {
    if (forceRefresh) {
      await getPlatform().events.refreshServerInfo(addressId)
    }
    return serverInfoMap.get(addressId) || null
  }

  function updateServerInfo(addressId: string, info: ServerInfo) {
    if (info && info.uid) {
      serverInfoMap.set(addressId, { ...info, uid: info.uid, name: info.name || '' })
      changeCounter.value++
      // 不在这里主动推原生 updateServerName：原生侧有自己的 serverInfo 轮询 +
      // refreshServerInfo 立即刷新，避免切换中继时额外的原生调用干扰切换流程。
    }
  }

  function setOnMessageCallback(cb: ((data: any) => void) | null) {
    onMessageCallback = cb
  }

  function clearSpeakingHistory() {
    for (const addressId of Array.from(currentSpeakerMap.keys())) {
      currentSpeakerMap.set(addressId, '')
    }
    for (const addressId of Array.from(speakingHistoryMap.keys())) {
      speakingHistoryMap.set(addressId, [])
      saveToStorage(addressId, [])
    }
    changeCounter.value++
  }

  /**
   * 关闭指定（默认主）地址当前“正在发言”的记录并清空当前发言人，
   * 保留已结束的历史。用于切换服务器等场景，避免当前呼叫卡片继续
   * 停留在切换前的旧呼号上，等事件流推送新事件后重新建立当前状态。
   */
  function closeCurrentSpeaker(addressId?: string) {
    const id = addressId || primaryAddressId.value || 'single'
    const history = speakingHistoryMap.get(id)
    const now = Date.now()
    let changed = false
    if (history && history.length > 0) {
      let needsUpdate = false
      for (const h of history) {
        if (!h.endTime) {
          h.endTime = now
          needsUpdate = true
        }
      }
      if (needsUpdate) {
        speakingHistoryMap.set(id, [...history])
        saveToStorage(id, history)
        changed = true
      }
    }
    if (currentSpeakerMap.get(id)) {
      currentSpeakerMap.set(id, '')
      isHostSpeakingMap.set(id, false)
      changed = true
    }
    if (changed) changeCounter.value++
  }

  function refreshSnapshot(addressId?: string) {
    return syncFromNativeSnapshot(addressId)
  }

  async function reconnectEventWs(addressId?: string) {
    const id = addressId || primaryAddressId.value || 'single'
    const cfg = connectionConfigs.get(id)
    if (!cfg) return

    statusMap.set(id, 'reconnecting')
    if (cfg.isPrimary) primaryConnected.value = false
    changeCounter.value++

    try {
      await getPlatform().events.disconnect(id)
    } catch {
      /* ignore */
    }
    // 短暂断开再重连：让服务端感知订阅真正断开，以全新订阅接入，FMO 才会补推当前发言状态
    await new Promise((r) => setTimeout(r, 800))

    if (hasNativeEvents) {
      pushCachedServerNameIfAny(id)
      await getPlatform().events.setPrimary(cfg.isPrimary ? id : '')
    }

    const { wsUrl, apiUrl } = buildWsUrl(cfg.host, cfg.protocol)
    try {
      await getPlatform().events.connect({ addressId: id, url: wsUrl, apiUrl })
      if (hasNativeEvents) await syncFromNativeSnapshot(id)
    } catch (err) {
      console.warn(`[${id}] reconnect failed`, err)
    }
  }

  return {
    // 响应式 state / computed
    primaryAddressId,
    primaryConnected,
    eventsConnected,
    currentSpeaker,
    currentSpeakerGrid,
    currentSpeakerAddress,
    isHostSpeaking,
    speakingHistory,
    primaryServerInfo,
    allSpeakingHistories,
    allCurrentSpeakers,

    // actions
    connectEventWs,
    disconnectEventWs,
    connectMultipleEventWs,
    disconnectAllEventWs,
    getSpeakingHistoryFor,
    isAddressConnected,
    getServerInfo,
    updateServerInfo,
    setOnMessageCallback,
    clearSpeakingHistory,
    closeCurrentSpeaker,
    refreshSnapshot,
    reconnectEventWs
  }
})
