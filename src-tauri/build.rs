fn main() {
    // google.rs reads these with option_env!, so a changed value must trigger a rebuild.
    println!("cargo:rerun-if-env-changed=JAM_GOOGLE_CLIENT_ID");
    println!("cargo:rerun-if-env-changed=JAM_GOOGLE_CLIENT_SECRET");
    tauri_build::build()
}
