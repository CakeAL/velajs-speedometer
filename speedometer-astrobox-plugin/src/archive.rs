//! Disk-backed ZIP export: GPX bytes and filenames are preserved, memory stays bounded.
use crate::cache::{Cache, Entry};
use std::{
    collections::HashSet,
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};
use zip::{CompressionMethod, ZipWriter, write::SimpleFileOptions};

pub struct Archive {
    pub file: File,
    path: PathBuf,
}
impl Drop for Archive {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

pub fn prepare(
    cache: &Cache,
    entries: &[Entry],
    path: &Path,
    mut check: impl FnMut() -> Result<(), String>,
) -> Result<Archive, String> {
    if entries.is_empty() {
        return Err("暂无可导出的完整轨迹，请先下载轨迹".into());
    }
    let result = (|| {
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(true)
            .open(path)
            .map_err(|e| format!("创建 ZIP 失败：{e}"))?;
        let mut zip = ZipWriter::new(file);
        let mut names = HashSet::new();
        let mut buffer = [0; 16_384];
        for entry in entries {
            check()?;
            if !entry.complete || !names.insert(&entry.track.name) {
                return Err("导出列表包含未完成或重复轨迹".into());
            }
            // Check CRC before starting this entry; never package damaged cache bytes.
            let mut source = cache.open_complete(&entry.track)?;
            zip.start_file(
                &entry.track.name,
                SimpleFileOptions::default()
                    .compression_method(CompressionMethod::Stored)
                    .large_file(entry.track.bytes >= u32::MAX as u64),
            )
            .map_err(|e| format!("打包轨迹失败：{e}"))?;
            loop {
                check()?;
                let n = source
                    .read(&mut buffer)
                    .map_err(|e| format!("读取轨迹失败：{e}"))?;
                if n == 0 {
                    break;
                }
                zip.write_all(&buffer[..n])
                    .map_err(|e| format!("写入 ZIP 失败：{e}"))?;
            }
        }
        check()?;
        let mut file = zip.finish().map_err(|e| format!("完成 ZIP 失败：{e}"))?;
        file.sync_all().map_err(|e| format!("保存 ZIP 失败：{e}"))?;
        file.seek(SeekFrom::Start(0))
            .map_err(|e| format!("读取 ZIP 失败：{e}"))?;
        Ok(Archive {
            file,
            path: path.into(),
        })
    })();
    if result.is_err() {
        let _ = fs::remove_file(path);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::Track;
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNT: AtomicU64 = AtomicU64::new(0);
    struct Temp(PathBuf);
    impl Temp {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "gpx-zip-{}-{}",
                std::process::id(),
                COUNT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn cache(temp: &Temp) -> (Cache, Vec<Entry>, Vec<Vec<u8>>) {
        let bytes = vec![
            "<gpx><ele>-12.50</ele><name>中文轨迹</name></gpx>"
                .as_bytes()
                .to_vec(),
            vec![b'x'; 40_000],
        ];
        for (i, data) in bytes.iter().enumerate() {
            let track = Track {
                name: format!("track-{i}.gpx"),
                bytes: data.len() as u64,
                modified_at: 1,
                display_time: "test".into(),
                etag: format!("{i}"),
            };
            let mut d = Cache::new(&temp.0, "watch").unwrap().begin(&track).unwrap();
            d.append(data).unwrap();
            d.finish().unwrap();
        }
        let cache = Cache::new(&temp.0, "watch").unwrap();
        let entries = cache.entries().unwrap();
        (cache, entries, bytes)
    }
    #[test]
    fn zip_roundtrip_preserves_every_filename_and_gpx_byte_and_cleans_temporary_file() {
        let temp = Temp::new();
        let (cache, entries, expected) = cache(&temp);
        let path = temp.0.join("export.tmp");
        let archive = prepare(&cache, &entries, &path, || Ok(())).unwrap();
        let mut reader = zip::ZipArchive::new(archive.file.try_clone().unwrap()).unwrap();
        assert_eq!(reader.len(), 2);
        for (i, expected) in expected.iter().enumerate() {
            let mut data = vec![];
            reader
                .by_name(&format!("track-{i}.gpx"))
                .unwrap()
                .read_to_end(&mut data)
                .unwrap();
            assert_eq!(&data, expected);
        }
        // Verify with an independent implementation on development machines.
        if let Ok(output) = std::process::Command::new("python3").args(["-c", "import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); assert len(z.namelist())==2; assert z.testzip() is None; assert b'<ele>-12.50</ele>' in z.read('track-0.gpx')"]).arg(&path).output() {
            assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        }
        drop(reader);
        drop(archive);
        assert!(!path.exists());
        assert_eq!(cache.entries().unwrap().len(), 2);
    }
    #[test]
    fn cancelled_corrupt_empty_or_partial_exports_do_not_leave_a_zip() {
        let temp = Temp::new();
        let (cache, mut entries, _) = cache(&temp);
        let path = temp.0.join("export.tmp");
        assert!(prepare(&cache, &[], &path, || Ok(())).is_err());
        let mut calls = 0;
        assert!(
            prepare(&cache, &entries, &path, || {
                calls += 1;
                if calls > 2 {
                    Err("cancelled".into())
                } else {
                    Ok(())
                }
            })
            .is_err()
        );
        assert!(!path.exists());
        entries[0].complete = false;
        assert!(prepare(&cache, &entries, &path, || Ok(())).is_err());
        assert!(!path.exists());
        entries[0].complete = true;
        fs::write(
            temp.0.join("7761746368").join(&entries[0].track.name),
            b"corrupt",
        )
        .unwrap();
        assert!(prepare(&cache, &entries, &path, || Ok(())).is_err());
        assert!(!path.exists());
    }
}
