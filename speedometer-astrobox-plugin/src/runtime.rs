use crate::{
    cache::{Cache, Entry},
    protocol::{self, Chunk, PACKAGE, Track},
};
use astrobox_ng_wit::{
    astrobox::psys_host_v4::{device, dialog, interconnect, os, register, timer, ui},
    exports::astrobox::psys_plugin_v4::event::EventType,
};
use futures::channel::oneshot;
use serde_json::{Value, json};
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
    op: String,
    addr: String,
    timer_id: u64,
    sender: oneshot::Sender<Result<Value, String>>,
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
    sequence: u64,
    epoch: u128,
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

pub async fn initialize() {
    let dark = os::appearance().await.to_lowercase().contains("dark");
    let selected = std::fs::read_to_string("selected-device.txt").unwrap_or_default();
    {
        let mut s = state();
        s.dark = dark;
        s.selected = selected.trim().into();
        s.epoch = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        s.status = "连接手表并打开速度计，然后同步轨迹列表".into();
    }
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
        s.roots.insert(id);
        s.narrow = size.width == 0 || size.width < 620;
    }
    redraw();
    // Reopening the page must not change the device underneath an active transfer.
    if !state().busy {
        refresh_devices().await;
    }
}

pub fn receive(kind: EventType, payload: &str) {
    match kind {
        EventType::InterconnectMessage => {
            let mut s = state();
            let Some(p) = s.pending.as_ref() else {
                return;
            };
            let Some(reply) = protocol::decode_reply(payload, &p.addr) else {
                return;
            };
            if !reply.matches(&p.id, &p.op) {
                return;
            }
            let pending = s.pending.take().unwrap();
            drop(s);
            timer::clear_timer(pending.timer_id);
            let _ = pending.sender.send(reply.result());
        }
        EventType::Timer => {
            let value = protocol::event_value(payload);
            let raw = serde_json::from_str::<Value>(payload).ok();
            let mut s = state();
            let Some(p) = s.pending.as_ref() else {
                return;
            };
            let id = raw.as_ref().and_then(|v| {
                ["id", "timer_id", "timerId"]
                    .into_iter()
                    .find_map(|k| v.get(k).and_then(Value::as_u64))
            });
            if value != p.id && id != Some(p.timer_id) {
                return;
            }
            let p = s.pending.take().unwrap();
            drop(s);
            let _ = p
                .sender
                .send(Err("TIMEOUT：手表未应答，请保持连接并打开速度计".into()));
        }
        _ => {}
    }
}

fn check_cancel() -> Result<(), String> {
    if state().cancelled {
        Err("已取消，已接收的数据保留，可继续下载".into())
    } else {
        Ok(())
    }
}

async fn rpc_once(addr: &str, op: &str, fields: Value) -> Result<Value, String> {
    check_cancel()?;
    let (sender, receiver) = oneshot::channel();
    let id = {
        let mut s = state();
        s.sequence += 1;
        format!("gpx-{:x}-{}", s.epoch, s.sequence)
    };
    let timer_id = timer::set_timeout(15_000, &id);
    {
        let mut s = state();
        if s.pending.is_some() {
            timer::clear_timer(timer_id);
            return Err("已有请求正在进行".into());
        }
        s.pending = Some(Pending {
            id: id.clone(),
            op: op.into(),
            addr: addr.into(),
            timer_id,
            sender,
        });
    }
    let send = interconnect::send_qaic_message(
        addr.into(),
        PACKAGE.into(),
        protocol::request(&id, op, fields),
    )
    .await;
    if let Err(error) = send {
        let mut s = state();
        // A reply or cancellation may already have consumed it while send was waiting.
        if s.pending.as_ref().is_some_and(|p| p.id == id) {
            s.pending.take();
        }
        timer::clear_timer(timer_id);
        return Err(format!("发送失败：{error}"));
    }
    receiver.await.map_err(|_| "请求已结束".to_string())?
}

async fn rpc(addr: &str, op: &str, fields: Value) -> Result<Value, String> {
    // Only transport failures are retried; business errors need an explicit list refresh.
    for attempt in 0..=3 {
        let result = rpc_once(addr, op, fields.clone()).await;
        if let Err(error) = &result {
            if !state().cancelled
                && (error.starts_with("TIMEOUT") || error.starts_with("发送失败"))
                && attempt < 3
            {
                set_status(format!("连接暂未响应，正在重试 {}/3", attempt + 1), false);
                continue;
            }
        }
        return result;
    }
    unreachable!()
}

async fn connect(addr: &str) -> Result<(), String> {
    let online = device::get_connected_device_list().await;
    if !online.iter().any(|d| d.addr == addr) {
        return Err("该设备未连接，请先在 AstroBox 设备页连接手表".into());
    }
    register::register_interconnect_recv(addr.into(), PACKAGE.into())
        .await
        .map_err(|e| format!("订阅手表消息失败：{e}"))?;
    let hello = rpc(addr, "hello", json!({})).await?;
    let operations = hello
        .get("operations")
        .and_then(Value::as_array)
        .ok_or("握手信息缺少操作列表")?;
    if hello.get("package").and_then(Value::as_str) != Some(PACKAGE)
        || hello.get("chunkBytes").and_then(Value::as_u64) != Some(protocol::CHUNK_BYTES)
        || !["list", "read", "delete"]
            .iter()
            .all(|op| operations.iter().any(|v| v.as_str() == Some(op)))
    {
        return Err("手表端 GPX 协议不兼容，请更新速度计应用".into());
    }
    Ok(())
}

async fn list(addr: &str) -> Result<(), String> {
    set_status("正在读取手表轨迹列表…", false);
    let mut tracks = vec![];
    let mut names = HashSet::new();
    let mut offset = 0;
    loop {
        check_cancel()?;
        let page = protocol::parse_page(
            rpc(addr, "list", json!({"offset":offset,"limit":4})).await?,
            offset,
        )?;
        for track in page.files {
            if names.insert(track.name.clone()) {
                tracks.push(track);
            }
        }
        match page.next_offset {
            Some(next) => offset = next,
            None => break,
        }
    }
    state().tracks = tracks;
    refresh_cache();
    let count = state().tracks.len();
    set_status(format!("同步完成，手表上有 {count} 条已完成轨迹"), false);
    Ok(())
}

async fn download(addr: &str, track: &Track) -> Result<(), String> {
    // Verify existing cache too; a damaged complete file is downloaded again.
    if cache(addr)?.open_complete(track).is_ok() {
        return Ok(());
    }
    let mut download = cache(addr)?.begin(track)?;
    loop {
        check_cancel()?;
        let offset = download.entry.offset;
        {
            state().progress = Some((offset, track.bytes));
        }
        set_status(format!("正在下载 {}", track.display_time), false);
        let mut accepted = None;
        for attempt in 0..=3 {
            let value=rpc(addr,"read",json!({"name":track.name,"etag":track.etag,"offset":offset,"length":protocol::CHUNK_BYTES})).await?;
            let chunk: Chunk =
                serde_json::from_value(value).map_err(|e| format!("文件块格式错误：{e}"))?;
            match chunk.validate(track, offset) {
                Ok(bytes) => {
                    accepted = Some((bytes, chunk.eof));
                    break;
                }
                Err(error) if attempt == 3 => return Err(error),
                Err(error) => {
                    set_status(format!("{error}，正在重读当前块 {}/3", attempt + 1), false)
                }
            }
        }
        let (bytes, eof) = accepted.ok_or("文件块接收失败")?;
        download.append(&bytes)?;
        if eof {
            break;
        }
    }
    download.finish()?;
    refresh_cache();
    state().progress = None;
    Ok(())
}

async fn export(addr: &str, track: &Track) -> Result<(), String> {
    let mut file = cache(addr)?.open_complete(track)?;
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
            check_cancel()?;
            let count = file
                .read(&mut buffer)
                .map_err(|e| format!("读取本地轨迹失败：{e}"))?;
            if count == 0 {
                break;
            }
            dialog::save_file_write_chunk(session.session_id, buffer[..count].to_vec())
                .await
                .map_err(|e| format!("保存文件失败：{e}"))?;
        }
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
    set_status(format!("已导出 {}", session.name), false);
    Ok(())
}

async fn delete(addr: &str, track: &Track) -> Result<(), String> {
    let answer = dialog::show_dialog(
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
    .await;
    if answer.clicked_btn_id != "delete" {
        set_status("已取消删除", false);
        return Ok(());
    }
    check_cancel()?;
    connect(addr).await?;
    let result = rpc(addr, "delete", json!({"name":track.name,"etag":track.etag})).await?;
    if result.get("name").and_then(Value::as_str) != Some(&track.name)
        || !result.get("deleted").is_some_and(Value::is_boolean)
    {
        return Err("删除回复格式错误，请刷新列表确认手表文件是否仍存在".into());
    }
    state().tracks.retain(|t| t.name != track.name);
    set_status("手表文件已删除，本地副本保留", false);
    Ok(())
}

pub async fn action(id: &str, event: ui::Event, _payload: &str) {
    if !matches!(event, ui::Event::Click) {
        return;
    }
    if id == "cancel" {
        let pending = {
            let mut s = state();
            if !s.busy {
                return;
            }
            s.cancelled = true;
            s.pending.take()
        };
        if let Some(p) = pending {
            timer::clear_timer(p.timer_id);
            let _ = p
                .sender
                .send(Err("已取消，已接收的数据保留，可继续下载".into()));
        }
        set_status("正在取消…", false);
        return;
    }
    let (addr, remote, cached) = {
        let mut s = state();
        if s.busy {
            return;
        }
        if let Some(index) = id
            .strip_prefix("device:")
            .and_then(|s| s.parse::<usize>().ok())
        {
            if let Some(device) = s.devices.get(index) {
                s.selected = device.1.clone();
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
        (s.selected.clone(), s.tracks.clone(), s.cached.clone())
    };
    redraw();
    let result = async {
        if id == "devices" {
            refresh_devices().await;
            set_status("设备列表已刷新", false);
            return Ok(());
        }
        if addr.is_empty() {
            return Err("请先在 AstroBox 连接一台手表，然后刷新设备列表".into());
        }
        if id == "sync" {
            connect(&addr).await?;
            return list(&addr).await;
        }
        if id == "all" {
            connect(&addr).await?;
            list(&addr).await?;
            let files = state().tracks.clone();
            for track in files {
                download(&addr, &track).await?;
            }
            set_status("全部轨迹已下载，可在本地轨迹中导出 GPX", false);
            return Ok(());
        }
        if let Some(index) = id
            .strip_prefix("export:")
            .and_then(|s| s.parse::<usize>().ok())
        {
            let entry = cached.get(index).ok_or("轨迹列表已变化，请重新选择")?;
            return export(&addr, &entry.track).await;
        }
        let (operation, index) = id.split_once(':').ok_or("未知操作")?;
        let index: usize = index.parse().map_err(|_| "轨迹编号无效")?;
        let track = remote.get(index).ok_or("轨迹列表已变化，请同步后重试")?;
        match operation {
            "download" => {
                connect(&addr).await?;
                download(&addr, track).await?;
                set_status("下载完成，正在导出 GPX…", false);
                export(&addr, track).await
            }
            "delete" => delete(&addr, track).await,
            _ => Err("未知操作".into()),
        }
    }
    .await;
    if let Err(error) = result {
        set_status(error, true);
    }
    {
        let mut s = state();
        s.busy = false;
        s.cancelled = false;
        s.progress = None;
    }
    refresh_cache();
    redraw();
}
