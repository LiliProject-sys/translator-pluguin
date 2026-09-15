fn main() {
    // Track directory additions too, so incremental builds include new notices
    // and rebuilt dictionaries, not only resources seen by an earlier build.
    println!("cargo:rerun-if-changed=resources/dictionary");
    tauri_build::build();
    #[cfg(target_os = "windows")]
    {
        let manifest = std::path::Path::new(&std::env::var("CARGO_MANIFEST_DIR").unwrap())
            .join("windows-common-controls.manifest");
        println!("cargo:rerun-if-changed={}", manifest.display());
        println!("cargo:rustc-link-arg-tests=/MANIFEST:EMBED");
        println!(
            "cargo:rustc-link-arg-tests=/MANIFESTINPUT:{}",
            manifest.display()
        );
    }
}
