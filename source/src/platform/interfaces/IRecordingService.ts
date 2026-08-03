// 录音服务抽象：录制接收到的电台音频流（8kHz PCM → WAV）。
// - Web / Tauri：从音频播放器原始 PCM 分片录制，存 IndexedDB，浏览器内回放
// - Android：FmoRecordingPlugin 原生录制到应用外部目录，MediaPlayer 回放
//
// 手动/自动两种模式共用同一台录音机（同一时间只录一路）。
export interface RecordingItem {
  /** 唯一标识（Android 为文件名，Web 为自增 id） */
  id: string
  fileName: string
  callsign: string
  serverName: string
  /** 开始时间戳（ms） */
  startTime: number
  /** 时长（秒） */
  durationSec: number
  /** 文件大小（字节） */
  sizeBytes: number
  source: 'manual' | 'auto'
}

export interface RecordingStartOptions {
  callsign: string
  serverName: string
  source: 'manual' | 'auto'
}

export interface IRecordingService {
  /** 当前是否在录音 */
  isRecording(): boolean

  /**
   * 开始录制。已在录制时返回 false（避免手动/自动互相覆盖）。
   * Web 端需音频播放器连接中才有数据；Android 同理需音频流已连接。
   */
  startRecording(opts: RecordingStartOptions): Promise<boolean>

  /** 停止录制并保存为 WAV 文件；无进行中录制返回 null */
  stopRecording(): Promise<RecordingItem | null>

  /** 列出本地全部录音（按开始时间倒序） */
  listRecordings(): Promise<RecordingItem[]>

  /** 删除一条录音 */
  deleteRecording(id: string): Promise<void>

  /** 回放某条录音（自动停止上一段） */
  playRecording(id: string): Promise<void>

  /** 停止回放 */
  stopPlayback(): Promise<void>

  /** 订阅"某段录音自然播放结束"（用于列表连续播放；手动停止不触发） */
  onPlaybackEnded(cb: () => void): () => void

  /**
   * 设置"始终录制（有声音就录）"：按音频电平自动开始/结束分段。
   * 需要音频流正在播放才有数据。Web 用 VAD 状态机；Android 由原生 FmoWavRecorder 处理。
   */
  setAlwaysRecord(enabled: boolean): Promise<void>

  /** 设置自动分段时使用的呼号/服务器名取数器（Web 用于 VAD 分段命名；原生由 events 提供） */
  setSegmentLabelProvider?(fn: (() => { callsign: string; serverName: string }) | null): void

  /**
   * 强制切段：结束当前录音段并重置 VAD 状态机，使下一次发声作为新段开始。
   * 用于在"始终录制"模式下按发言人呼号切换精确分段，避免上一人结尾混入下一段。
   */
  forceSplitSegment?(): Promise<void>

  /** 录音列表/状态变化订阅（新增、删除、开始、结束） */
  onRecordingChanged(cb: () => void): () => void
}
