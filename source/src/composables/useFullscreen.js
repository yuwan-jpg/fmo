import { ref, onMounted, onUnmounted } from "vue";
import { isTauriDesktop } from "../utils/desktopBridge";

/**
 * 全屏切换。
 * - Tauri 桌面版：原生窗口全屏（@tauri-apps/api/window）
 * - 浏览器/网页版：Web Fullscreen API
 */
export function useFullscreen() {
  const isFullscreen = ref(false);

  async function updateState() {
    if (isTauriDesktop()) {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        isFullscreen.value = await getCurrentWindow().isFullscreen();
      } catch {
        /* 忽略 */
      }
      return;
    }
    if (typeof document !== "undefined") {
      isFullscreen.value = Boolean(document.fullscreenElement);
    }
  }

  async function toggleFullscreen() {
    if (isTauriDesktop()) {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const win = getCurrentWindow();
        const next = !(await win.isFullscreen());
        await win.setFullscreen(next);
        isFullscreen.value = next;
      } catch (err) {
        console.warn("切换全屏失败:", err);
      }
      return;
    }

    // 浏览器/网页版
    if (typeof document === "undefined") return;
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await document.documentElement.requestFullscreen();
      }
    } catch (err) {
      console.warn("切换全屏失败:", err);
    }
    isFullscreen.value = Boolean(document.fullscreenElement);
  }

  onMounted(() => {
    updateState();
    if (!isTauriDesktop() && typeof document !== "undefined") {
      document.addEventListener("fullscreenchange", updateState);
    }
  });
  onUnmounted(() => {
    if (typeof document !== "undefined") {
      document.removeEventListener("fullscreenchange", updateState);
    }
  });

  return { isFullscreen, toggleFullscreen };
}
