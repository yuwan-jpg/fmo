import type { IBackgroundService } from '../interfaces/IBackgroundService'
import { registerPlugin } from '@capacitor/core'

interface FmoKeepAlivePlugin {
  enable(opts?: { title?: string; text?: string }): Promise<void>
  disable(): Promise<void>
  update(opts?: { title?: string; text?: string }): Promise<void>
  isActive(): Promise<{ active: boolean }>
}

const FmoKeepAlive = registerPlugin<FmoKeepAlivePlugin>('FmoKeepAlive')

const DEFAULT_TITLE = 'FMO 运行中'
const DEFAULT_TEXT = '保持后台连接'

/**
 * Android 原生后台保活。
 *
 * 通过专用前台服务 FmoKeepAliveService（SPECIAL_USE 类型 + PARTIAL_WAKE_LOCK）
 * 把进程挂到前台，防止息屏 / 切后台后被系统回收，不依赖麦克风权限。
 *
 * enable / disable 采用引用计数：允许多个调用方（音频播放、events 连接）
 * 同时启用保活，只有全部退出后才会真正停止前台服务。
 */
export class NativeBackgroundService implements IBackgroundService {
  private refCount = 0

  async enable(): Promise<void> {
    this.refCount++
    if (this.refCount > 1) return
    try {
      await FmoKeepAlive.enable({ title: DEFAULT_TITLE, text: DEFAULT_TEXT })
    } catch (e) {
      console.debug('[NativeBackgroundService] enable 失败:', e)
      this.refCount = Math.max(0, this.refCount - 1)
    }
  }

  async disable(): Promise<void> {
    if (this.refCount <= 0) return
    this.refCount--
    if (this.refCount > 0) return
    try {
      await FmoKeepAlive.disable()
    } catch (e) {
      console.debug('[NativeBackgroundService] disable 失败:', e)
    }
  }

  async update(title?: string, text?: string): Promise<void> {
    try {
      await FmoKeepAlive.update({ title, text })
    } catch {
      /* ignore */
    }
  }
}
