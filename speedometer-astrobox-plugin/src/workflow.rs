//! Each reply advances one step. Nothing in this module waits for another callback.
use crate::{
    cache::{Cache, Download},
    protocol::{self, Chunk, PACKAGE, Track},
};
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
};

#[derive(Clone)]
pub enum Goal {
    Sync,
    All,
    Download(Track),
    Delete(Track),
    DeleteAll,
}
#[derive(Clone, Debug)]
pub struct Call {
    pub op: &'static str,
    pub fields: Value,
}
impl Call {
    fn new(op: &'static str, fields: Value) -> Self {
        Self { op, fields }
    }
}
pub enum Action {
    Request(Call),
    Export(Track),
    ConfirmDelete(usize),
    Done,
}
pub struct Transition {
    pub action: Action,
    pub status: String,
    pub files: Option<Vec<Track>>,
    pub progress: Option<(u64, u64)>,
    pub cache_changed: bool,
}
impl Transition {
    fn request(call: Call, status: impl Into<String>) -> Self {
        Self {
            action: Action::Request(call),
            status: status.into(),
            files: None,
            progress: None,
            cache_changed: false,
        }
    }
    fn done(status: impl Into<String>) -> Self {
        Self {
            action: Action::Done,
            status: status.into(),
            files: None,
            progress: None,
            cache_changed: false,
        }
    }
}
#[derive(PartialEq)]
enum Step {
    Hello,
    List,
    Read,
    Delete,
    ConfirmDelete,
    Finished,
}
pub struct Workflow {
    pub addr: String,
    goal: Goal,
    root: PathBuf,
    step: Step,
    files: Vec<Track>,
    names: HashSet<String>,
    offset: usize,
    queue: Vec<Track>,
    index: usize,
    download: Option<Download>,
    corrupt_retries: u8,
}
impl Workflow {
    pub fn new(root: &Path, addr: &str, goal: Goal) -> Result<(Self, Transition), String> {
        match &goal {
            Goal::Download(t) | Goal::Delete(t) => t.validate()?,
            _ => {}
        }
        let workflow = Self {
            addr: addr.into(),
            goal,
            root: root.into(),
            step: Step::Hello,
            files: vec![],
            names: HashSet::new(),
            offset: 0,
            queue: vec![],
            index: 0,
            download: None,
            corrupt_retries: 0,
        };
        Ok((
            workflow,
            Transition::request(Call::new("hello", json!({})), "正在连接手表速度计…"),
        ))
    }
    fn cache(&self) -> Result<Cache, String> {
        Cache::new(&self.root, &self.addr)
    }
    fn list_call(&self) -> Transition {
        Transition::request(
            Call::new("list", json!({"offset":self.offset,"limit":4})),
            "正在读取手表轨迹列表…",
        )
    }
    fn read_call(&self, status: Option<String>) -> Result<Transition, String> {
        let d = self.download.as_ref().ok_or("没有正在下载的轨迹")?;
        let t = &d.entry.track;
        let mut next = Transition::request(
            Call::new(
                "read",
                json!({"name":t.name,"etag":t.etag,"offset":d.entry.offset,"length":protocol::CHUNK_BYTES}),
            ),
            status.unwrap_or_else(|| format!("正在下载 {}", t.display_time)),
        );
        next.progress = Some((d.entry.offset, t.bytes));
        Ok(next)
    }
    fn next_download(&mut self) -> Result<Transition, String> {
        while let Some(t) = self.queue.get(self.index).cloned() {
            self.index += 1;
            if self.cache()?.open_complete(&t).is_ok() {
                if matches!(self.goal, Goal::Download(_)) {
                    return Ok(self.export(t));
                }
                continue;
            }
            self.download = Some(self.cache()?.begin(&t)?);
            self.corrupt_retries = 0;
            self.step = Step::Read;
            return self.read_call(None);
        }
        self.step = Step::Finished;
        Ok(Transition::done("全部轨迹已下载，可在本地轨迹中导出 GPX"))
    }
    fn export(&mut self, track: Track) -> Transition {
        self.step = Step::Finished;
        Transition {
            action: Action::Export(track),
            status: "下载完成，选择 GPX 的保存位置…".into(),
            files: None,
            progress: None,
            cache_changed: true,
        }
    }
    fn next_delete(&mut self) -> Transition {
        if let Some(track) = self.queue.get(self.index) {
            self.step = Step::Delete;
            Transition::request(
                Call::new("delete", json!({"name":track.name,"etag":track.etag})),
                format!("正在删除手表轨迹 {}/{}…", self.index + 1, self.queue.len()),
            )
        } else {
            self.step = Step::Finished;
            Transition::done(format!(
                "已删除手表上的 {} 条轨迹，本地副本保留",
                self.index
            ))
        }
    }
    pub fn confirm_deletion(&mut self) -> Result<Transition, String> {
        if self.step != Step::ConfirmDelete {
            return Err("删除确认状态无效".into());
        }
        Ok(self.next_delete())
    }
    pub fn failure_message(&self, error: String) -> String {
        if matches!(self.goal, Goal::DeleteAll) && !self.queue.is_empty() {
            format!(
                "已确认删除 {}/{} 条手表轨迹；{error}。请同步列表确认剩余文件",
                self.index,
                self.queue.len()
            )
        } else {
            error
        }
    }
    pub fn accept(&mut self, result: Value) -> Result<Transition, String> {
        match self.step {
            Step::Hello => {
                let operations = result["operations"]
                    .as_array()
                    .ok_or("握手信息缺少操作列表")?;
                if result["package"].as_str() != Some(PACKAGE)
                    || result["chunkBytes"].as_u64() != Some(protocol::CHUNK_BYTES)
                    || !["list", "read", "delete"]
                        .iter()
                        .all(|op| operations.iter().any(|v| v.as_str() == Some(op)))
                {
                    return Err("手表端 GPX 协议不兼容，请更新速度计应用".into());
                }
                match self.goal.clone() {
                    Goal::Sync | Goal::All | Goal::DeleteAll => {
                        self.step = Step::List;
                        Ok(self.list_call())
                    }
                    Goal::Download(t) => {
                        self.queue = vec![t];
                        self.next_download()
                    }
                    Goal::Delete(t) => {
                        self.queue = vec![t];
                        Ok(self.next_delete())
                    }
                }
            }
            Step::List => {
                let page = protocol::parse_page(result, self.offset)?;
                for t in page.files {
                    if self.names.insert(t.name.clone()) {
                        self.files.push(t);
                    }
                }
                if let Some(offset) = page.next_offset {
                    self.offset = offset;
                    return Ok(self.list_call());
                }
                let mut next = if matches!(self.goal, Goal::All) {
                    self.queue = self.files.clone();
                    self.next_download()?
                } else if matches!(self.goal, Goal::DeleteAll) && !self.files.is_empty() {
                    self.queue = self.files.clone();
                    self.step = Step::ConfirmDelete;
                    Transition {
                        action: Action::ConfirmDelete(self.queue.len()),
                        status: "列表已读取，等待确认删除…".into(),
                        files: None,
                        progress: None,
                        cache_changed: false,
                    }
                } else {
                    self.step = Step::Finished;
                    Transition::done(format!(
                        "同步完成，手表上有 {} 条已完成轨迹",
                        self.files.len()
                    ))
                };
                next.files = Some(self.files.clone());
                Ok(next)
            }
            Step::Read => {
                let chunk: Chunk =
                    serde_json::from_value(result).map_err(|e| format!("文件块格式错误：{e}"))?;
                let d = self.download.as_ref().ok_or("没有正在下载的轨迹")?;
                let bytes = match chunk.validate(&d.entry.track, d.entry.offset) {
                    Ok(bytes) => bytes,
                    Err(error) if self.corrupt_retries < 3 => {
                        self.corrupt_retries += 1;
                        return self.read_call(Some(format!(
                            "{error}，正在重读当前块 {}/3",
                            self.corrupt_retries
                        )));
                    }
                    Err(error) => return Err(error),
                };
                self.corrupt_retries = 0;
                self.download.as_mut().ok_or("下载已结束")?.append(&bytes)?;
                if !chunk.eof {
                    return self.read_call(None);
                }
                let d = self.download.take().ok_or("下载已结束")?;
                let t = d.entry.track.clone();
                d.finish()?;
                let mut next = if matches!(self.goal, Goal::Download(_)) {
                    self.export(t)
                } else {
                    self.next_download()?
                };
                next.cache_changed = true;
                Ok(next)
            }
            Step::Delete => {
                let track = self.queue.get(self.index).ok_or("删除状态无效")?;
                if result["name"].as_str() != Some(&track.name) || !result["deleted"].is_boolean() {
                    return Err("删除回复格式错误，请刷新列表确认文件是否仍存在".into());
                }
                self.index += 1;
                Ok(self.next_delete())
            }
            Step::ConfirmDelete => Err("请先确认删除".into()),
            Step::Finished => Err("该操作已经结束".into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        io::Read,
        sync::atomic::{AtomicU64, Ordering},
    };
    static COUNT: AtomicU64 = AtomicU64::new(0);
    struct Temp(PathBuf);
    impl Temp {
        fn new() -> Self {
            Self(std::env::temp_dir().join(format!(
                "gpx-workflow-{}-{}",
                std::process::id(),
                COUNT.fetch_add(1, Ordering::Relaxed)
            )))
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn fixture() -> Value {
        serde_json::from_str(include_str!("../tests/fixtures/watch.json")).unwrap()
    }
    fn op(t: &Transition) -> &str {
        match &t.action {
            Action::Request(c) => c.op,
            _ => "finished",
        }
    }
    #[test]
    fn sync_advances_from_hello_to_list_and_finishes_without_a_waiter() {
        let f = fixture();
        let temp = Temp::new();
        let (mut w, t) = Workflow::new(&temp.0, "watch", Goal::Sync).unwrap();
        assert_eq!(op(&t), "hello");
        let t = w.accept(f["hello"]["result"].clone()).unwrap();
        assert_eq!(op(&t), "list");
        let Action::Request(call) = &t.action else {
            panic!("expected list request")
        };
        assert_eq!(call.fields["offset"], 0);
        assert_eq!(call.fields["limit"], 4);
        let t = w.accept(f["list"]["result"].clone()).unwrap();
        assert!(matches!(t.action, Action::Done));
        assert_eq!(t.files.unwrap().len(), 1);
        assert!(t.status.contains("同步完成"));
        assert!(w.accept(f["list"]["result"].clone()).is_err());
    }
    #[test]
    fn chunk_callbacks_preserve_altitude_and_resume_after_cancellation() {
        let f = fixture();
        let temp = Temp::new();
        let track: Track = serde_json::from_value(f["list"]["result"]["files"][0].clone()).unwrap();
        let (mut w, _) = Workflow::new(&temp.0, "watch", Goal::Download(track.clone())).unwrap();
        assert_eq!(op(&w.accept(f["hello"]["result"].clone()).unwrap()), "read");
        let next = w.accept(f["chunks"][0]["result"].clone()).unwrap();
        assert_eq!(next.progress.unwrap().0, 768);
        drop(w);
        let (mut w, _) = Workflow::new(&temp.0, "watch", Goal::Download(track.clone())).unwrap();
        let t = w.accept(f["hello"]["result"].clone()).unwrap();
        assert_eq!(t.progress.unwrap().0, 768);
        let mut last = None;
        for c in f["chunks"].as_array().unwrap().iter().skip(1) {
            last = Some(w.accept(c["result"].clone()).unwrap());
        }
        let Action::Export(exported) = last.unwrap().action else {
            panic!("expected export")
        };
        assert_eq!(exported.name, track.name);
        let mut output = String::new();
        Cache::new(&temp.0, "watch")
            .unwrap()
            .open_complete(&track)
            .unwrap()
            .read_to_string(&mut output)
            .unwrap();
        assert_eq!(output, f["gpx"].as_str().unwrap());
    }
    #[test]
    fn corrupt_chunk_retries_same_offset_and_stops_at_limit() {
        let f = fixture();
        let temp = Temp::new();
        let t: Track = serde_json::from_value(f["list"]["result"]["files"][0].clone()).unwrap();
        let (mut w, _) = Workflow::new(&temp.0, "watch", Goal::Download(t)).unwrap();
        w.accept(f["hello"]["result"].clone()).unwrap();
        let mut c = f["chunks"][0]["result"].clone();
        c["crc32"] = json!("00000000");
        for _ in 0..3 {
            let next = w.accept(c.clone()).unwrap();
            assert_eq!(next.progress.unwrap().0, 0);
        }
        assert!(w.accept(c).is_err());
    }
    #[test]
    fn batch_download_finishes_and_delete_is_a_separate_goal() {
        let f = fixture();
        let temp = Temp::new();
        let (mut w, _) = Workflow::new(&temp.0, "watch", Goal::All).unwrap();
        w.accept(f["hello"]["result"].clone()).unwrap();
        w.accept(f["list"]["result"].clone()).unwrap();
        let mut done = None;
        for c in f["chunks"].as_array().unwrap() {
            done = Some(w.accept(c["result"].clone()).unwrap());
        }
        assert!(matches!(done.unwrap().action, Action::Done));
        let t: Track = serde_json::from_value(f["list"]["result"]["files"][0].clone()).unwrap();
        let (mut d, _) = Workflow::new(&temp.0, "watch", Goal::Delete(t)).unwrap();
        assert_eq!(
            op(&d.accept(f["hello"]["result"].clone()).unwrap()),
            "delete"
        );
        assert!(matches!(
            d.accept(f["deletedAgain"]["result"].clone())
                .unwrap()
                .action,
            Action::Done
        ));
        assert_eq!(
            Cache::new(&temp.0, "watch")
                .unwrap()
                .entries()
                .unwrap()
                .len(),
            1
        );
    }
    #[test]
    fn delete_all_lists_every_page_then_waits_for_confirmation_and_deletes_snapshot() {
        let f = fixture();
        let temp = Temp::new();
        let original: Track =
            serde_json::from_value(f["list"]["result"]["files"][0].clone()).unwrap();
        let tracks: Vec<_> = (0..5)
            .map(|i| {
                let mut t = original.clone();
                t.name = format!("track-{i}.gpx");
                t
            })
            .collect();
        let (mut w, _) = Workflow::new(&temp.0, "watch", Goal::DeleteAll).unwrap();
        assert_eq!(op(&w.accept(f["hello"]["result"].clone()).unwrap()), "list");
        let t = w
            .accept(json!({"files":&tracks[..4],"nextOffset":4,"total":5}))
            .unwrap();
        let Action::Request(call) = t.action else {
            panic!("expected another page")
        };
        assert_eq!(call.op, "list");
        assert_eq!(call.fields["offset"], 4);
        let t = w
            .accept(json!({"files":&tracks[4..],"nextOffset":null,"total":5}))
            .unwrap();
        assert!(matches!(t.action, Action::ConfirmDelete(5)));
        assert_eq!(t.files.unwrap(), tracks);
        assert!(w.accept(json!({})).is_err());
        let mut t = w.confirm_deletion().unwrap();
        assert!(w.confirm_deletion().is_err());
        for track in tracks {
            let Action::Request(call) = t.action else {
                panic!("expected deletion")
            };
            assert_eq!(call.op, "delete");
            assert_eq!(call.fields["name"], track.name);
            assert_eq!(call.fields["etag"], track.etag);
            if w.index == 1 {
                assert!(w.failure_message("连接中断".into()).contains("1/5"));
            }
            // Replayed deletion after a lost reply reports false and is still success.
            t = w
                .accept(json!({"name":track.name,"deleted":false}))
                .unwrap();
        }
        assert!(matches!(t.action, Action::Done));
        assert!(t.status.contains("5 条"));
    }
    #[test]
    fn delete_all_empty_list_needs_no_confirmation_and_wrong_reply_does_not_advance() {
        let f = fixture();
        let temp = Temp::new();
        let (mut w, _) = Workflow::new(&temp.0, "watch", Goal::DeleteAll).unwrap();
        w.accept(f["hello"]["result"].clone()).unwrap();
        assert!(matches!(
            w.accept(json!({"files":[],"nextOffset":null,"total":0}))
                .unwrap()
                .action,
            Action::Done
        ));
        let t: Track = serde_json::from_value(f["list"]["result"]["files"][0].clone()).unwrap();
        let (mut w, _) = Workflow::new(&temp.0, "watch", Goal::Delete(t.clone())).unwrap();
        w.accept(f["hello"]["result"].clone()).unwrap();
        assert!(
            w.accept(json!({"name":"track-wrong.gpx","deleted":true}))
                .is_err()
        );
        assert_eq!(w.index, 0);
        assert!(matches!(
            w.accept(json!({"name":t.name,"deleted":true}))
                .unwrap()
                .action,
            Action::Done
        ));
    }
}
