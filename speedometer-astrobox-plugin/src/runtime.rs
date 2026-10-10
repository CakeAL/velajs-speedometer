use crate::{
    cache::{Cache, Entry},
    protocol::{self, PACKAGE, Track},
    workflow::{Action, Call, Goal, Transition, Workflow},
};
use astrobox_ng_wit::{
    astrobox::psys_host_v4::{device, dialog, interconnect, os, register, timer, ui},
    exports::astrobox::psys_plugin_v4::event::EventType,
};
use serde_json::Value;
use std::{
    collections::HashSet,
    io::Read,
    path::Path,
    sync::{Mutex, MutexGuard, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};
const CACHE_ROOT: &str = "gpx-cache";
struct Pending {
    id: String,
    addr: String,
    call: Call,
    timer_id: Option<u64>,
    attempt: u8,
    generation: u64,
}
#[derive(Default)]
pub struct State {
    pub roots: HashSet<String>,
    pub devices: Vec<(String, String, bool)>,
    pub selected: String,
    pub tracks: Vec<Track>,
    pub cached: Vec<Entry>,
    pub busy: bool,
    pub cancelled: bool,
    pub status: String,
    pub error: bool,
    pub progress: Option<(u64, u64)>,
    pub dark: bool,
    pub narrow: bool,
    pending: Option<Pending>,
    workflow: Option<Workflow>,
    sequence: u64,
    epoch: u128,
    generation: u64,
    received: u64,
    decode_issue: Option<String>,
}
static STATE: OnceLock<Mutex<State>> = OnceLock::new();
pub fn state() -> MutexGuard<'static, State> {
    STATE
        .get_or_init(|| Mutex::new(State::default()))
        .lock()
        .unwrap_or_else(|p| p.into_inner())
}
fn cache(addr: &str) -> Result<Cache, String> {
    Cache::new(Path::new(CACHE_ROOT), addr)
}
fn active(generation: u64) -> bool {
    let s = state();
    s.busy && s.generation == generation
}
fn check_active(generation: u64) -> Result<(), String> {
    if active(generation) {
        Ok(())
    } else {
        Err("操作已取消".into())
    }
}
fn set_status(message: impl Into<String>, error: bool) {
    {
        let mut s = state();
        s.status = message.into();
        s.error = error;
    }
    redraw();
}
pub fn redraw() {
    let s = state();
    for root in &s.roots {
        ui::render(root, crate::ui::build(&s));
    }
}
fn refresh_cache() {
    let addr = state().selected.clone();
    let result = if addr.is_empty() {
        Ok(vec![])
    } else {
        cache(&addr).and_then(|c| c.entries())
    };
    match result {
        Ok(entries) => state().cached = entries,
        Err(error) => {
            state().error = true;
            state().status = error;
        }
    }
}
fn finish(generation: u64, message: impl Into<String>, error: bool) {
    let pending = {
        let mut s = state();
        if s.generation != generation {
            return;
        }
        s.workflow.take();
        s.busy = false;
        s.cancelled = false;
        s.progress = None;
        s.status = message.into();
        s.error = error;
        s.pending.take()
    };
    if let Some(id) = pending.and_then(|p| p.timer_id) {
        timer::clear_timer(id);
    }
    refresh_cache();
    redraw();
}
pub async fn initialize() {
    let dark = os::appearance().await.to_lowercase().contains("dark");
    let selected = std::fs::read_to_string("selected-device.txt").unwrap_or_default();
    let mut s = state();
    s.dark = dark;
    s.selected = selected.trim().into();
    s.epoch = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    s.status = "连接手表并打开速度计，然后同步轨迹列表".into();
}
async fn refresh_devices() {
    let known = device::get_device_list().await;
    let connected = device::get_connected_device_list().await;
    let online: HashSet<_> = connected.iter().map(|d| d.addr.clone()).collect();
    let mut seen = HashSet::new();
    let mut devices = vec![];
    for d in connected.into_iter().chain(known) {
        if seen.insert(d.addr.clone()) {
            devices.push((d.name, d.addr.clone(), online.contains(&d.addr)));
        }
    }
    {
        let mut s = state();
        if !s.selected.is_empty() && !seen.contains(&s.selected) {
            devices.push(("上次使用的设备".into(), s.selected.clone(), false));
        }
        if s.selected.is_empty() {
            s.selected = devices.first().map(|d| d.1.clone()).unwrap_or_default();
        }
        s.devices = devices;
    }
    refresh_cache();
    redraw();
}
pub async fn mount(id: String) {
    let size = ui::get_render_size().await;
    {
        let mut s = state();
        s.roots.clear();
        s.roots.insert(id);
        s.narrow = size.width == 0 || size.width < 620;
    }
    redraw();
    let busy = state().busy;
    if !busy {
        refresh_devices().await;
    }
}
async fn subscribe(addr: &str, generation: u64) -> Result<(), String> {
    let online = device::get_connected_device_list().await;
    check_active(generation)?;
    if !online.iter().any(|d| d.addr == addr) {
        return Err("该设备未连接，请先在 AstroBox 设备页连接手表".into());
    }
    tracing::info!("GPX subscription starting");
    register::register_interconnect_recv(addr.into(), PACKAGE.into())
        .await
        .map_err(|e| {
            if e.to_ascii_lowercase().contains("permission denied") {
                "订阅权限未获授权：请在 AstroBox 允许 register_interconnect_recv 权限后重试".into()
            } else {
                format!("订阅手表消息失败：{e}")
            }
        })?;
    check_active(generation)?;
    tracing::info!("GPX subscription ready");
    Ok(())
}

// The export returns after the host sends the packet. The next callback, not a
// sleeping Rust task, consumes its reply. No cross-task streams or channels.
async fn send_call(addr: &str, call: Call, mut attempt: u8, generation: u64) {
    loop {
        if !active(generation) {
            return;
        }
        let id = {
            let mut s = state();
            s.sequence += 1;
            format!("gpx-{:x}-{}", s.epoch, s.sequence)
        };
        {
            let mut s = state();
            if attempt == 0 {
                s.received = 0;
                s.decode_issue = None;
            }
            s.pending = Some(Pending {
                id: id.clone(),
                addr: addr.into(),
                call: call.clone(),
                timer_id: None,
                attempt,
                generation,
            });
        }
        tracing::info!(
            "GPX request started: op={} id={id} attempt={attempt}",
            call.op
        );
        let result = interconnect::send_qaic_message(
            addr.into(),
            PACKAGE.into(),
            protocol::request(&id, call.op, call.fields.clone()),
        )
        .await;
        if !active(generation) {
            return;
        }
        // A very fast reply can already have advanced the workflow while send
        // was in progress. Its request must never be replaced by this result.
        let still_pending = state().pending.as_ref().is_some_and(|p| p.id == id);
        if !still_pending {
            return;
        }
        match result {
            Ok(()) => {
                let timer_id = timer::set_timeout(15_000, &id);
                if let Some(p) = state().pending.as_mut().filter(|p| p.id == id) {
                    p.timer_id = Some(timer_id);
                } else {
                    timer::clear_timer(timer_id);
                }
                tracing::info!(
                    "GPX packet sent; returning until reply: op={} id={id}",
                    call.op
                );
                return;
            }
            Err(error) => {
                state().pending.take();
                if error.to_ascii_lowercase().contains("permission denied") {
                    finish(
                        generation,
                        "发送权限未获授权：请在 AstroBox 允许 interconnect 权限后重试",
                        true,
                    );
                    return;
                }
                if attempt >= 3 {
                    finish(generation, format!("发送失败：{error}"), true);
                    return;
                }
                attempt += 1;
                set_status(format!("发送失败，正在重试 {attempt}/3"), false);
            }
        }
    }
}
async fn drive(workflow: Workflow, next: Transition, generation: u64) {
    if !active(generation) {
        return;
    }
    let addr = workflow.addr.clone();
    {
        let mut s = state();
        if let Some(files) = next.files {
            s.tracks = files;
        }
        s.status = next.status;
        s.error = false;
        s.progress = next.progress;
    }
    if next.cache_changed {
        refresh_cache();
    }
    redraw();
    match next.action {
        Action::Request(call) => {
            state().workflow = Some(workflow);
            send_call(&addr, call, 0, generation).await;
        }
        Action::Export(track) => {
            // This step awaits only host-owned file-dialog operations.
            let result = export(&addr, &track, generation).await;
            if let Err(error) = result {
                finish(generation, error, true);
            } else {
                let message = state().status.clone();
                finish(generation, message, false);
            }
        }
        Action::Done => {
            let message = state().status.clone();
            finish(generation, message, false);
        }
    }
}
fn timer_matches(payload: &str, p: &Pending) -> bool {
    let value = protocol::event_value(payload);
    let raw = serde_json::from_str::<Value>(payload).ok();
    let id = raw.as_ref().and_then(|v| {
        ["id", "timer_id", "timerId"]
            .into_iter()
            .find_map(|k| v.get(k).and_then(Value::as_u64))
    });
    p.timer_id.is_some() && (value == p.id || (id.is_some() && id == p.timer_id))
}
pub async fn receive(kind: EventType, payload: &str) {
    match kind {
        EventType::InterconnectMessage => {
            let taken = {
                let mut s = state();
                if s.pending.is_none() {
                    return;
                }
                s.received += 1;
                let p = s.pending.as_ref().unwrap();
                let Some(reply) = protocol::decode_reply(payload, &p.addr) else {
                    let shape = protocol::message_shape(payload);
                    tracing::warn!("GPX event could not be decoded: shape={shape}");
                    s.decode_issue = Some(shape);
                    return;
                };
                if !reply.matches(&p.id, p.call.op) {
                    tracing::warn!(
                        "GPX event did not match request: op={} id={}",
                        reply.op,
                        reply.id
                    );
                    return;
                }
                let pending = s.pending.take().unwrap();
                let workflow = s.workflow.take();
                (pending, workflow, reply)
            };
            let (p, workflow, reply) = taken;
            if let Some(id) = p.timer_id {
                timer::clear_timer(id);
            }
            if !active(p.generation) {
                return;
            }
            tracing::info!("GPX response received: op={} id={}", p.call.op, p.id);
            let result = match reply.result() {
                Ok(result) => result,
                Err(error) => {
                    finish(p.generation, error, true);
                    return;
                }
            };
            let Some(mut w) = workflow else {
                finish(p.generation, "同步状态已结束，请重新同步", true);
                return;
            };
            match w.accept(result) {
                Ok(next) => {
                    if p.call.op == "delete"
                        && let Some(name) = p.call.fields["name"].as_str()
                    {
                        state().tracks.retain(|t| t.name != name);
                    }
                    drive(w, next, p.generation).await;
                }
                Err(error) => finish(p.generation, error, true),
            }
        }
        EventType::Timer => {
            let pending = {
                let mut s = state();
                let Some(p) = s.pending.as_ref() else {
                    return;
                };
                if !timer_matches(payload, p) {
                    return;
                }
                s.pending.take().unwrap()
            };
            if !active(pending.generation) {
                return;
            }
            if pending.attempt >= 3 {
                let stage = match pending.call.op {
                    "hello" => "握手",
                    "list" => "轨迹列表",
                    "read" => "文件读取",
                    "delete" => "删除确认",
                    _ => "请求",
                };
                let message = {
                    let s = state();
                    if let Some(issue) = &s.decode_issue {
                        format!("{stage}超时：收到消息但无法解析（{issue}）")
                    } else if s.received > 0 {
                        format!("{stage}超时：已收到消息，但没有匹配的回复；请重新同步")
                    } else {
                        format!(
                            "{stage}超时：没有收到手表消息；请确认手表速度计已更新并打开，且设备仍连接"
                        )
                    }
                };
                tracing::warn!(
                    "GPX request timed out: op={} attempt={}",
                    pending.call.op,
                    pending.attempt
                );
                finish(pending.generation, message, true);
                return;
            }
            set_status(
                format!("手表未应答，正在重试 {}/3", pending.attempt + 1),
                false,
            );
            send_call(
                &pending.addr,
                pending.call,
                pending.attempt + 1,
                pending.generation,
            )
            .await;
        }
        _ => {}
    }
}
async fn export(addr: &str, track: &Track, generation: u64) -> Result<(), String> {
    let mut file = cache(addr)?.open_complete(track)?;
    check_active(generation)?;
    set_status("选择 GPX 的保存位置…", false);
    let session = dialog::save_file_start(dialog::FilterConfig {
        multiple: false,
        extensions: vec!["gpx".into()],
        default_directory: String::new(),
        default_file_name: track.name.clone(),
    })
    .await
    .map_err(|e| format!("未保存文件：{e}"))?;
    let result = async {
        let mut buffer = [0; 16_384];
        loop {
            check_active(generation)?;
            let n = file
                .read(&mut buffer)
                .map_err(|e| format!("读取本地轨迹失败：{e}"))?;
            if n == 0 {
                break;
            }
            dialog::save_file_write_chunk(session.session_id, buffer[..n].to_vec())
                .await
                .map_err(|e| format!("保存文件失败：{e}"))?;
        }
        check_active(generation)?;
        dialog::save_file_finish(session.session_id)
            .await
            .map_err(|e| format!("完成保存失败：{e}"))?;
        Ok::<_, String>(())
    }
    .await;
    if result.is_err() {
        dialog::save_file_abort(session.session_id).await;
    }
    result?;
    if active(generation) {
        set_status(format!("已导出 {}", session.name), false);
    }
    Ok(())
}
async fn confirm_delete(track: &Track) -> bool {
    dialog::show_dialog(
        dialog::DialogType::Alert,
        dialog::DialogStyle::Website,
        dialog::DialogInfo {
            title: "删除手表上的轨迹？".into(),
            content: format!(
                "{}\n{}\n手表上的文件将被删除，已下载的本地副本会保留。",
                track.display_time, track.name
            ),
            buttons: vec![
                dialog::DialogButton {
                    id: "cancel".into(),
                    primary: false,
                    content: "取消".into(),
                },
                dialog::DialogButton {
                    id: "delete".into(),
                    primary: true,
                    content: "删除手表文件".into(),
                },
            ],
        },
    )
    .await
    .clicked_btn_id
        == "delete"
}
pub async fn action(id: &str, event: ui::Event, _payload: &str) {
    if !matches!(event, ui::Event::Click) {
        return;
    }
    if id == "cancel" {
        let (pending, generation) = {
            let mut s = state();
            if !s.busy {
                return;
            }
            s.generation += 1;
            (s.pending.take(), s.generation)
        };
        if let Some(id) = pending.and_then(|p| p.timer_id) {
            timer::clear_timer(id);
        }
        finish(generation, "已取消，已接收的数据保留，可继续下载", false);
        return;
    }
    let (addr, remote, cached, generation) = {
        let mut s = state();
        if s.busy {
            return;
        }
        if let Some(index) = id
            .strip_prefix("device:")
            .and_then(|s| s.parse::<usize>().ok())
        {
            if let Some(d) = s.devices.get(index) {
                s.selected = d.1.clone();
                s.tracks.clear();
            }
            let _ = std::fs::write("selected-device.txt", &s.selected);
            drop(s);
            refresh_cache();
            set_status("设备已选择，点击同步列表", false);
            return;
        }
        s.busy = true;
        s.cancelled = false;
        s.error = false;
        s.generation += 1;
        s.received = 0;
        s.decode_issue = None;
        (
            s.selected.clone(),
            s.tracks.clone(),
            s.cached.clone(),
            s.generation,
        )
    };
    redraw();
    let result = async {
        if id == "devices" {
            refresh_devices().await;
            finish(generation, "设备列表已刷新", false);
            return Ok(());
        }
        if addr.is_empty() {
            return Err("请先在 AstroBox 连接一台手表，然后刷新设备列表".into());
        }
        if let Some(index) = id
            .strip_prefix("export:")
            .and_then(|s| s.parse::<usize>().ok())
        {
            let entry = cached.get(index).ok_or("轨迹列表已变化，请重新选择")?;
            export(&addr, &entry.track, generation).await?;
            let message = state().status.clone();
            finish(generation, message, false);
            return Ok(());
        }
        let goal = match id {
            "sync" => Goal::Sync,
            "all" => Goal::All,
            _ => {
                let (operation, index) = id.split_once(':').ok_or("未知操作")?;
                let index: usize = index.parse().map_err(|_| "轨迹编号无效")?;
                let track = remote
                    .get(index)
                    .ok_or("轨迹列表已变化，请同步后重试")?
                    .clone();
                match operation {
                    "download" => {
                        if cache(&addr)?.open_complete(&track).is_ok() {
                            export(&addr, &track, generation).await?;
                            let message = state().status.clone();
                            finish(generation, message, false);
                            return Ok(());
                        }
                        Goal::Download(track)
                    }
                    "delete" => {
                        if !confirm_delete(&track).await {
                            finish(generation, "已取消删除", false);
                            return Ok(());
                        }
                        check_active(generation)?;
                        Goal::Delete(track)
                    }
                    _ => return Err("未知操作".into()),
                }
            }
        };
        subscribe(&addr, generation).await?;
        let (workflow, next) = Workflow::new(Path::new(CACHE_ROOT), &addr, goal)?;
        drive(workflow, next, generation).await;
        Ok::<_, String>(())
    }
    .await;
    if let Err(error) = result {
        finish(generation, error, true);
    }
}
