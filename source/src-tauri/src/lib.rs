#[cfg(desktop)]
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::{Emitter, Listener, Manager};

/// 持有托盘句柄，避免 setup 结束后被释放
#[cfg(desktop)]
#[allow(dead_code)]
struct TrayHandle(tauri::tray::TrayIcon);

pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_fs::init())
    .plugin(tauri_plugin_opener::init())
    .on_page_load(|webview, payload| {
      // 认证弹窗（fmo-auth-*）页面真正加载完成（设备可达且认证缓存就绪）后，
      // 通知前端关闭弹窗，避免设备响应较慢时弹窗过早关闭导致认证未完成。
      if webview.label().starts_with("fmo-auth-")
        && payload.event() == tauri::webview::PageLoadEvent::Finished
      {
        let _ = webview.emit("fmo-auth-loaded", ());
      }
    })
    .on_window_event(|window, event| {
      // 主窗口：点最小化时自动进入浮窗模式；点关闭(X)时彻底退出应用
      if window.label() != "main" {
        return;
      }
      match event {
        tauri::WindowEvent::CloseRequested { .. } => {
          // 直接退出，不再转入浮窗后台运行
          window.app_handle().exit(0);
        }
        tauri::WindowEvent::Resized(size) => {
          // Windows 最小化会触发 0x0 的 Resized 事件
          if size.width == 0 && size.height == 0 && window.is_minimized().unwrap_or(false) {
            let _ = window.emit("fmo:auto-float", ());
          }
        }
        _ => {}
      }
    })
    .setup(|app| {
      // 清空默认菜单栏（仅桌面端）
      #[cfg(desktop)]
      {
        let menu = MenuBuilder::new(app).build()?;
        app.set_menu(menu)?;
        setup_tray(app)?;
      }

      // 前端请求退出（浮窗右键“退出”等）
      let handle = app.handle().clone();
      let _ = app.listen_any("fmo:quit-app", move |_| {
        handle.exit(0);
      });

      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}

/// 系统托盘：保活应用入口（主窗口隐藏后仍可从托盘恢复）。
/// 左键单击切换浮窗；右键菜单：显示主窗口 / 显示浮窗 / 隐藏浮窗 / 退出。
#[cfg(desktop)]
fn setup_tray(app: &mut tauri::App) -> tauri::Result<()> {
  use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

  let show_main = MenuItemBuilder::with_id("show_main", "显示主窗口").build(app)?;
  let show_float = MenuItemBuilder::with_id("show_float", "显示浮窗").build(app)?;
  let hide_float = MenuItemBuilder::with_id("hide_float", "隐藏浮窗").build(app)?;
  let quit = MenuItemBuilder::with_id("quit", "退出").build(app)?;

  let menu = MenuBuilder::new(app)
    .items(&[&show_main, &show_float, &hide_float, &quit])
    .build()?;

  let Some(icon) = app.default_window_icon() else {
    return Ok(());
  };
  let icon = icon.clone();

  let tray = TrayIconBuilder::new()
    .icon(icon)
    .menu(&menu)
    .show_menu_on_left_click(false)
    .on_menu_event(|app, event| match event.id.as_ref() {
      "show_main" => {
        let _ = app.emit("fmo:tray-show-main", ());
      }
      "show_float" => {
        let _ = app.emit("fmo:tray-show-float", ());
      }
      "hide_float" => {
        let _ = app.emit("fmo:tray-hide-float", ());
      }
      "quit" => {
        app.exit(0);
      }
      _ => {}
    })
    .on_tray_icon_event(|tray, event| {
      if let TrayIconEvent::Click {
        button: MouseButton::Left,
        button_state: MouseButtonState::Up,
        ..
      } = event
      {
        let _ = tray.app_handle().emit("fmo:tray-toggle-float", ());
      }
    })
    .build(app)?;

  app.manage(TrayHandle(tray));
  Ok(())
}
