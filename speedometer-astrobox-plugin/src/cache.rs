use crate::protocol::{Track, valid_name};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};

fn io_error(error: impl std::fmt::Display) -> String {
    format!("本地文件操作失败：{error}")
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Entry {
    pub track: Track,
    pub offset: u64,
    pub crc32: u32,
    pub complete: bool,
}

pub struct Cache {
    dir: PathBuf,
}
pub struct Download {
    cache: Cache,
    pub entry: Entry,
    file: File,
    hash: crc32fast::Hasher,
}

impl Cache {
    pub fn new(root: &Path, addr: &str) -> Result<Self, String> {
        if addr.is_empty() || addr.len() > 256 {
            return Err("设备标识无效".into());
        }
        let key: String = addr.bytes().map(|b| format!("{b:02x}")).collect();
        let dir = root.join(key);
        fs::create_dir_all(&dir).map_err(io_error)?;
        Ok(Self { dir })
    }
    fn path(&self, name: &str, suffix: &str) -> Result<PathBuf, String> {
        if !valid_name(name) {
            return Err("轨迹文件名无效".into());
        }
        Ok(self.dir.join(format!("{name}{suffix}")))
    }
    fn checkpoint(&self, entry: &Entry) -> Result<(), String> {
        let json = serde_json::to_vec(entry).map_err(io_error)?;
        let temp = self.path(&entry.track.name, ".json.tmp")?;
        let mut file = File::create(&temp).map_err(io_error)?;
        file.write_all(&json).map_err(io_error)?;
        file.sync_all().map_err(io_error)?;
        fs::rename(temp, self.path(&entry.track.name, ".json")?).map_err(io_error)
    }
    pub fn entries(&self) -> Result<Vec<Entry>, String> {
        let mut entries = vec![];
        for item in fs::read_dir(&self.dir).map_err(io_error)? {
            let item = item.map_err(io_error)?;
            if item.path().extension().is_none_or(|s| s != "json") {
                continue;
            }
            let Ok(bytes) = fs::read(item.path()) else {
                continue;
            };
            let Ok(entry) = serde_json::from_slice::<Entry>(&bytes) else {
                continue;
            };
            if entry.track.validate().is_err() || entry.offset > entry.track.bytes {
                continue;
            }
            let suffix = if entry.complete { "" } else { ".part" };
            let path = self.path(&entry.track.name, suffix)?;
            if path.metadata().is_ok_and(|m| m.len() >= entry.offset)
                && (!entry.complete || entry.offset == entry.track.bytes)
            {
                entries.push(entry);
            }
        }
        entries.sort_by(|a, b| {
            b.track
                .modified_at
                .cmp(&a.track.modified_at)
                .then_with(|| a.track.name.cmp(&b.track.name))
        });
        Ok(entries)
    }
    pub fn complete(&self, track: &Track) -> bool {
        self.entries().unwrap_or_default().iter().any(|e| {
            e.complete
                && e.track.name == track.name
                && e.track.etag == track.etag
                && e.track.bytes == track.bytes
        })
    }
    pub fn open_complete(&self, track: &Track) -> Result<File, String> {
        let entry = self
            .entries()?
            .into_iter()
            .find(|e| e.complete && e.track == *track)
            .ok_or("该轨迹尚未下载完成")?;
        let mut file = File::open(self.path(&track.name, "")?).map_err(io_error)?;
        let (len, hash) = hash_file(&mut file, None)?;
        if len != track.bytes || hash.finalize() != entry.crc32 {
            return Err("本地轨迹校验失败，请重新下载".into());
        }
        file.seek(SeekFrom::Start(0)).map_err(io_error)?;
        Ok(file)
    }
    pub fn begin(self, track: &Track) -> Result<Download, String> {
        track.validate()?;
        let part = self.path(&track.name, ".part")?;
        let previous = self.entries()?.into_iter().find(|e| {
            !e.complete
                && e.track.name == track.name
                && e.track.etag == track.etag
                && e.track.bytes == track.bytes
        });
        let mut file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(part)
            .map_err(io_error)?;
        let mut hash = crc32fast::Hasher::new();
        let mut offset = 0;
        if let Some(entry) = previous {
            if let Ok((len, candidate)) = hash_file(&mut file, Some(entry.offset)) {
                if len == entry.offset && candidate.clone().finalize() == entry.crc32 {
                    offset = entry.offset;
                    hash = candidate;
                }
            }
        }
        // A crash can leave bytes beyond the committed checkpoint; never append those twice.
        file.set_len(offset).map_err(io_error)?;
        file.seek(SeekFrom::Start(offset)).map_err(io_error)?;
        let entry = Entry {
            track: track.clone(),
            offset,
            crc32: hash.clone().finalize(),
            complete: false,
        };
        self.checkpoint(&entry)?;
        Ok(Download {
            cache: self,
            entry,
            file,
            hash,
        })
    }
}

fn hash_file(file: &mut File, limit: Option<u64>) -> Result<(u64, crc32fast::Hasher), String> {
    file.seek(SeekFrom::Start(0)).map_err(io_error)?;
    let mut hasher = crc32fast::Hasher::new();
    let mut offset = 0;
    let mut buffer = [0; 8192];
    loop {
        let n = limit.map_or(buffer.len(), |limit| {
            (limit.saturating_sub(offset).min(buffer.len() as u64)) as usize
        });
        if n == 0 {
            break;
        }
        let count = file.read(&mut buffer[..n]).map_err(io_error)?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
        offset += count as u64;
    }
    Ok((offset, hasher))
}

impl Download {
    pub fn append(&mut self, bytes: &[u8]) -> Result<(), String> {
        let next = self
            .entry
            .offset
            .checked_add(bytes.len() as u64)
            .ok_or("文件长度溢出")?;
        if next > self.entry.track.bytes {
            return Err("轨迹长度超过预期".into());
        }
        self.file.write_all(bytes).map_err(io_error)?;
        self.file.sync_data().map_err(io_error)?;
        self.hash.update(bytes);
        self.entry.offset = next;
        self.entry.crc32 = self.hash.clone().finalize();
        self.cache.checkpoint(&self.entry)
    }
    pub fn finish(mut self) -> Result<(), String> {
        if self.entry.offset != self.entry.track.bytes {
            return Err("轨迹尚未接收完整".into());
        }
        self.file.sync_all().map_err(io_error)?;
        // Persist the file first. An interrupted promotion will be re-downloaded safely.
        fs::rename(
            self.cache.path(&self.entry.track.name, ".part")?,
            self.cache.path(&self.entry.track.name, "")?,
        )
        .map_err(io_error)?;
        self.entry.complete = true;
        self.cache.checkpoint(&self.entry)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    struct Temp(PathBuf);
    impl Temp {
        fn new() -> Self {
            Self(std::env::temp_dir().join(format!(
                "speedometer-test-{}-{}",
                std::process::id(),
                COUNTER.fetch_add(1, Ordering::Relaxed)
            )))
        }
        fn cache(&self, addr: &str) -> Cache {
            Cache::new(&self.0, addr).unwrap()
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn track(bytes: u64) -> Track {
        Track {
            name: "track-test.gpx".into(),
            bytes,
            modified_at: 123,
            display_time: "test".into(),
            etag: format!("{bytes}:123"),
        }
    }
    #[test]
    fn interrupted_download_resumes_and_truncates_uncommitted_tail() {
        let temp = Temp::new();
        let t = track(9);
        let mut d = temp.cache("watch").begin(&t).unwrap();
        d.append(b"1234").unwrap();
        drop(d);
        let cache = temp.cache("watch");
        OpenOptions::new()
            .append(true)
            .open(cache.path(&t.name, ".part").unwrap())
            .unwrap()
            .write_all(b"crash")
            .unwrap();
        let mut d = cache.begin(&t).unwrap();
        assert_eq!(d.entry.offset, 4);
        d.append(b"56789").unwrap();
        d.finish().unwrap();
        let mut f = temp.cache("watch").open_complete(&t).unwrap();
        let mut bytes = vec![];
        f.read_to_end(&mut bytes).unwrap();
        assert_eq!(bytes, b"123456789");
    }
    #[test]
    fn file_changes_and_corrupt_partial_restart_at_zero() {
        let temp = Temp::new();
        let t = track(9);
        let mut d = temp.cache("watch").begin(&t).unwrap();
        d.append(b"1234").unwrap();
        drop(d);
        fs::write(temp.cache("watch").path(&t.name, ".part").unwrap(), b"oops").unwrap();
        let d = temp.cache("watch").begin(&t).unwrap();
        assert_eq!(d.entry.offset, 0);
        drop(d);
        let mut changed = t.clone();
        changed.etag = "9:124".into();
        assert_eq!(temp.cache("watch").begin(&changed).unwrap().entry.offset, 0);
    }
    #[test]
    fn rejects_incomplete_promotion_and_corrupt_complete_files() {
        let temp = Temp::new();
        let t = track(4);
        let mut d = temp.cache("watch").begin(&t).unwrap();
        d.append(b"12").unwrap();
        assert!(d.finish().is_err());
        let mut d = temp.cache("watch").begin(&t).unwrap();
        d.append(b"34").unwrap();
        d.finish().unwrap();
        fs::write(temp.cache("watch").path(&t.name, "").unwrap(), b"oops").unwrap();
        assert!(temp.cache("watch").open_complete(&t).is_err());
    }
    #[test]
    fn separates_device_caches_and_prevents_path_escape() {
        let temp = Temp::new();
        assert_ne!(temp.cache("a/b").dir, temp.cache("a_b").dir);
        let mut t = track(0);
        t.name = "track-../escape.gpx".into();
        assert!(temp.cache("watch").begin(&t).is_err());
        assert!(temp.cache("other").entries().unwrap().is_empty());
    }
}
