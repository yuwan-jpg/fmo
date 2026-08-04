/**
 * 后台保活与唤醒锁抽象。
 * - Android：专用前台服务 FmoKeepAliveService + PARTIAL_WAKE_LOCK
 * - Web / Tauri 桌面：WakeLock / 无操作（no-op）
 */
export interface IBackgroundService {
  /** 进入后台保活（例如音频播放 / events 连接时调用） */
  enable(): Promise<void>
  /** 退出后台保活 */
  disable(): Promise<void>
  /** 更新保活通知栏标题 / 文案（可选） */
  update?(title?: string, text?: string): Promise<void>
}
