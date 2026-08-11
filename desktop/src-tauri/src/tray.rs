use crate::{
    app_state::MainSection, present_main, selection::CaptureController, toggle_auto_translate,
    AppState,
};
use tauri::{
    menu::{CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager,
};

pub fn build(app: &tauri::App) -> tauri::Result<()> {
    let auto_translate_enabled = app
        .state::<AppState>()
        .runtime()
        .map_err(|message| tauri::Error::Io(std::io::Error::other(message)))?
        .auto_translate_enabled;
    let auto_item = CheckMenuItemBuilder::with_id(
        "auto-translate",
        if auto_translate_enabled {
            "暂停自动翻译"
        } else {
            "恢复自动翻译"
        },
    )
    .checked(auto_translate_enabled)
    .build(app)?;
    let home_item = MenuItemBuilder::with_id("open-home", "打开首页").build(app)?;
    let vocabulary_item = MenuItemBuilder::with_id("open-vocabulary", "打开生词本").build(app)?;
    let settings_item = MenuItemBuilder::with_id("open-settings", "打开设置").build(app)?;
    let quit_item = MenuItemBuilder::with_id("quit", "退出 Orange翻译").build(app)?;
    let menu = MenuBuilder::new(app)
        .item(&auto_item)
        .separator()
        .item(&home_item)
        .item(&vocabulary_item)
        .item(&settings_item)
        .separator()
        .item(&quit_item)
        .build()?;

    app.state::<AppState>()
        .set_auto_menu_item(auto_item)
        .map_err(|message| tauri::Error::Io(std::io::Error::other(message)))?;

    TrayIconBuilder::with_id("tray")
        .icon(
            app.default_window_icon()
                .expect("default icon is configured")
                .clone(),
        )
        .tooltip("Orange翻译 - F1 暂停/恢复自动翻译")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "auto-translate" => {
                let _ = toggle_auto_translate(app);
            }
            "open-home" => {
                let _ = present_main(app, MainSection::Home);
            }
            "open-vocabulary" => {
                let _ = present_main(app, MainSection::Vocabulary);
            }
            "open-settings" => {
                let _ = present_main(app, MainSection::Settings);
            }
            "quit" => {
                app.state::<AppState>().begin_exit();
                if let Some(controller) = app.try_state::<CaptureController>() {
                    controller.shutdown();
                }
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
                let _ = present_main(tray.app_handle(), MainSection::Home);
            }
        })
        .build(app)?;
    Ok(())
}
