fn main() -> std::io::Result<()> {
    let path = std::env::args_os()
        .nth(1)
        .ok_or_else(|| std::io::Error::other("expected OTA bundle path"))?;
    e2ee_chat_native_lib::ota::validate_archive(std::path::Path::new(&path))
}
