// Tauri's own build step (icons, the Windows manifest and resources). The voice and hands helpers are built by
// build.sh before this, into binaries/ (externalBin in tauri.windows.conf.json).
fn main() {
    tauri_build::build()
}
