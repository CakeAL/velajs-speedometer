use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

pub const PACKAGE: &str = "com.cakeal.speedometer";
pub const PROTOCOL: &str = "speedometer.gpx";
pub const CHUNK_BYTES: u64 = 768;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    pub name: String,
    pub bytes: u64,
    pub modified_at: i64,
    pub display_time: String,
    pub etag: String,
}

impl Track {
    pub fn validate(&self) -> Result<(), String> {
        if !valid_name(&self.name) || self.etag.is_empty() || self.etag.len() > 128 {
            return Err("手表返回了无效的文件标识".into());
        }
        Ok(())
    }
}

pub fn valid_name(name: &str) -> bool {
    name.starts_with("track-")
        && name.ends_with(".gpx")
        && name.len() <= 160
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.+".contains(&b))
        && !name.contains("..")
}

#[derive(Debug, Deserialize)]
pub struct Reply {
    pub protocol: String,
    pub version: u32,
    pub id: String,
    pub op: String,
    pub ok: bool,
    #[serde(default)]
    pub result: Value,
    pub error: Option<RemoteError>,
}

#[derive(Debug, Deserialize)]
pub struct RemoteError {
    pub code: String,
    pub message: String,
}

impl Reply {
    pub fn matches(&self, id: &str, op: &str) -> bool {
        self.protocol == PROTOCOL && self.version == 1 && self.id == id && self.op == op
    }
    pub fn result(self) -> Result<Value, String> {
        if self.ok {
            return Ok(self.result);
        }
        let error = self.error.ok_or("手表回复缺少错误信息")?;
        let tip = match error.code.as_str() {
            "FILE_CHANGED" => "文件已变化，请同步列表后重新下载",
            "NOT_FOUND" => "文件已不存在，请同步列表",
            "RECORDING_ACTIVE" => "轨迹正在记录或保存，请结束后同步",
            "UNSUPPORTED_VERSION" => "协议版本不兼容，请更新手表应用",
            _ => &error.message,
        };
        Err(format!("{}：{}", error.code, tip))
    }
}

pub fn request(id: &str, op: &str, fields: Value) -> String {
    let mut value = json!({"protocol":PROTOCOL,"version":1,"id":id,"op":op});
    if let Some(fields) = fields.as_object() {
        for (key, field) in fields {
            if !["protocol", "version", "id", "op"].contains(&key.as_str()) {
                value[key] = field.clone();
            }
        }
    }
    value.to_string()
}

/// Hosts wrap QAIC data in an event envelope. Keep metadata while unwrapping JSON strings.
/// The request ID and operation still have to match the single in-flight request.
pub fn decode_reply(payload: &str, expected_addr: &str) -> Option<Reply> {
    if payload.len() > 65536 {
        return None;
    }
    let mut value: Value = serde_json::from_str(payload).ok()?;
    for _ in 0..8 {
        if let Some(text) = value.as_str() {
            value = serde_json::from_str(text).ok()?;
            continue;
        }
        let obj = value.as_object()?;
        for key in ["addr", "device_addr", "deviceAddr"] {
            if let Some(addr) = obj.get(key).and_then(Value::as_str) {
                if addr != expected_addr {
                    return None;
                }
            }
        }
        for key in ["pkg_name", "pkgName", "package_name", "packageName"] {
            if let Some(pkg) = obj.get(key).and_then(Value::as_str) {
                if pkg != PACKAGE {
                    return None;
                }
            }
        }
        if obj.contains_key("protocol") {
            return serde_json::from_value(value).ok();
        }
        value = ["data", "payload", "message"]
            .into_iter()
            .find_map(|key| obj.get(key))
            .cloned()?;
    }
    None
}

pub fn event_value(payload: &str) -> String {
    let mut value = serde_json::from_str::<Value>(payload).unwrap_or(Value::String(payload.into()));
    for _ in 0..6 {
        if let Some(text) = value.as_str() {
            if let Ok(nested) = serde_json::from_str::<Value>(text) {
                if nested != value {
                    value = nested;
                    continue;
                }
            }
            return text.into();
        }
        if let Some(number) = value.as_u64() {
            return number.to_string();
        }
        let Some(next) = ["value", "payload", "data"]
            .into_iter()
            .find_map(|key| value.get(key))
            .cloned()
        else {
            return String::new();
        };
        value = next;
    }
    String::new()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    pub files: Vec<Track>,
    pub total: usize,
    pub next_offset: Option<usize>,
}

pub fn parse_page(value: Value, offset: usize) -> Result<Page, String> {
    let page: Page = serde_json::from_value(value).map_err(|e| format!("列表格式错误：{e}"))?;
    if page.files.len() > 4
        || page.total > 100_000
        || page
            .next_offset
            .is_some_and(|next| next <= offset || next > page.total)
    {
        return Err("手表返回了无效的分页位置".into());
    }
    for file in &page.files {
        file.validate()?;
    }
    Ok(page)
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Chunk {
    pub name: String,
    pub etag: String,
    pub offset: u64,
    pub next_offset: u64,
    pub total: u64,
    pub bytes: u64,
    pub eof: bool,
    pub encoding: String,
    pub data: String,
    pub crc32: String,
}

impl Chunk {
    pub fn validate(&self, track: &Track, offset: u64) -> Result<Vec<u8>, String> {
        if self.name != track.name
            || self.etag != track.etag
            || self.total != track.bytes
            || self.offset != offset
            || self.encoding != "base64"
            || self.bytes > CHUNK_BYTES
            || self.data.len() > 1024
        {
            return Err("文件块与请求不匹配".into());
        }
        let bytes = STANDARD
            .decode(&self.data)
            .map_err(|_| "文件块 Base64 无效")?;
        let next = offset.checked_add(bytes.len() as u64).ok_or("偏移溢出")?;
        if bytes.len() as u64 != self.bytes
            || self.next_offset != next
            || next > track.bytes
            || self.eof != (next == track.bytes)
            || (bytes.is_empty() && !self.eof)
        {
            return Err("文件块长度或结束位置错误".into());
        }
        if format!("{:08x}", crc32fast::hash(&bytes)) != self.crc32 {
            return Err("文件块 CRC32 校验失败".into());
        }
        Ok(bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    pub fn track() -> Track {
        Track {
            name: "track-2026-10-09T19-33-50-183+0800.gpx".into(),
            bytes: 9,
            modified_at: 123,
            display_time: "2026-10-09 19:33:50".into(),
            etag: "9:123".into(),
        }
    }
    fn chunk() -> Chunk {
        let t = track();
        Chunk {
            name: t.name,
            etag: t.etag,
            offset: 0,
            next_offset: 9,
            total: 9,
            bytes: 9,
            eof: true,
            encoding: "base64".into(),
            data: STANDARD.encode(b"123456789"),
            crc32: "cbf43926".into(),
        }
    }
    #[test]
    fn correct_chunk_preserves_bytes() {
        assert_eq!(chunk().validate(&track(), 0).unwrap(), b"123456789");
    }
    #[test]
    fn rejects_corruption() {
        let mut c = chunk();
        c.data = STANDARD.encode(b"123456788");
        assert!(c.validate(&track(), 0).unwrap_err().contains("CRC32"));
    }
    #[test]
    fn rejects_wrong_offsets_lengths_etags_and_eof() {
        let original = chunk();
        let mut c = original.clone();
        c.offset = 1;
        assert!(c.validate(&track(), 0).is_err());
        c = original.clone();
        c.next_offset = 8;
        assert!(c.validate(&track(), 0).is_err());
        c = original.clone();
        c.etag = "changed".into();
        assert!(c.validate(&track(), 0).is_err());
        c = original.clone();
        c.bytes = 8;
        assert!(c.validate(&track(), 0).is_err());
        c = original;
        c.eof = false;
        assert!(c.validate(&track(), 0).is_err());
    }
    #[test]
    fn rejects_path_traversal_and_accepts_legacy_names() {
        for n in [
            "../track-a.gpx",
            "track-../a.gpx",
            "track-..gpx",
            "track-a.part",
            "track-a\\x.gpx",
        ] {
            assert!(!valid_name(n));
        }
        assert!(valid_name("track-2026-10-09T11-33-50-183.gpx"));
        assert!(valid_name(&track().name));
    }
    #[test]
    fn unwraps_host_envelopes_and_rejects_other_devices() {
        let response = json!({"protocol":PROTOCOL,"version":1,"id":"req-1","op":"hello","ok":true,"result":{}});
        let wrapped = json!({"addr":"watch","pkg_name":PACKAGE,"data":response.to_string()});
        let reply = decode_reply(&wrapped.to_string(), "watch").unwrap();
        assert!(reply.matches("req-1", "hello"));
        assert!(!reply.matches("stale", "hello"));
        assert!(decode_reply(&wrapped.to_string(), "other").is_none());
        assert!(decode_reply("malformed", "watch").is_none());
    }
    #[test]
    fn rejects_nonadvancing_pagination() {
        assert!(parse_page(json!({"files":[],"total":4,"nextOffset":0}), 0).is_err());
        assert!(parse_page(json!({"files":[],"total":4,"nextOffset":null}), 0).is_ok());
    }
    #[test]
    fn extracts_ui_and_timer_values() {
        assert_eq!(event_value(r#"{"payload":"req-12"}"#), "req-12");
        assert_eq!(event_value(r#"{"value":"watch"}"#), "watch");
        assert_eq!(event_value("42"), "42");
    }
    #[test]
    fn remote_error_is_not_silent_success() {
        let reply:Reply=serde_json::from_value(json!({"protocol":PROTOCOL,"version":1,"id":"req","op":"read","ok":false,"error":{"code":"FILE_CHANGED","message":"changed"}})).unwrap();
        assert!(reply.result().unwrap_err().contains("重新下载"));
    }
}
