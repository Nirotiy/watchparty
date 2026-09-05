//! Controlled temporary storage for downloaded external subtitles.
//!
//! The WebView never sees subtitle content or paths. Files are written by the
//! native session into a session-scoped directory under the OS temp root, with
//! generated names and a strict format whitelist, and are deleted when the
//! media changes or the session stops. libmpv may still hold a handle for a
//! moment during media swaps, so directory removal is best-effort with a
//! per-store backlog that is retried on the next retirement or at cleanup.

use crate::transport::SubtitleTrackInfo;
use std::path::PathBuf;

/// Client-side mirror of the server's 5 MiB subtitle guard; anything larger is
/// rejected before it reaches disk.
pub const MAX_SUBTITLE_BYTES: usize = 8 * 1024 * 1024;
/// Upper bound on external tracks attached to a single media load.
pub const MAX_TRACKS: usize = 8;

const ALLOWED_FORMATS: [&str; 4] = ["ass", "ssa", "srt", "vtt"];

pub fn format_allowed(format: &str) -> bool {
    ALLOWED_FORMATS.contains(&format.to_ascii_lowercase().as_str())
}

#[derive(Clone, Debug, PartialEq)]
pub struct PreparedSubtitle {
    pub path: PathBuf,
    pub title: String,
    pub language: Option<String>,
}

#[derive(Default)]
pub struct SubtitleStore {
    root: PathBuf,
    active: Option<PathBuf>,
    retired: Vec<PathBuf>,
    prepared: Vec<PreparedSubtitle>,
}

impl SubtitleStore {
    /// Root directory shared by all sessions; each generation gets its own
    /// uniquely named subdirectory.
    pub fn new() -> Self {
        Self::with_root(std::env::temp_dir().join("watchparty-subs"))
    }

    pub fn with_root(root: PathBuf) -> Self {
        Self {
            root,
            ..Self::default()
        }
    }

    /// Subtitles prepared for the current media load, in discovery order.
    pub fn prepared(&self) -> &[PreparedSubtitle] {
        &self.prepared
    }

    /// Writes downloaded subtitle payloads into a fresh per-generation
    /// directory. The previous directory is retired first. Per-track failures
    /// (bad format, oversized, unwritable) skip only that track.
    pub fn ingest(&mut self, generation: u64, payloads: &[(SubtitleTrackInfo, Vec<u8>)]) {
        self.retire();
        let directory = self
            .root
            .join(format!("subs-{}-{generation}", uuid::Uuid::new_v4()));
        if std::fs::create_dir_all(&directory).is_err() {
            return;
        }
        let mut prepared = Vec::new();
        for (index, (track, bytes)) in payloads.iter().take(MAX_TRACKS).enumerate() {
            if !format_allowed(&track.format)
                || bytes.is_empty()
                || bytes.len() > MAX_SUBTITLE_BYTES
            {
                continue;
            }
            // Generated name from a whitelisted extension: no path traversal.
            let path = directory.join(format!("sub-{index}.{}", track.format));
            if std::fs::write(&path, bytes).is_err() {
                continue;
            }
            prepared.push(PreparedSubtitle {
                path,
                title: track.label.clone(),
                language: track.language.clone(),
            });
        }
        self.prepared = prepared;
        self.active = Some(directory);
    }

    /// Drops the prepared list and queues the active directory for deletion.
    pub fn retire(&mut self) {
        self.prepared.clear();
        if let Some(directory) = self.active.take() {
            self.retired.push(directory);
        }
        self.retry_retired();
    }

    /// Deletes everything this store created. Best-effort: files still held by
    /// the player may survive and remain in the OS temp directory.
    pub fn cleanup(&mut self) {
        self.prepared.clear();
        if let Some(directory) = self.active.take() {
            self.retired.push(directory);
        }
        self.retry_retired();
        if self.retired.is_empty() {
            let _ = std::fs::remove_dir(&self.root);
        }
    }

    fn retry_retired(&mut self) {
        self.retired
            .retain(|directory| std::fs::remove_dir_all(directory).is_err());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn track(label: &str, format: &str) -> SubtitleTrackInfo {
        SubtitleTrackInfo {
            media_id: format!("signed:{label}"),
            label: label.into(),
            language: None,
            format: format.into(),
        }
    }

    fn unique_root() -> PathBuf {
        std::env::temp_dir().join(format!("watchparty-subs-test-{}", uuid::Uuid::new_v4()))
    }

    #[test]
    fn ingest_writes_whitelisted_files_and_reports_them() {
        let mut store = SubtitleStore::with_root(unique_root());
        store.ingest(
            1,
            &[
                (
                    SubtitleTrackInfo {
                        language: Some("chs".into()),
                        ..track("Show 01.chs.ass", "ass")
                    },
                    b"[Script Info]\n".to_vec(),
                ),
                (
                    track("Show 01.srt", "srt"),
                    b"1\n00:00:00,000 --> 00:00:01,000\nhi\n".to_vec(),
                ),
            ],
        );
        assert_eq!(store.prepared().len(), 2);
        for subtitle in store.prepared() {
            assert!(subtitle.path.starts_with(&store.root));
            assert!(subtitle.path.is_file());
        }
        assert_eq!(store.prepared()[0].language.as_deref(), Some("chs"));
        assert_eq!(store.prepared()[0].title, "Show 01.chs.ass");
        assert_eq!(
            store.prepared()[1]
                .path
                .extension()
                .and_then(|e| e.to_str()),
            Some("srt")
        );
        store.cleanup();
        assert!(!store.root.exists());
    }

    #[test]
    fn ingest_skips_unknown_formats_and_oversized_payloads() {
        let mut store = SubtitleStore::with_root(unique_root());
        store.ingest(
            1,
            &[
                (track("malicious.exe", "exe"), b"MZ".to_vec()),
                (track("huge.ass", "ass"), vec![b'x'; MAX_SUBTITLE_BYTES + 1]),
                (track("empty.srt", "srt"), Vec::new()),
                (track("ok.srt", "SRT"), b"1\n".to_vec()),
            ],
        );
        assert_eq!(store.prepared().len(), 1);
        assert_eq!(store.prepared()[0].title, "ok.srt");
        store.cleanup();
    }

    #[test]
    fn ingest_caps_the_track_count() {
        let mut store = SubtitleStore::with_root(unique_root());
        let payloads = (0..MAX_TRACKS + 4)
            .map(|index| (track(&format!("t{index}.srt"), "srt"), b"1\n".to_vec()))
            .collect::<Vec<_>>();
        store.ingest(1, &payloads);
        assert_eq!(store.prepared().len(), MAX_TRACKS);
        store.cleanup();
    }

    #[test]
    fn retire_deletes_the_previous_generation_directory() {
        let mut store = SubtitleStore::with_root(unique_root());
        store.ingest(1, &[(track("a.srt", "srt"), b"1\n".to_vec())]);
        let first = store.prepared()[0].path.clone();
        store.retire();
        assert!(store.prepared().is_empty());
        assert!(!first.exists());
        store.ingest(2, &[(track("b.srt", "srt"), b"1\n".to_vec())]);
        assert_eq!(store.prepared().len(), 1);
        store.cleanup();
    }

    #[test]
    fn failed_ingest_leaves_no_prepared_subtitles() {
        // A file occupying the target directory path makes create_dir_all fail.
        let root = unique_root();
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("occupied"), b"x").unwrap();
        let mut store = SubtitleStore {
            root: root.join("occupied"),
            ..SubtitleStore::default()
        };
        store.ingest(1, &[(track("a.srt", "srt"), b"1\n".to_vec())]);
        assert!(store.prepared().is_empty());
        store.cleanup();
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn format_whitelist_matches_the_server_contract() {
        for format in ["ass", "ssa", "srt", "vtt", "ASS", "Vtt"] {
            assert!(format_allowed(format));
        }
        for format in ["", "exe", "shtml", "m3u8", "ass .exe"] {
            assert!(!format_allowed(format));
        }
    }
}
