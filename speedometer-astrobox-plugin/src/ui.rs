use crate::{protocol::Track, runtime::State};
use astrobox_ng_wit::astrobox::psys_host_v4::ui::{
    Element, ElementType as T, Event, FlexDirection,
};

fn text(content: &str, size: u32) -> Element {
    Element::new(T::P, Some(content)).size(size)
}
fn column() -> Element {
    Element::new(T::Div, None)
        .flex()
        .flex_direction(FlexDirection::Column)
        .gap(12)
        .width_full()
}
fn button(label: &str, id: &str, disabled: bool) -> Element {
    let el = Element::new(T::Button, Some(label)).on(Event::Click, id);
    if disabled { el.disabled() } else { el }
}
fn bytes(count: u64) -> String {
    if count >= 1_048_576 {
        format!("{:.2} MB", count as f64 / 1_048_576.0)
    } else if count >= 1024 {
        format!("{:.1} KB", count as f64 / 1024.0)
    } else {
        format!("{count} B")
    }
}
fn track_card(track: &Track, badge: &str, bg: &str, muted: &str) -> Element {
    column()
        .bg(bg)
        .radius(16)
        .padding(16)
        .child(text(&track.display_time, 19))
        .child(
            text(&track.name, 12)
                .text_color(muted)
                .prop("class", "break-all"),
        )
        .child(Element::new(
            T::Badge,
            Some(&format!("{} · {}", bytes(track.bytes), badge)),
        ))
}

pub fn build(s: &State) -> Element {
    let (bg, card, ink, muted, accent) = if s.dark {
        ("#0b1318", "#17252d", "#f2faf7", "#a5b8bd", "#7cefc4")
    } else {
        ("#f3f8f6", "#ffffff", "#16352a", "#557366", "#176b50")
    };
    let mut root = column()
        .bg(bg)
        .text_color(ink)
        .padding(if s.narrow { 16 } else { 28 })
        .max_width(1100)
        .child(text("Speedometer", 30).text_color(accent))
        .child(text("GPX 轨迹 · 从手表到手机", 16).text_color(muted));
    let mut devices = column()
        .bg(card)
        .radius(16)
        .padding(16)
        .child(text("选择设备", 18));
    for (index, (name, addr, online)) in s.devices.iter().enumerate() {
        let label = format!(
            "{}{} · {}",
            if s.selected == *addr { "✓ " } else { "" },
            name,
            if *online { "已连接" } else { "未连接" }
        );
        devices = devices.child(button(&label, &format!("device:{index}"), s.busy));
    }
    if s.devices.is_empty() {
        devices = devices.child(text("先在 AstroBox 的设备页连接手表", 14).text_color(muted));
    }
    devices = devices.child(button("刷新设备", "devices", s.busy));
    root = root.child(devices);
    let mut actions = Element::new(T::Grid, None)
        .grid_template_columns(if s.narrow { "1fr" } else { "1fr 1fr" })
        .gap(10)
        .child(button(
            "同步手表列表",
            "sync",
            s.busy || s.selected.is_empty(),
        ))
        .child(button(
            "下载全部轨迹",
            "all",
            s.busy || s.selected.is_empty(),
        ));
    if s.busy {
        actions = actions.child(button("取消操作", "cancel", s.cancelled));
    }
    root = root
        .child(actions)
        .child(text(&s.status, 14).text_color(if s.error { "#db5961" } else { accent }));
    if let Some((received, total)) = s.progress {
        let percent = if total == 0 {
            0
        } else {
            ((received as u128 * 100) / total as u128).min(100) as u64
        };
        root = root
            .child(
                Element::new(T::Progress, None)
                    .prop("value", &percent.to_string())
                    .prop("max", "100"),
            )
            .child(
                text(
                    &format!("{} / {} · {}%", bytes(received), bytes(total), percent),
                    12,
                )
                .text_color(muted),
            );
    }
    root = root
        .child(
            text(
                "同步前请打开手表上的速度计；正在记录的轨迹需结束后才会出现在列表。",
                13,
            )
            .text_color(muted),
        )
        .child(Element::new(T::Separator, None))
        .child(text(&format!("手表轨迹 · {}", s.tracks.len()), 21));
    let mut remote = Element::new(T::Grid, None)
        .grid_template_columns(if s.narrow { "1fr" } else { "1fr 1fr" })
        .gap(14)
        .width_full();
    for (index, track) in s.tracks.iter().enumerate() {
        let complete = s
            .cached
            .iter()
            .any(|e| e.complete && e.track.name == track.name && e.track.etag == track.etag);
        let partial = s.cached.iter().any(|e| {
            !e.complete && e.track.name == track.name && e.track.etag == track.etag && e.offset > 0
        });
        let badge = if complete {
            "已下载"
        } else if partial {
            "下载未完成"
        } else {
            "待下载"
        };
        remote = remote.child(
            track_card(track, badge, card, muted)
                .child(button(
                    if complete {
                        "导出 GPX"
                    } else if partial {
                        "继续下载并导出"
                    } else {
                        "下载并导出"
                    },
                    &format!("download:{index}"),
                    s.busy,
                ))
                .child(button("删除手表文件", &format!("delete:{index}"), s.busy)),
        );
    }
    if s.tracks.is_empty() {
        remote = remote.child(text("点击「同步手表列表」读取已完成轨迹", 14).text_color(muted));
    }
    root = root
        .child(remote)
        .child(Element::new(T::Separator, None))
        .child(text(
            &format!(
                "本地轨迹 · {}",
                s.cached.iter().filter(|e| e.complete).count()
            ),
            21,
        ))
        .child(
            text(
                "已下载的副本可以离线导出。删除手表文件后，本地副本仍会保留。",
                13,
            )
            .text_color(muted),
        );
    let mut local = Element::new(T::Grid, None)
        .grid_template_columns(if s.narrow { "1fr" } else { "1fr 1fr" })
        .gap(14)
        .width_full();
    for (index, entry) in s.cached.iter().enumerate().filter(|(_, e)| e.complete) {
        local = local.child(
            track_card(&entry.track, "本地副本", card, muted).child(button(
                "导出 GPX",
                &format!("export:{index}"),
                s.busy,
            )),
        );
    }
    if !s.cached.iter().any(|e| e.complete) {
        local = local.child(text("暂无已下载轨迹", 14).text_color(muted));
    }
    root.child(local)
}
