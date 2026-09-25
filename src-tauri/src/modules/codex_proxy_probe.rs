//! Explicit, bounded, token-free egress checks. Never retry without the selected proxy.
use serde::Serialize;
use std::{
    collections::HashMap,
    net::IpAddr,
    sync::{LazyLock, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::{watch, Semaphore};

static PROBES: Semaphore = Semaphore::const_new(4);
static LATENCY_PROBES: Semaphore = Semaphore::const_new(3);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LatencyResult {
    pub latency_ms: u64,
    pub http_ms: Option<u64>,
    pub http_error: Option<String>,
    pub https_ms: Option<u64>,
    pub https_error: Option<String>,
    pub checked_at: i64,
}

/// Explicit latency checks never use account tokens or modify active tunnels.
pub async fn latency_resource(input: String) -> Result<LatencyResult, String> {
    let _permit = LATENCY_PROBES
        .try_acquire()
        .map_err(|_| "PROXY_PROBE_BUSY")?;
    tokio::time::timeout(Duration::from_secs(10), async {
        let tunnel = crate::modules::codex_proxy_engine::start(&input).await?;
        let client = reqwest::Client::builder()
            .no_proxy()
            .proxy(reqwest::Proxy::all(tunnel.proxy_url()).map_err(|_| "PROXY_INVALID_URL")?)
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(8))
            .build()
            .map_err(|_| "PROXY_PROBE_FAILED")?;
        let (http, https) = tokio::join!(
            query_latency(&client, "http://www.gstatic.com/generate_204"),
            query_latency(&client, "https://www.gstatic.com/generate_204"),
        );
        if http.is_err() || https.is_err() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let result = combine_latency(
            http.map_err(|error| tunnel.failure(error)),
            https.map_err(|error| tunnel.failure(error)),
        );
        // Cancellation drops this isolated tunnel; it never touches a bound runtime.
        let _ = tunnel.stop().await;
        result
    })
    .await
    .map_err(|_| "PROXY_PROBE_TIMEOUT")?
}
fn combine_latency(
    http: Result<u64, String>,
    https: Result<u64, String>,
) -> Result<LatencyResult, String> {
    let http_ms = http.as_ref().ok().copied();
    let https_ms = https.as_ref().ok().copied();
    let http_error = http.err();
    let https_error = https.err();
    http_ms
        .or(https_ms)
        .map(|latency_ms| LatencyResult {
            latency_ms,
            http_ms,
            http_error: http_error.clone(),
            https_ms,
            https_error: https_error.clone(),
            checked_at: chrono::Utc::now().timestamp_millis(),
        })
        .ok_or_else(|| {
            https_error
                .or(http_error)
                .unwrap_or_else(|| "PROXY_PROBE_FAILED".into())
        })
}
fn request_error(error: &reqwest::Error) -> String {
    if error.is_timeout() {
        return if error.is_connect() {
            "PROXY_CONNECT_TIMEOUT"
        } else {
            "PROXY_PROBE_TIMEOUT"
        }
        .into();
    }
    let mut source: Option<&(dyn std::error::Error + 'static)> = Some(error);
    for _ in 0..8 {
        let Some(current) = source else { break };
        let text = current.to_string();
        if let Some(code) = super::codex_proxy_engine_errors::code(
            super::codex_proxy_engine_errors::classify(&text.as_bytes()[..text.len().min(4096)]),
        ) {
            return code.into();
        }
        source = current.source();
    }
    "PROXY_PROBE_FAILED".into()
}
async fn query_latency(client: &reqwest::Client, endpoint: &str) -> Result<u64, String> {
    let start = Instant::now();
    let response = client
        .get(endpoint)
        .send()
        .await
        .map_err(|e| request_error(&e))?;
    if response.status() != reqwest::StatusCode::NO_CONTENT {
        return Err("PROXY_TARGET_FAILED".into());
    }
    Ok(start.elapsed().as_millis() as u64)
}
enum ProbeEntry {
    Pending {
        account_id: String,
        created_at: Instant,
    },
    Active {
        account_id: String,
        tx: watch::Sender<bool>,
    },
}
static CANCEL: LazyLock<Mutex<HashMap<String, ProbeEntry>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyProbeResult {
    pub ip: String,
    pub latency_ms: u64,
    pub checked_at: i64,
    pub protocol: String,
}

struct ProbeCancel {
    request_id: String,
    tx: watch::Sender<bool>,
    rx: watch::Receiver<bool>,
}

impl ProbeCancel {
    fn register(account_id: &str, request_id: &str) -> Result<Self, String> {
        let (tx, rx) = watch::channel(false);
        let mut map = CANCEL.lock().map_err(|_| "PROXY_PROBE_FAILED")?;
        map.retain(|_, entry| !matches!(entry, ProbeEntry::Pending { created_at, .. } if created_at.elapsed() >= Duration::from_secs(30)));
        if let Some(previous) = map.remove(request_id) {
            match previous {
                ProbeEntry::Pending {
                    account_id: pending,
                    ..
                } if pending == account_id => return Err("PROXY_PROBE_CANCELLED".into()),
                ProbeEntry::Active { tx: previous, .. } => {
                    let _ = previous.send(true);
                }
                _ => {}
            }
        }
        map.insert(
            request_id.to_string(),
            ProbeEntry::Active {
                account_id: account_id.to_string(),
                tx: tx.clone(),
            },
        );
        Ok(Self {
            request_id: request_id.to_string(),
            tx,
            rx,
        })
    }
}

impl Drop for ProbeCancel {
    fn drop(&mut self) {
        if let Ok(mut map) = CANCEL.lock() {
            if map.get(&self.request_id).is_some_and(
                |entry| matches!(entry, ProbeEntry::Active { tx, .. } if tx.same_channel(&self.tx)),
            ) {
                map.remove(&self.request_id);
            }
        }
    }
}

/// Closing the dialog or pressing cancel must stop an in-flight check.
pub fn cancel(account_id: &str, request_id: &str) -> Result<(), String> {
    validate_request_id(request_id)?;
    let mut map = CANCEL.lock().map_err(|_| "PROXY_PROBE_FAILED")?;
    map.retain(|_, entry| !matches!(entry, ProbeEntry::Pending { created_at, .. } if created_at.elapsed() >= Duration::from_secs(30)));
    match map.get(request_id) {
        Some(ProbeEntry::Active {
            account_id: active,
            tx,
        }) if active == account_id => {
            let _ = tx.send(true);
        }
        Some(_) => return Err("PROXY_PROBE_FAILED".into()),
        None if map.len() < 128 => {
            map.insert(
                request_id.to_string(),
                ProbeEntry::Pending {
                    account_id: account_id.to_string(),
                    created_at: Instant::now(),
                },
            );
        }
        None => return Err("PROXY_PROBE_BUSY".into()),
    }
    Ok(())
}

fn validate_request_id(request_id: &str) -> Result<(), String> {
    if request_id.len() != 36
        || !request_id
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
    {
        return Err("PROXY_PROBE_FAILED".into());
    }
    Ok(())
}

async fn wait_cancel(mut rx: watch::Receiver<bool>) {
    loop {
        if *rx.borrow() {
            return;
        }
        if rx.changed().await.is_err() {
            return;
        }
    }
}

pub async fn probe(
    account_id: String,
    request_id: String,
    input: Option<String>,
) -> Result<ProxyProbeResult, String> {
    validate_request_id(&request_id)?;
    let _permit = PROBES.try_acquire().map_err(|_| "PROXY_PROBE_BUSY")?;
    let cancel = ProbeCancel::register(&account_id, &request_id)?;
    tokio::select! {
        _ = wait_cancel(cancel.rx.clone()) => Err("PROXY_PROBE_CANCELLED".into()),
        result = tokio::time::timeout(Duration::from_secs(25), probe_inner(account_id, input)) =>
            result.map_err(|_| "PROXY_PROBE_TIMEOUT".to_string())?,
    }
}

async fn probe_inner(
    account_id: String,
    input: Option<String>,
) -> Result<ProxyProbeResult, String> {
    let account = crate::modules::codex_proxy_runtime::load(&account_id).await?;
    if !crate::modules::codex_account_proxy::eligible(&account) {
        return Err("PROXY_ACCOUNT_UNSUPPORTED".into());
    }
    // 探测必须使用"实际生效"的出口：统一代理开启时账号自身的绑定已经不生效。
    let input = match input {
        Some(input) => input,
        None => crate::modules::codex_account_proxy::configured_url(&account)?
            .map(|value| value.into_owned())
            .ok_or("PROXY_INVALID_URL")?,
    };
    probe_input(input).await
}

/// Resource checks use the same bounded, token-free request and global concurrency limit.
pub async fn probe_resource(input: String) -> Result<ProxyProbeResult, String> {
    let _permit = PROBES.try_acquire().map_err(|_| "PROXY_PROBE_BUSY")?;
    tokio::time::timeout(Duration::from_secs(25), probe_input(input))
        .await
        .map_err(|_| "PROXY_PROBE_TIMEOUT")?
}

async fn probe_input(input: String) -> Result<ProxyProbeResult, String> {
    let mut protocol = url::Url::parse(input.trim())
        .map_err(|_| "PROXY_INVALID_URL")?
        .scheme()
        .to_uppercase();
    if protocol == "COCKPIT-PROXY" {
        protocol = "RESOURCE".into();
    }
    let tunnel = if matches!(protocol.as_str(), "HTTP" | "HTTPS" | "SOCKS5" | "SOCKS5H") {
        None
    } else {
        Some(crate::modules::codex_proxy_engine::start(&input).await?)
    };
    let normalized = match tunnel.as_ref() {
        Some(tunnel) => tunnel.proxy_url().to_string(),
        None => crate::modules::codex_account_proxy::normalize_direct_proxy(&input)?,
    };
    let proxy = reqwest::Proxy::all(&normalized).map_err(|_| "PROXY_INVALID_URL")?;
    let client = reqwest::Client::builder()
        .no_proxy()
        .proxy(proxy)
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(12))
        .build()
        .map_err(|_| "PROXY_PROBE_FAILED")?;
    let started = Instant::now();
    let ip_result = tokio::time::timeout(
        Duration::from_secs(13),
        query_ip(&client, "https://api64.ipify.org?format=json"),
    )
    .await;
    let latency_ms = started.elapsed().as_millis() as u64;
    let ip_result = ip_result
        .map_err(|_| "PROXY_PROBE_TIMEOUT".to_string())
        .and_then(|r| r);
    if ip_result.is_err() {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let ip_result = ip_result.map_err(|e| tunnel.as_ref().map_or(e.clone(), |t| t.failure(e)));
    // Dropping the tunnel also kills the child if the outer select cancelled this future.
    if let Some(tunnel) = tunnel {
        let _ = tunnel.stop().await;
    }
    let ip = ip_result?;
    Ok(ProxyProbeResult {
        ip,
        latency_ms,
        checked_at: chrono::Utc::now().timestamp_millis(),
        protocol,
    })
}

async fn query_ip(client: &reqwest::Client, endpoint: &str) -> Result<String, String> {
    let mut response = client
        .get(endpoint)
        .send()
        .await
        .map_err(|e| request_error(&e))?;
    if !response.status().is_success() {
        return Err("PROXY_TARGET_FAILED".into());
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "PROXY_PROBE_FAILED")? {
        if body.len() + chunk.len() > 8192 {
            return Err("PROXY_PROBE_RESPONSE".into());
        }
        body.extend_from_slice(&chunk);
    }
    parse_ip(&body)
}

fn parse_ip(body: &[u8]) -> Result<String, String> {
    let value: serde_json::Value =
        serde_json::from_slice(body).map_err(|_| "PROXY_PROBE_RESPONSE")?;
    let ip = value
        .get("ip")
        .and_then(|ip| ip.as_str())
        .ok_or("PROXY_PROBE_RESPONSE")?;
    ip.parse::<IpAddr>()
        .map(|ip| ip.to_string())
        .map_err(|_| "PROXY_PROBE_RESPONSE".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[test]
    fn latency_keeps_http_and_https_outcomes_separate() {
        let both = combine_latency(Ok(230), Ok(2100)).unwrap();
        assert_eq!(
            (both.latency_ms, both.http_ms, both.https_ms),
            (230, Some(230), Some(2100))
        );
        let https_only = combine_latency(Err("PROXY_TARGET_FAILED".into()), Ok(245)).unwrap();
        assert_eq!(
            (
                https_only.latency_ms,
                https_only.http_ms,
                https_only.https_ms
            ),
            (245, None, Some(245))
        );
        assert_eq!(
            https_only.http_error.as_deref(),
            Some("PROXY_TARGET_FAILED")
        );
        let http_only = combine_latency(Ok(220), Err("PROXY_TLS_FAILED".into())).unwrap();
        assert_eq!(http_only.https_error.as_deref(), Some("PROXY_TLS_FAILED"));
        assert_eq!(
            combine_latency(Err("HTTP_FAIL".into()), Err("HTTPS_FAIL".into()))
                .err()
                .as_deref(),
            Some("HTTPS_FAIL")
        );
    }

    #[tokio::test]
    async fn latency_uses_proxy_without_tokens_and_rejects_redirects() {
        for status in ["204 No Content", "302 Found", "200 OK"] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let task = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut data = [0; 4096];
                let n = socket.read(&mut data).await.unwrap();
                let request = String::from_utf8_lossy(&data[..n]).to_lowercase();
                assert!(request.starts_with("get http://latency.invalid/"));
                for header in ["authorization:", "cookie:", "chatgpt-account-id:"] {
                    assert!(!request.contains(header));
                }
                socket
                    .write_all(
                        format!(
                            "HTTP/1.1 {status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                        )
                        .as_bytes(),
                    )
                    .await
                    .unwrap();
            });
            let client = reqwest::Client::builder()
                .no_proxy()
                .proxy(reqwest::Proxy::all(format!("http://{address}")).unwrap())
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(2))
                .build()
                .unwrap();
            assert_eq!(
                query_latency(&client, "http://latency.invalid/")
                    .await
                    .is_ok(),
                status.starts_with("204")
            );
            task.await.unwrap();
        }
    }

    #[tokio::test]
    async fn probe_uses_selected_proxy_without_account_headers() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = vec![0; 8192];
            let size = stream.read(&mut request).await.unwrap();
            let request = String::from_utf8_lossy(&request[..size]).to_lowercase();
            assert!(request.contains("http://test.invalid/"));
            assert!(!request.contains("authorization:"));
            assert!(!request.contains("chatgpt-account-id"));
            assert!(!request.contains("cookie:"));
            let body = r#"{"ip":"1.1.1.1"}"#;
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            stream.write_all(response.as_bytes()).await.unwrap();
        });
        let client = reqwest::Client::builder()
            .no_proxy()
            .proxy(reqwest::Proxy::all(format!("http://{address}")).unwrap())
            .timeout(Duration::from_secs(2))
            .build()
            .unwrap();
        assert_eq!(
            query_ip(&client, "http://test.invalid/").await.unwrap(),
            "1.1.1.1"
        );
        server.await.unwrap();
    }

    #[tokio::test]
    async fn unavailable_proxy_does_not_fall_back_to_reachable_origin() {
        let origin = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let stopped_proxy = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy_address = stopped_proxy.local_addr().unwrap();
        drop(stopped_proxy);
        let client = reqwest::Client::builder()
            .no_proxy()
            .proxy(reqwest::Proxy::all(format!("http://{proxy_address}")).unwrap())
            .timeout(Duration::from_secs(1))
            .build()
            .unwrap();
        let endpoint = format!("http://{}/", origin.local_addr().unwrap());
        assert!(query_ip(&client, &endpoint).await.is_err());
        assert!(
            tokio::time::timeout(Duration::from_millis(100), origin.accept())
                .await
                .is_err()
        );
    }

    #[test]
    fn accepts_only_ip_addresses_not_remote_markup_or_errors() {
        assert_eq!(parse_ip(br#"{"ip":"1.1.1.1"}"#).unwrap(), "1.1.1.1");
        assert_eq!(
            parse_ip(br#"{"ip":"2606:4700:4700::1111"}"#).unwrap(),
            "2606:4700:4700::1111"
        );
        for body in [
            br#"{"ip":"<script>"}"#.as_slice(),
            b"proxy password error",
            br#"{"ip":5}"#,
        ] {
            assert_eq!(parse_ip(body).unwrap_err(), "PROXY_PROBE_RESPONSE");
        }
    }

    #[tokio::test]
    async fn cancel_signal_stops_waiting_without_falling_back() {
        let (tx, rx) = watch::channel(false);
        let wait = tokio::spawn(wait_cancel(rx));
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(!wait.is_finished());
        tx.send(true).unwrap();
        tokio::time::timeout(Duration::from_secs(1), wait)
            .await
            .unwrap()
            .unwrap();
        assert!(cancel("missing-account", "11111111-2222-3333-4444-555555555555").is_ok());
        assert_eq!(
            ProbeCancel::register("missing-account", "11111111-2222-3333-4444-555555555555")
                .err()
                .as_deref(),
            Some("PROXY_PROBE_CANCELLED")
        );
        let active =
            ProbeCancel::register("active-account", "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")
                .unwrap();
        assert!(cancel("active-account", "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee").is_ok());
        tokio::time::timeout(Duration::from_secs(1), wait_cancel(active.rx.clone()))
            .await
            .unwrap();
    }
}
