// 录音核心纯函数：WAV 编码、文件名生成、时长格式化。
// 不依赖 Vue / Pinia / 平台代码，可在任意平台复用。

export const RECORD_SAMPLE_RATE = 8000
export const RECORD_CHANNELS = 1
export const RECORD_BITS_PER_SAMPLE = 16
/** 每秒字节数 = 采样率 × 声道 × 字节/采样 */
export const RECORD_BYTES_PER_SEC = RECORD_SAMPLE_RATE * RECORD_CHANNELS * (RECORD_BITS_PER_SAMPLE / 8)

/** 生成 44 字节 WAV 头（PCM / 8kHz / 单声道 / 16bit）。dataSize 为 PCM 数据字节数。 */
export function buildWavHeader(dataSize: number): ArrayBuffer {
  const buf = new ArrayBuffer(44)
  const dv = new DataView(buf)
  const writeString = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) dv.setUint8(offset + i, s.charCodeAt(i))
  }
  writeString(0, 'RIFF')
  dv.setUint32(4, 36 + dataSize, true)
  writeString(8, 'WAVE')
  writeString(12, 'fmt ')
  dv.setUint32(16, 16, true) // fmt 块大小
  dv.setUint16(20, 1, true) // PCM
  dv.setUint16(22, RECORD_CHANNELS, true)
  dv.setUint32(24, RECORD_SAMPLE_RATE, true)
  dv.setUint32(28, RECORD_SAMPLE_RATE * RECORD_CHANNELS * (RECORD_BITS_PER_SAMPLE / 8), true)
  dv.setUint16(32, RECORD_CHANNELS * (RECORD_BITS_PER_SAMPLE / 8), true)
  dv.setUint16(34, RECORD_BITS_PER_SAMPLE, true)
  writeString(36, 'data')
  dv.setUint32(40, dataSize, true)
  return buf
}

/** Int16 PCM 数据 → WAV Blob（8kHz / 单声道 / 16bit） */
export function encodeWavBlob(pcm: Int16Array): Blob {
  const dataSize = pcm.byteLength
  const header = buildWavHeader(dataSize)
  const body = new Uint8Array(dataSize)
  body.set(new Uint8Array(pcm.buffer, pcm.byteOffset, dataSize))
  return new Blob([header, body], { type: 'audio/wav' })
}

/** 生成录音文件名：呼号_服务器_yyyyMMdd_HHmmss.wav */
export function buildRecordingFileName(callsign: string, serverName: string, ts: number): string {
  const safe = (s: string) =>
    String(s || '')
      .replace(/[\\/:*?"<>|\s]+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40)
  const cs = safe(callsign) || 'UNKNOWN'
  const sn = safe(serverName) || 'FMO'
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  const time = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(
    d.getHours()
  )}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  return `${cs}_${sn}_${time}.wav`
}

/** 秒 → mm:ss 显示文本 */
export function formatDurationSec(sec: number): string {
  const s = Math.max(0, Math.floor(sec || 0))
  const m = Math.floor(s / 60)
  const r = s % 60
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`
}

/**
 * 语音活动检测（VAD）分段器：根据接收音频的 RMS 电平判断"有声音就录"。
 * 纯状态机，不依赖平台：
 *  - 静音 → 连续有声音超过 startHangMs 输出 'start'
 *  - 录音中 → 连续静音超过 stopHangMs 输出 'stop'
 *
 * 针对电台背景噪声做过自适应处理：
 *  - 阈值取"底噪(近期低分位 RMS) × 系数"与最小阈值的较大者，
 *    避免背景噪声/载波常驻导致永远判不出说话结束。
 *  - 单段最长 maxSegmentSec 强制切段，即使长时间无静音也不会把所有人录成一段。
 */
export class VadSegmenter {
  private baseThreshold: number
  private startHangMs: number
  private stopHangMs: number
  private maxSegmentMs: number
  private soundMs = 0
  private silenceMs = 0
  private active = false
  private activeMs = 0

  // 自适应底噪估计：维护近期 RMS 样本，取低分位作为底噪
  private levelHistory: number[] = []
  private static readonly HISTORY_SIZE = 40
  private static readonly NOISE_PERCENTILE = 0.25
  private static readonly NOISE_FACTOR = 2.5
  private static readonly THRESHOLD_CAP = 5000

  constructor(opts?: {
    threshold?: number
    startHangMs?: number
    stopHangMs?: number
    maxSegmentSec?: number
  }) {
    this.baseThreshold = opts?.threshold ?? 600
    this.startHangMs = opts?.startHangMs ?? 300
    this.stopHangMs = opts?.stopHangMs ?? 1200
    this.maxSegmentMs = (opts?.maxSegmentSec ?? 120) * 1000
  }

  /** 计算一段 Int16 PCM 的 RMS */
  static rms(int16: Int16Array): number {
    if (!int16 || int16.length === 0) return 0
    let sum = 0
    for (let i = 0; i < int16.length; i++) sum += int16[i] * int16[i]
    return Math.sqrt(sum / int16.length)
  }

  get isActive(): boolean {
    return this.active
  }

  /** 当前使用的判定阈值（随底噪自适应变化） */
  get threshold(): number {
    const floor = this.estimateNoiseFloor()
    return Math.min(
      VadSegmenter.THRESHOLD_CAP,
      Math.max(this.baseThreshold, floor * VadSegmenter.NOISE_FACTOR)
    )
  }

  private estimateNoiseFloor(): number {
    if (this.levelHistory.length === 0) return 0
    const sorted = [...this.levelHistory].sort((a, b) => a - b)
    const idx = Math.min(
      this.levelHistory.length - 1,
      Math.floor(this.levelHistory.length * VadSegmenter.NOISE_PERCENTILE)
    )
    return sorted[idx]
  }

  private recordLevel(rms: number): void {
    this.levelHistory.push(rms)
    if (this.levelHistory.length > VadSegmenter.HISTORY_SIZE) {
      this.levelHistory.shift()
    }
  }

  /** 喂入一段 PCM，返回动作 */
  feed(int16: Int16Array): 'start' | 'stop' | null {
    if (!int16 || int16.length === 0) return null
    const rms = VadSegmenter.rms(int16)
    this.recordLevel(rms)
    const chunkMs = (int16.length / RECORD_SAMPLE_RATE) * 1000
    const thr = this.threshold
    if (rms >= thr) {
      this.soundMs += chunkMs
      this.silenceMs = 0
    } else {
      this.silenceMs += chunkMs
      this.soundMs = 0
    }
    if (!this.active) {
      if (this.soundMs >= this.startHangMs) {
        this.active = true
        this.silenceMs = 0
        this.activeMs = 0
        return 'start'
      }
    } else {
      this.activeMs += chunkMs
      // 单段达到最大时长强制切段，避免长时间无静音录成一段
      if (this.activeMs >= this.maxSegmentMs) {
        this.active = false
        this.soundMs = 0
        return 'stop'
      }
      if (this.silenceMs >= this.stopHangMs) {
        this.active = false
        this.soundMs = 0
        return 'stop'
      }
    }
    return null
  }

  reset(): void {
    this.soundMs = 0
    this.silenceMs = 0
    this.activeMs = 0
    this.active = false
    this.levelHistory = []
  }
}

/**
 * 内存中的 WAV 分段录音器：收集 Int16 PCM 分片，stop 时生成 WAV Blob。
 * 用于 Web / Tauri 桌面端（数据源为音频播放器的原始 PCM 流）。
 */
export class WavSegmentRecorder {
  private chunks: Int16Array[] = []
  private sampleCount = 0
  private startedAt = 0

  constructor() {
    this.startedAt = Date.now()
  }

  /** 喂入一段 Int16 PCM 数据 */
  feed(int16: Int16Array): void {
    if (!int16 || int16.length === 0) return
    this.chunks.push(int16)
    this.sampleCount += int16.length
  }

  /** 在开头插入一段或多段历史 PCM（用于 VAD 预卷，避免截掉话音开头） */
  prependInt16(chunks: Int16Array[]): void {
    if (!chunks || chunks.length === 0) return
    let total = 0
    for (const c of chunks) {
      if (c && c.length) total += c.length
    }
    if (total === 0) return
    this.chunks.unshift(...chunks)
    this.sampleCount += total
  }

  get durationSec(): number {
    return this.sampleCount / RECORD_SAMPLE_RATE
  }

  get startedAtMs(): number {
    return this.startedAt
  }

  get byteLength(): number {
    return this.sampleCount * 2
  }

  /** 结束并生成 WAV Blob */
  finish(): Blob | null {
    if (this.sampleCount === 0) return null
    const pcm = new Int16Array(this.sampleCount)
    let offset = 0
    for (const c of this.chunks) {
      pcm.set(c, offset)
      offset += c.length
    }
    this.chunks = []
    return encodeWavBlob(pcm)
  }

  cancel(): void {
    this.chunks = []
    this.sampleCount = 0
  }
}
