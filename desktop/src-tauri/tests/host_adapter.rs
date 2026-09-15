use orange_translator_desktop_lib::{app_state::{AppState,CandidateType},host_adapter::GenericWindowsAdapter};
#[test]
fn new_capture_clears_old_snapshot_and_rejects_old_generation() {
    let s=AppState::default();
    s.begin_external_capture(CandidateType::Drag,1,String::new(),1).unwrap();
    s.update_external_capture(1,|d|d.host_capture=Some(GenericWindowsAdapter::snapshot("a".into(),"word","context","test"))).unwrap();
    s.begin_external_capture(CandidateType::Drag,2,String::new(),1).unwrap();
    assert!(s.target_diagnostics().unwrap().external_capture.unwrap().host_capture.is_none());
    assert!(s.update_external_capture(1,|_|panic!("stale write")).unwrap().is_none());
    let epoch=s.capture_epoch();s.set_auto_translate(false).unwrap();s.set_auto_translate(true).unwrap();assert_ne!(epoch,s.capture_epoch());
}
