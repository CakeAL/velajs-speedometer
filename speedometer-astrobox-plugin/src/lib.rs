mod cache;
mod protocol;

#[cfg(target_arch = "wasm32")]
mod runtime;
#[cfg(target_arch = "wasm32")]
mod ui;

#[cfg(target_arch = "wasm32")]
mod plugin {
    use astrobox_ng_wit::exports::astrobox::psys_plugin_v4::{event, lifecycle};
    struct SpeedometerPlugin;
    impl lifecycle::Guest for SpeedometerPlugin {
        async fn on_load() {
            let _ = tracing_subscriber::fmt().with_ansi(false).try_init();
            tracing::info!("Speedometer GPX · API Level 4");
            crate::runtime::initialize().await;
        }
    }
    impl event::Guest for SpeedometerPlugin {
        async fn on_event(kind: event::EventType, payload: String) -> String {
            crate::runtime::receive(kind, &payload);
            String::new()
        }
        async fn on_ui_event(
            id: String,
            event: astrobox_ng_wit::astrobox::psys_host_v4::ui::Event,
            payload: String,
        ) -> String {
            crate::runtime::action(&id, event, &payload).await;
            String::new()
        }
        async fn on_ui_render(id: String) {
            crate::runtime::mount(id).await;
        }
        async fn on_card_render(_id: String) {}
    }
    astrobox_ng_wit::export!(SpeedometerPlugin);
}
