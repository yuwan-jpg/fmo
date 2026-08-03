// 发言状态相关 DTO 与事件类型

export interface ServerInfo {
  uid: string
  name: string
  [k: string]: any
}

export interface SpeakingRecord {
  callsign: string
  grid?: string
  startTime: number
  endTime?: number
  // 发言发生时所在中继（服务器）名称与 uid，切换中继后不回改
  serverName?: string
  serverUid?: string
  // 其它历史字段（地址、序号等）以松散结构承载，保留扩展空间
  [k: string]: any
}

export type EventsStatus = 'connected' | 'reconnecting' | 'disconnected'

export interface EventsSnapshotConnection {
  addressId: string
  status: EventsStatus
  currentSpeaker?: string
  history?: SpeakingRecord[]
  serverInfo?: ServerInfo
}

export interface EventsSnapshot {
  connections: EventsSnapshotConnection[]
}
