#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseAction {
    Hide,
    Exit,
    Ignore,
}

pub fn should_hide_popup(auto_translate_enabled: bool) -> bool {
    !auto_translate_enabled
}

pub fn close_action(label: &str, exiting: bool) -> CloseAction {
    if exiting {
        CloseAction::Exit
    } else if matches!(label, "main" | "popup" | "status") {
        CloseAction::Hide
    } else {
        CloseAction::Ignore
    }
}
