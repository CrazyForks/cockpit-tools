use crate::modules::codex_proxy_engine_install::{self as installer, EngineInstallStatus};

#[tauri::command]
pub async fn codex_proxy_activity_snapshot(
    account_id: String,
) -> Result<crate::modules::codex_proxy_activity::ProxyActivitySnapshot, String> {
    crate::modules::codex_proxy_activity::snapshot(account_id).await
}

/// 全账号流量汇总：只返回计数与字节数，读取失败按账号降级，不影响其他账号。
#[tauri::command]
pub async fn codex_proxy_activity_summary(
) -> Result<Vec<crate::modules::codex_proxy_activity::ProxyActivitySummaryEntry>, String> {
    crate::modules::codex_proxy_activity::summary().await
}

#[tauri::command]
pub async fn codex_proxy_activity_set_enabled(
    account_id: String,
    enabled: bool,
) -> Result<(), String> {
    crate::modules::codex_proxy_activity::set_enabled(account_id, enabled).await
}

#[tauri::command]
pub async fn codex_proxy_activity_clear(account_id: String) -> Result<(), String> {
    let account = crate::modules::codex_proxy_runtime::load(&account_id).await?;
    if !crate::modules::codex_account_proxy::eligible(&account) {
        return Err("PROXY_ACCOUNT_UNSUPPORTED".into());
    }
    crate::modules::codex_proxy_activity::clear(&account_id);
    Ok(())
}

#[tauri::command]
pub async fn codex_proxy_engine_status() -> Result<EngineInstallStatus, String> {
    installer::status().await
}

#[tauri::command]
pub async fn codex_proxy_engine_install(
    archive_path: Option<String>,
) -> Result<EngineInstallStatus, String> {
    installer::begin(archive_path).await
}

#[tauri::command]
pub fn codex_proxy_engine_cancel(job_id: String) -> Result<(), String> {
    installer::cancel(&job_id)
}
