import { registerPlugin } from '@capacitor/core'
import type {
  IRecordingService,
  RecordingItem,
  RecordingStartOptions
} from '../interfaces/IRecordingService'

interface FmoRecordingPlugin {
  start(opts: { callsign?: string; serverName?: string; source?: string }): Promise<void>
  stop(): Promise<RecordingItem | null>
  isActive(): Promise<{ active: boolean }>
  list(): Promise<{ recordings: RecordingItem[] }>
  delete(opts: { id: string }): Promise<void>
  play(opts: { id: string }): Promise<void>
  stopPlayback(): Promise<void>
  setAlwaysRecord(opts: { enabled: boolean }): Promise<void>
  addListener(event: string, cb: (data: any) => void): Promise<{ remove: () => Promise<void> }>
}

const FmoRecording = registerPlugin<FmoRecordingPlugin>('FmoRecording')

/**
 * Android 原生录音服务。录制由原生 FmoAudioPlugin + FmoWavRecorder 完成
 * （旁路原始接收流），本服务只做 JS 桥接与状态缓存。
 */
export class NativeRecordingService implements IRecordingService {
  private recording = false
  private listeners = new Set<() => void>()
  private endedListeners = new Set<() => void>()
  private bound = false

  private bind() {
    if (this.bound) return
    this.bound = true
    FmoRecording.addListener('recordingChanged', () => this.emitChanged()).catch(() => {})
    FmoRecording.addListener('playbackChanged', () => this.emitChanged()).catch(() => {})
    FmoRecording.addListener('playbackEnded', () => this.emitPlaybackEnded()).catch(() => {})
  }

  onPlaybackEnded(cb: () => void): () => void {
    this.bind()
    this.endedListeners.add(cb)
    return () => this.endedListeners.delete(cb)
  }

  private emitPlaybackEnded() {
    for (const cb of this.endedListeners) {
      try {
        cb()
      } catch {
        /* ignore */
      }
    }
  }

  isRecording(): boolean {
    return this.recording
  }

  async startRecording(opts: RecordingStartOptions): Promise<boolean> {
    if (this.recording) return false
    try {
      const { active } = await FmoRecording.isActive()
      if (active) return false
      await FmoRecording.start({
        callsign: opts.callsign || '',
        serverName: opts.serverName || '',
        source: opts.source || 'manual'
      })
      this.recording = true
      this.emitChanged()
      return true
    } catch (e) {
      console.warn('[Recording] start 失败:', e)
      return false
    }
  }

  async stopRecording(): Promise<RecordingItem | null> {
    if (!this.recording) {
      // 原生可能仍在录（如进程重启后），尝试收尾
      try {
        const { active } = await FmoRecording.isActive()
        if (!active) return null
      } catch {
        return null
      }
    }
    this.recording = false
    this.emitChanged()
    try {
      const item = await FmoRecording.stop()
      return item || null
    } catch (e) {
      console.warn('[Recording] stop 失败:', e)
      return null
    }
  }

  async listRecordings(): Promise<RecordingItem[]> {
    try {
      const { recordings } = await FmoRecording.list()
      return (recordings || []).sort((a, b) => b.startTime - a.startTime)
    } catch (e) {
      console.warn('[Recording] list 失败:', e)
      return []
    }
  }

  async deleteRecording(id: string): Promise<void> {
    try {
      await FmoRecording.delete({ id })
      this.emitChanged()
    } catch (e) {
      console.warn('[Recording] delete 失败:', e)
    }
  }

  async playRecording(id: string): Promise<void> {
    try {
      await FmoRecording.play({ id })
      this.emitChanged()
    } catch (e) {
      console.warn('[Recording] play 失败:', e)
    }
  }

  async stopPlayback(): Promise<void> {
    try {
      await FmoRecording.stopPlayback()
      this.emitChanged()
    } catch {
      /* ignore */
    }
  }

  async setAlwaysRecord(enabled: boolean): Promise<void> {
    try {
      await FmoRecording.setAlwaysRecord({ enabled })
    } catch (e) {
      console.warn('[Recording] setAlwaysRecord 失败:', e)
    }
  }

  setSegmentLabelProvider(): void {
    /* Android 由原生 FmoEventsPlugin 提供分段呼号/服务器名，无需 JS 侧 */
  }

  onRecordingChanged(cb: () => void): () => void {
    this.bind()
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  private emitChanged() {
    for (const cb of this.listeners) {
      try {
        cb()
      } catch {
        /* ignore */
      }
    }
  }
}
