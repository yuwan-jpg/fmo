import packageInfo from "../../package.json";
import { addDiagnosticLog } from "../services/diagnosticLog";

const LAST_MARKER_KEY = "fmo_last_cache_marker";
// 缓存代次：缓存数据语义/格式变化时 +1，触发一次性清理。
// 版本升级或重装后旧的本地缓存（网格地址、发言历史）会残留导致界面显示旧数据，
// 因此只要版本号或本代次变化就自动清空临时缓存。
const CACHE_EPOCH = "2";

function clearLocalStorageCaches() {
  const removed = [];
  try {
    const keysToRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (
        key &&
        (key.startsWith("fmo_speaking_history_") ||
          key === "fmo_dashboard_voice_history")
      ) {
        keysToRemove.push(key);
      }
    }
    for (const key of keysToRemove) {
      localStorage.removeItem(key);
    }
    return keysToRemove;
  } catch (err) {
    console.warn("[CacheReset] 清理 localStorage 缓存失败:", err);
    return removed;
  }
}

/**
 * 版本/代次变化时清理临时缓存（网格地址 IndexedDB、发言历史 localStorage 等）。
 * 需在应用挂载前调用，同步部分立即执行，IndexedDB 清理在后台完成。
 */
export async function resetTransientCachesIfVersionChanged() {
  const marker = `${packageInfo.version}|${CACHE_EPOCH}`;

  let stored = "";
  try {
    stored = localStorage.getItem(LAST_MARKER_KEY) || "";
  } catch {
    stored = "";
  }
  if (stored === marker) return;

  // 1) 同步先清 localStorage 临时缓存（避免与后续异步 IndexedDB 清理竞态）
  const removed = clearLocalStorageCaches();

  // 2) 立即记录标记，避免每次启动重复清理
  try {
    localStorage.setItem(LAST_MARKER_KEY, marker);
  } catch {
    /* ignore */
  }

  const cleared =
    removed.length > 0 ? [`localStorage(${removed.join(",")})`] : [];

  // 3) 后台清 IndexedDB 网格地址缓存
  try {
    const { clearGridCache } = await import("../services/gridService");
    await clearGridCache();
    cleared.push("gridCache");
  } catch (err) {
    console.warn("[CacheReset] 清理网格缓存失败:", err);
  }

  if (cleared.length > 0) {
    addDiagnosticLog("info", "检测到版本/缓存代次变化，已清理本地缓存", {
      from: stored || "(无)",
      to: marker,
      cleared,
    });
  }
}
