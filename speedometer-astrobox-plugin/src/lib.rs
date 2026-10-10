mod archive;
mod cache;
mod protocol;
mod workflow;

#[cfg(test)]
mod interoperability {
    use super::{
        cache::Cache,
        protocol::{self, Chunk},
    };
    use serde_json::Value;
    use std::{fs, io::Read};

    #[test]
    fn manifest_declares_v4_and_the_subscription_permission() {
        let manifest: Value = serde_json::from_str(include_str!("../manifest.json")).unwrap();
        assert_eq!(manifest["version"], env!("CARGO_PKG_VERSION"));
        assert_eq!(manifest["api_level"], 4);
        assert_eq!(manifest["wasi_version"], 3);
        let permissions = manifest["permissions"].as_array().unwrap();
        for needed in [
            "device",
            "interconnect",
            "register_interconnect_recv",
            "dialog",
            "ui",
            "timer",
        ] {
            assert!(
                permissions.iter().any(|p| p == needed),
                "missing permission: {needed}"
            );
        }
    }

    #[test]
    fn downloads_actual_watch_replies_with_altitude_utf8_and_resume() {
        let fixture: Value =
            serde_json::from_str(include_str!("../tests/fixtures/watch.json")).unwrap();
        let page = protocol::parse_page(fixture["list"]["result"].clone(), 0).unwrap();
        let track = &page.files[0];
        let root = std::env::temp_dir().join(format!("speedometer-interop-{}", std::process::id()));
        let addr = "test-watch";
        let mut download = Cache::new(&root, addr).unwrap().begin(track).unwrap();
        for (i, wire) in fixture["chunks"].as_array().unwrap().iter().enumerate() {
            let id = wire["id"].as_str().unwrap();
            let request = protocol::request(
                id,
                "read",
                serde_json::json!({"name":track.name,"etag":track.etag,"offset":download.entry.offset,"length":768}),
            );
            let request: Value = serde_json::from_str(&request).unwrap();
            assert_eq!(request["protocol"], fixture["hello"]["protocol"]);
            let envelope = serde_json::json!({"device_addr":addr,"pkg_name":protocol::PACKAGE,"data":wire.to_string()});
            let reply = protocol::decode_reply(&envelope.to_string(), addr).unwrap();
            assert!(reply.matches(id, request["op"].as_str().unwrap()));
            let chunk: Chunk = serde_json::from_value(reply.result().unwrap()).unwrap();
            let bytes = chunk.validate(track, download.entry.offset).unwrap();
            download.append(&bytes).unwrap();
            if i == 0 {
                drop(download);
                download = Cache::new(&root, addr).unwrap().begin(track).unwrap();
                assert_eq!(download.entry.offset, 768);
            }
        }
        download.finish().unwrap();
        let mut output = String::new();
        Cache::new(&root, addr)
            .unwrap()
            .open_complete(track)
            .unwrap()
            .read_to_string(&mut output)
            .unwrap();
        assert_eq!(output, fixture["gpx"].as_str().unwrap());
        assert!(output.contains("<ele>-12.50</ele>"));
        let mut local_time_changed = track.clone();
        local_time_changed.display_time = "changed timezone".into();
        assert!(
            Cache::new(&root, addr)
                .unwrap()
                .open_complete(&local_time_changed)
                .is_ok()
        );
        let changed = protocol::decode_reply(&fixture["changed"].to_string(), addr).unwrap();
        assert!(changed.result().unwrap_err().contains("FILE_CHANGED"));
        for key in ["deleted", "deletedAgain"] {
            let reply = protocol::decode_reply(&fixture[key].to_string(), addr).unwrap();
            assert_eq!(reply.result().unwrap()["name"], track.name);
        }
        fs::remove_dir_all(root).unwrap();
    }
}

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
            tracing::info!(
                "Speedometer GPX {} · API Level 4 · event-driven sync",
                env!("CARGO_PKG_VERSION")
            );
            crate::runtime::initialize().await;
        }
    }
    impl event::Guest for SpeedometerPlugin {
        async fn on_event(kind: event::EventType, payload: String) -> String {
            crate::runtime::receive(kind, &payload).await;
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
