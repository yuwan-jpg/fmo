import { isTauriDesktop } from "./desktopBridge";

export const FLOAT_WINDOW_LABEL = "fmo-float";
export const MAIN_WINDOW_LABEL = "main";
export const FLOAT_MODE_KEY = "fmo_float_mode";

async function getWindow(label) {
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  return WebviewWindow.getByLabel(label);
}

/** 是否支持浮窗（仅 Tauri 桌面端） */
export function isDesktopFloatSupported() {
  return isTauriDesktop();
}

/**
 * 确保浮窗存在并显示（不存在则创建）。
 * 浮窗独立连接 FMO events，即使主窗口隐藏也能实时更新。
 */
export async function ensureFloatWindow() {
  if (!isTauriDesktop()) return null;

  let win = await getWindow(FLOAT_WINDOW_LABEL);
  if (win) {
    try {
      await win.show();
    } catch {
      /* ignore */
    }
    try {
      await win.unminimize();
    } catch {
      /* ignore */
    }
    try {
      await win.setFocus();
    } catch {
      /* ignore */
    }
    return win;
  }

  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const { currentMonitor } = await import("@tauri-apps/api/window");
  let x = null;
  let y = null;
  try {
    const monitor = await currentMonitor();
    if (monitor) {
      x = Math.round(monitor.position.x + monitor.size.width - 320);
      y = Math.round(monitor.position.y + monitor.size.height - 440);
    }
  } catch {
    /* 定位失败则居中 */
  }

  const options = {
    url: "float",
    title: "FMO 浮窗",
    width: 300,
    height: 430,
    minWidth: 280,
    minHeight: 320,
    alwaysOnTop: true,
    decorations: false,
    resizable: true,
    visible: true,
    // 浮窗保留任务栏图标，方便随时找回
    skipTaskbar: false,
  };
  if (x != null && y != null) {
    options.x = x;
    options.y = y;
    options.center = false;
  } else {
    options.center = true;
  }

  try {
    win = new WebviewWindow(FLOAT_WINDOW_LABEL, options);
  } catch (err) {
    console.warn("[Float] 创建浮窗失败:", err);
    return null;
  }
  return win;
}

/** 隐藏浮窗（保留进程，数据连接不断），主窗口状态不变 */
export async function hideFloatWindow() {
  if (!isTauriDesktop()) return;
  const win = await getWindow(FLOAT_WINDOW_LABEL);
  if (win) {
    try {
      await win.hide();
    } catch {
      /* ignore */
    }
  }
}

/** 显示浮窗；返回浮窗窗口（创建/显示失败返回 null） */
export async function showFloatWindow() {
  if (!isTauriDesktop()) return null;
  const win = await ensureFloatWindow();
  if (win) {
    try {
      await win.show();
    } catch {
      /* ignore */
    }
    try {
      await win.unminimize();
    } catch {
      /* ignore */
    }
    try {
      await win.setFocus();
    } catch {
      /* ignore */
    }
  }
  return win;
}

/** 彻底销毁浮窗（退出时使用） */
export async function destroyFloatWindow() {
  if (!isTauriDesktop()) return;
  const win = await getWindow(FLOAT_WINDOW_LABEL);
  if (win) {
    try {
      await win.destroy();
    } catch {
      /* ignore */
    }
  }
}

/** 显示主窗口（按 label 定位，从任意窗口调用均有效） */
export async function showMainWindow() {
  if (!isTauriDesktop()) return;
  const win = await getWindow(MAIN_WINDOW_LABEL);
  if (win) {
    try {
      await win.show();
    } catch {
      /* ignore */
    }
    try {
      await win.unminimize();
    } catch {
      /* ignore */
    }
    try {
      await win.setFocus();
    } catch {
      /* ignore */
    }
  }
}

/** 隐藏主窗口 */
export async function hideMainWindow() {
  if (!isTauriDesktop()) return;
  const win = await getWindow(MAIN_WINDOW_LABEL);
  if (win) {
    try {
      await win.hide();
    } catch {
      /* ignore */
    }
  }
}

/** 进入浮窗模式：主窗口隐藏 + 浮窗显示 */
export async function enterFloatMode() {
  if (!isTauriDesktop()) return;
  const created = await showFloatWindow();
  if (!created) {
    // 浮窗创建失败时恢复主窗口，避免应用消失
    await showMainWindow();
    return;
  }
  await hideMainWindow();
  try {
    localStorage.setItem(FLOAT_MODE_KEY, "1");
  } catch {
    /* ignore */
  }
}

/** 退出浮窗模式：浮窗隐藏 + 主窗口显示 */
export async function exitFloatMode() {
  if (!isTauriDesktop()) return;
  await hideFloatWindow();
  await showMainWindow();
  try {
    localStorage.setItem(FLOAT_MODE_KEY, "0");
  } catch {
    /* ignore */
  }
}
