//! Minimal, typed libmpv client used by the desktop session worker.
//!
//! The DLL is loaded at runtime so the Rust crate can be built and tested without
//! copying a large third-party binary into Git. All libmpv calls stay on the one
//! session worker thread that owns `LibMpvPlayer`.

use crate::{
    config::PlayerPreferences,
    contracts::{NativeCapabilityReport, PlayerState, RoomSnapshot, Track},
    playback::{PlaybackLoad, PlayerControlError, PlayerEndReason, PlayerEngine, PlayerEvent},
};
use std::{
    collections::{HashMap, VecDeque},
    env,
    ffi::{c_char, c_int, c_void, CStr, CString},
    fmt,
    path::{Path, PathBuf},
    ptr,
};

const MPV_FORMAT_FLAG: c_int = 3;
const MPV_FORMAT_INT64: c_int = 4;
const MPV_FORMAT_DOUBLE: c_int = 5;

const MPV_EVENT_NONE: c_int = 0;
const MPV_EVENT_SHUTDOWN: c_int = 1;
const MPV_EVENT_START_FILE: c_int = 6;
const MPV_EVENT_END_FILE: c_int = 7;
const MPV_EVENT_FILE_LOADED: c_int = 8;
const MPV_EVENT_VIDEO_RECONFIG: c_int = 17;
const MPV_EVENT_AUDIO_RECONFIG: c_int = 18;
const MPV_EVENT_PLAYBACK_RESTART: c_int = 21;
const MPV_EVENT_QUEUE_OVERFLOW: c_int = 24;

const MPV_END_FILE_REASON_EOF: c_int = 0;
const MPV_END_FILE_REASON_STOP: c_int = 2;
const MPV_END_FILE_REASON_ERROR: c_int = 4;

const DEFAULT_LIBMPV_NAME: &str = "libmpv-2.dll";

/// Preference writes that take effect immediately on a live player. Ordered and
/// pure so the mapping stays unit-testable without a loaded libmpv.
pub fn immediate_property_writes(prefs: &PlayerPreferences) -> Vec<(&'static str, String)> {
    let mut writes: Vec<(&'static str, String)> = vec![("deinterlace", prefs.deinterlace.clone())];
    match prefs.hdr.as_str() {
        "sdr" => writes.push(("tone-mapping", "bt.2390".into())),
        "passthrough" => writes.push(("target-colorspace-hint", "yes".into())),
        _ => {}
    }
    writes.push((
        "audio-channels",
        if prefs.channel_layout == "stereo" {
            "stereo"
        } else {
            "auto-safe"
        }
        .into(),
    ));
    writes.push(("audio-device", prefs.audio_device.as_deref().unwrap_or("auto").to_owned()));
    let font = prefs.subtitle_font.trim();
    if !font.is_empty() {
        writes.push(("sub-font", font.to_owned()));
    }
    writes.push(("sub-scale", prefs.subtitle_scale.to_string()));
    writes.push((
        "sub-ass-override",
        if prefs.subtitle_ass_override {
            "yes"
        } else {
            "no"
        }
        .into(),
    ));
    writes.push(("sub-delay", prefs.subtitle_delay.to_string()));
    writes
}

/// Preference writes consumed by mpv when the next media loads (track language
/// selection and per-connection network options).
pub fn next_load_property_writes(prefs: &PlayerPreferences) -> Vec<(&'static str, String)> {
    let mut writes: Vec<(&'static str, String)> = Vec::new();
    let slang = prefs.subtitle_language.trim();
    if !slang.is_empty() {
        writes.push(("slang", slang.to_owned()));
    }
    let alang = prefs.audio_language.trim();
    if !alang.is_empty() {
        writes.push(("alang", alang.to_owned()));
    }
    writes.push(("network-timeout", prefs.network_timeout.to_string()));
    // The subtitle delay is a current-media adjustment: every media load
    // re-applies the stored value (default 0) so a per-media delta never
    // leaks into the next item.
    writes.push(("sub-delay", prefs.subtitle_delay.to_string()));
    writes
}

/// Options fixed when the player is created; changing them requires a player
/// rebuild (cache profile, hardware decoding).
fn open_options(prefs: &PlayerPreferences) -> Vec<(&'static str, String)> {
    let mut options: Vec<(&'static str, String)> = vec![("hwdec", prefs.hardware_decoding.clone())];
    match prefs.cache_profile.as_str() {
        "low-latency" => options.push(("cache", "no".into())),
        "stable" => {
            options.push(("cache", "yes".into()));
            options.push(("cache-secs", "120".into()));
        }
        _ => {}
    }
    options
}

#[derive(Clone, Debug, PartialEq)]
pub struct LibMpvConfig {
    pub dll_path: PathBuf,
    pub window_handle: usize,
    /// Whitelisted preferences applied when the player is created.
    pub preferences: PlayerPreferences,
    pub tls_ca_file: Option<PathBuf>,
    /// MusicParty uses the shared engine without rendering any video track.
    pub audio_only: bool,
}

impl LibMpvConfig {
    pub fn from_env(window_handle: usize) -> Result<Self, LibMpvError> {
        let dll_path = match env::var_os("WATCHPARTY_LIBMPV_PATH") {
            Some(value) => PathBuf::from(value),
            None => {
                let beside_executable = env::current_exe()
                    .map_err(|_| LibMpvError::configuration())?
                    .parent()
                    .map(|directory| directory.join(DEFAULT_LIBMPV_NAME))
                    .ok_or_else(LibMpvError::configuration)?;
                let local_runtime = env::var_os("LOCALAPPDATA").map(|directory| {
                    PathBuf::from(directory)
                        .join("WatchParty")
                        .join("runtime")
                        .join(DEFAULT_LIBMPV_NAME)
                });
                if beside_executable.is_file() {
                    beside_executable
                } else {
                    local_runtime.unwrap_or(beside_executable)
                }
            }
        };
        Self::new(dll_path, window_handle)
    }

    pub fn new(dll_path: PathBuf, window_handle: usize) -> Result<Self, LibMpvError> {
        if !dll_path.is_absolute() || window_handle == 0 {
            return Err(LibMpvError::configuration());
        }
        Ok(Self {
            dll_path,
            window_handle,
            preferences: PlayerPreferences::default(),
            tls_ca_file: None,
            audio_only: false,
        })
    }

    /// Replaces the preference set applied when the player is created.
    pub fn with_preferences(mut self, preferences: PlayerPreferences) -> Self {
        self.preferences = preferences;
        self
    }

    pub fn with_tls_ca_file(mut self, path: Option<PathBuf>) -> Self {
        self.tls_ca_file = path;
        self
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LibMpvError {
    pub code: &'static str,
    pub message: &'static str,
}

impl LibMpvError {
    fn configuration() -> Self {
        Self {
            code: "LIBMPV_CONFIGURATION_INVALID",
            message: "libmpv 配置无效",
        }
    }

    fn unavailable() -> Self {
        Self {
            code: "LIBMPV_UNAVAILABLE",
            message: "未找到可用的 libmpv 运行时",
        }
    }

    fn initialization() -> Self {
        Self {
            code: "LIBMPV_INITIALIZATION_FAILED",
            message: "libmpv 初始化失败",
        }
    }

    fn command() -> Self {
        Self {
            code: "LIBMPV_COMMAND_FAILED",
            message: "libmpv 命令执行失败",
        }
    }
}

impl fmt::Display for LibMpvError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.message)
    }
}

impl std::error::Error for LibMpvError {}

#[repr(C)]
struct MpvEvent {
    event_id: c_int,
    error: c_int,
    reply_userdata: u64,
    data: *mut c_void,
}

#[repr(C)]
struct MpvEventStartFile {
    playlist_entry_id: i64,
}

#[repr(C)]
struct MpvEventEndFile {
    reason: c_int,
    error: c_int,
    playlist_entry_id: i64,
    playlist_insert_id: i64,
    playlist_insert_num_entries: c_int,
}

type MpvHandle = c_void;
type MpvCreate = unsafe extern "C" fn() -> *mut MpvHandle;
type MpvInitialize = unsafe extern "C" fn(*mut MpvHandle) -> c_int;
type MpvSetOptionString =
    unsafe extern "C" fn(*mut MpvHandle, *const c_char, *const c_char) -> c_int;
type MpvSetProperty =
    unsafe extern "C" fn(*mut MpvHandle, *const c_char, c_int, *mut c_void) -> c_int;
type MpvSetPropertyString =
    unsafe extern "C" fn(*mut MpvHandle, *const c_char, *const c_char) -> c_int;
type MpvGetProperty =
    unsafe extern "C" fn(*mut MpvHandle, *const c_char, c_int, *mut c_void) -> c_int;
type MpvGetPropertyString = unsafe extern "C" fn(*mut MpvHandle, *const c_char) -> *mut c_char;
type MpvCommand = unsafe extern "C" fn(*mut MpvHandle, *const *const c_char) -> c_int;
type MpvWaitEvent = unsafe extern "C" fn(*mut MpvHandle, f64) -> *mut MpvEvent;
type MpvDestroy = unsafe extern "C" fn(*mut MpvHandle);
type MpvTerminateDestroy = unsafe extern "C" fn(*mut MpvHandle);
type MpvFree = unsafe extern "C" fn(*mut c_void);
type MpvFreeNodeContents = unsafe extern "C" fn(*mut MpvNode);

#[repr(C)]
union MpvNodeValue {
    string: *mut c_char,
    flag: c_int,
    int64: i64,
    double: f64,
    list: *mut MpvNodeList,
}
#[repr(C)]
struct MpvNode { value: MpvNodeValue, format: c_int }
#[repr(C)]
struct MpvNodeList { count: c_int, values: *mut MpvNode, keys: *mut *mut c_char }

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioOutputDevice { pub id: String, pub name: String }

/// A short-lived, media-free client enumerates outputs without changing the active player.
pub fn list_audio_output_devices(config: &LibMpvConfig) -> Result<Vec<AudioOutputDevice>, LibMpvError> {
    let library = NativeLibrary::load(&config.dll_path)?;
    let api = library.api;
    let handle = unsafe { (api.create)() };
    if handle.is_null() { return Err(LibMpvError::initialization()); }
    let result = (|| {
        for (key, value) in [("config", "no"), ("terminal", "no"), ("vo", "null"), ("vid", "no")] {
            let key = CString::new(key).unwrap();
            let value = CString::new(value).unwrap();
            if unsafe { (api.set_option_string)(handle, key.as_ptr(), value.as_ptr()) } < 0 { return Err(LibMpvError::initialization()); }
        }
        if unsafe { (api.initialize)(handle) } < 0 { return Err(LibMpvError::initialization()); }
        let mut node = MpvNode { value: MpvNodeValue { int64: 0 }, format: 0 };
        let key = CString::new("audio-device-list").unwrap();
        if unsafe { (api.get_property)(handle, key.as_ptr(), 6, &mut node as *mut _ as *mut c_void) } < 0 { return Err(LibMpvError::command()); }
        let devices = unsafe { read_audio_devices(&node) };
        unsafe { (api.free_node_contents)(&mut node) };
        devices
    })();
    unsafe { (api.terminate_destroy)(handle) };
    result
}

// Only traverse the documented array/map/string shape while libmpv owns the nodes.
unsafe fn read_audio_devices(node: &MpvNode) -> Result<Vec<AudioOutputDevice>, LibMpvError> {
    if node.format != 7 || node.value.list.is_null() { return Err(LibMpvError::command()); }
    let list = &*node.value.list;
    if !(0..=4096).contains(&list.count) || (list.count > 0 && list.values.is_null()) { return Err(LibMpvError::command()); }
    let mut devices = Vec::new();
    for index in 0..list.count as usize {
        let item = &*list.values.add(index);
        if item.format != 8 || item.value.list.is_null() { continue; }
        let fields = &*item.value.list;
        if !(0..=64).contains(&fields.count) || fields.values.is_null() || fields.keys.is_null() { continue; }
        let mut id = None;
        let mut name = None;
        for field in 0..fields.count as usize {
            let key = *fields.keys.add(field);
            let value = &*fields.values.add(field);
            if key.is_null() || value.format != 1 || value.value.string.is_null() { continue; }
            let text = CStr::from_ptr(value.value.string).to_string_lossy().into_owned();
            match CStr::from_ptr(key).to_bytes() { b"name" => id = Some(text), b"description" => name = Some(text), _ => {} }
        }
        if let Some(id) = id.filter(|id| !id.is_empty() && id != "auto") {
            if !devices.iter().any(|device: &AudioOutputDevice| device.id == id) {
                devices.push(AudioOutputDevice { name: name.filter(|name| !name.is_empty()).unwrap_or_else(|| id.clone()), id });
            }
        }
    }
    Ok(devices)
}

#[derive(Clone, Copy)]
struct MpvApi {
    create: MpvCreate,
    initialize: MpvInitialize,
    set_option_string: MpvSetOptionString,
    set_property: MpvSetProperty,
    set_property_string: MpvSetPropertyString,
    get_property: MpvGetProperty,
    get_property_string: MpvGetPropertyString,
    command: MpvCommand,
    wait_event: MpvWaitEvent,
    destroy: MpvDestroy,
    terminate_destroy: MpvTerminateDestroy,
    free: MpvFree,
    free_node_contents: MpvFreeNodeContents,
}

#[cfg(windows)]
mod dynamic_library {
    use super::*;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::{
        Foundation::{FreeLibrary, HMODULE},
        System::LibraryLoader::{GetProcAddress, LoadLibraryW},
    };

    pub struct NativeLibrary {
        module: HMODULE,
        pub api: MpvApi,
    }

    impl NativeLibrary {
        pub fn load(path: &Path) -> Result<Self, LibMpvError> {
            let wide = path
                .as_os_str()
                .encode_wide()
                .chain(std::iter::once(0))
                .collect::<Vec<_>>();
            let module = unsafe { LoadLibraryW(wide.as_ptr()) };
            if module.is_null() {
                return Err(LibMpvError::unavailable());
            }

            macro_rules! load {
                ($name:literal, $kind:ty) => {{
                    let address = unsafe { GetProcAddress(module, concat!($name, "\0").as_ptr()) };
                    let Some(address) = address else {
                        unsafe { FreeLibrary(module) };
                        return Err(LibMpvError::unavailable());
                    };
                    unsafe {
                        std::mem::transmute::<unsafe extern "system" fn() -> isize, $kind>(address)
                    }
                }};
            }

            let api = MpvApi {
                create: load!("mpv_create", MpvCreate),
                initialize: load!("mpv_initialize", MpvInitialize),
                set_option_string: load!("mpv_set_option_string", MpvSetOptionString),
                set_property: load!("mpv_set_property", MpvSetProperty),
                set_property_string: load!("mpv_set_property_string", MpvSetPropertyString),
                get_property: load!("mpv_get_property", MpvGetProperty),
                get_property_string: load!("mpv_get_property_string", MpvGetPropertyString),
                command: load!("mpv_command", MpvCommand),
                wait_event: load!("mpv_wait_event", MpvWaitEvent),
                destroy: load!("mpv_destroy", MpvDestroy),
                terminate_destroy: load!("mpv_terminate_destroy", MpvTerminateDestroy),
                free: load!("mpv_free", MpvFree),
                free_node_contents: load!("mpv_free_node_contents", MpvFreeNodeContents),
            };
            Ok(Self { module, api })
        }
    }

    impl Drop for NativeLibrary {
        fn drop(&mut self) {
            unsafe { FreeLibrary(self.module) };
        }
    }
}

#[cfg(not(windows))]
mod dynamic_library {
    use super::*;

    pub struct NativeLibrary {
        pub api: MpvApi,
    }

    impl NativeLibrary {
        pub fn load(_path: &Path) -> Result<Self, LibMpvError> {
            Err(LibMpvError::unavailable())
        }
    }
}

use dynamic_library::NativeLibrary;

#[derive(Clone)]
struct LoadIdentity {
    generation: u64,
    playlist_item_id: Option<String>,
    /// External subtitles (controlled temp paths) attached to this load.
    subtitles: Vec<crate::subtitles::PreparedSubtitle>,
}

pub struct LibMpvPlayer {
    library: NativeLibrary,
    handle: *mut MpvHandle,
    state: PlayerState,
    capability: NativeCapabilityReport,
    preferences: PlayerPreferences,
    pending_loads: VecDeque<LoadIdentity>,
    entry_loads: HashMap<i64, LoadIdentity>,
    active_entry_id: Option<i64>,
    queued_events: Vec<PlayerEvent>,
    initialized: bool,
    disposed: bool,
}

// The player is created, used, and destroyed by the same session worker. The
// marker is needed only because native handles are intentionally opaque pointers.
unsafe impl Send for LibMpvPlayer {}

impl LibMpvPlayer {
    pub fn open(config: &LibMpvConfig) -> Result<Self, LibMpvError> {
        let library = NativeLibrary::load(&config.dll_path)?;
        let api = library.api;
        let handle = unsafe { (api.create)() };
        if handle.is_null() {
            return Err(LibMpvError::initialization());
        }

        let mut player = Self {
            library,
            handle,
            state: PlayerState {
                rate: 1.0,
                volume: 100.0,
                ..PlayerState::default()
            },
            capability: NativeCapabilityReport {
                libmpv_ready: true,
                vo: Some("gpu-next".into()),
                hwdec_configured: Some(config.preferences.hardware_decoding.clone()),
                ..NativeCapabilityReport::default()
            },
            preferences: config.preferences.clone(),
            pending_loads: VecDeque::new(),
            entry_loads: HashMap::new(),
            active_entry_id: None,
            queued_events: Vec::new(),
            initialized: false,
            disposed: false,
        };

        for (name, value) in [
            ("config", "no"),
            ("terminal", "no"),
            ("input-default-bindings", "no"),
            ("input-vo-keyboard", "no"),
            ("osc", "no"),
            ("idle", "yes"),
            ("keep-open", "no"),
            ("pause", "yes"),
            ("vo", "gpu-next"),
            // mpv does not enable TLS certificate verification by default.
            // Custom CA trust is meaningful only with verification enabled.
            ("tls-verify", "yes"),
        ] {
            player.set_option(name, value)?;
        }
        if let Some(path) = &config.tls_ca_file {
            player.set_option("tls-ca-file", path.to_string_lossy().as_ref())?;
        }
        if config.audio_only { player.set_option("vid", "no")?; }
        // Preference-driven creation options: hardware decoding and cache profile.
        for (name, value) in open_options(&config.preferences) {
            player.set_option(name, &value)?;
        }
        player.set_option("wid", &config.window_handle.to_string())?;

        if unsafe { (api.initialize)(handle) } < 0 {
            unsafe { (api.destroy)(handle) };
            player.handle = ptr::null_mut();
            return Err(LibMpvError::initialization());
        }
        player.initialized = true;
        // Creation-time preference application: default volume and every
        // immediate write. Failures stay non-fatal; capability reads surface
        // the effective values.
        let _ = player.set_i64("volume", i64::from(config.preferences.default_volume));
        for (name, value) in immediate_property_writes(&config.preferences) {
            let _ = player.set_property_string(name, &value);
        }
        player.refresh_state();
        Ok(player)
    }

    pub fn set_paused(&mut self, paused: bool) -> Result<(), LibMpvError> {
        self.set_flag("pause", paused)
            .map_err(|_| LibMpvError::command())?;
        self.state.paused = paused;
        Ok(())
    }

    pub fn seek_absolute(&mut self, position_seconds: f64) -> Result<(), LibMpvError> {
        if !position_seconds.is_finite() || position_seconds < 0.0 {
            return Err(LibMpvError::command());
        }
        self.command(&["seek", &position_seconds.to_string(), "absolute+exact"])
            .map_err(|_| LibMpvError::command())
    }

    pub fn set_rate(&mut self, rate: f64) -> Result<(), LibMpvError> {
        if !rate.is_finite() || !(0.25..=2.0).contains(&rate) {
            return Err(LibMpvError::command());
        }
        self.set_double("speed", rate)
            .map_err(|_| LibMpvError::command())?;
        self.state.rate = rate;
        Ok(())
    }

    pub fn stop_playback(&mut self) -> Result<(), LibMpvError> {
        self.command(&["stop"]).map_err(|_| LibMpvError::command())
    }

    pub fn select_subtitle(&mut self, track_id: i64) -> Result<(), LibMpvError> {
        if track_id <= 0 {
            return Err(LibMpvError::command());
        }
        self.set_i64("sid", track_id)
            .map_err(|_| LibMpvError::command())?;
        self.refresh_media_metadata();
        Ok(())
    }

    pub fn disable_subtitles(&mut self) -> Result<(), LibMpvError> {
        self.set_property_string("sid", "no")
            .map_err(|_| LibMpvError::command())?;
        self.refresh_media_metadata();
        Ok(())
    }

    pub fn select_audio(&mut self, track_id: i64) -> Result<(), LibMpvError> {
        if track_id <= 0 {
            return Err(LibMpvError::command());
        }
        self.set_i64("aid", track_id)
            .map_err(|_| LibMpvError::command())?;
        self.refresh_media_metadata();
        Ok(())
    }

    fn set_option(&mut self, name: &str, value: &str) -> Result<(), LibMpvError> {
        let name = CString::new(name).map_err(|_| LibMpvError::configuration())?;
        let value = CString::new(value).map_err(|_| LibMpvError::configuration())?;
        let result = unsafe {
            (self.library.api.set_option_string)(self.handle, name.as_ptr(), value.as_ptr())
        };
        if result < 0 {
            Err(LibMpvError::initialization())
        } else {
            Ok(())
        }
    }

    fn command(&self, args: &[&str]) -> Result<(), ()> {
        let values = args
            .iter()
            .map(|value| CString::new(*value).map_err(|_| ()))
            .collect::<Result<Vec<_>, _>>()?;
        let mut pointers = values
            .iter()
            .map(|value| value.as_ptr())
            .collect::<Vec<_>>();
        pointers.push(ptr::null());
        let result = unsafe { (self.library.api.command)(self.handle, pointers.as_ptr()) };
        if result < 0 {
            Err(())
        } else {
            Ok(())
        }
    }

    fn set_property_string(&self, name: &str, value: &str) -> Result<(), ()> {
        let name = CString::new(name).map_err(|_| ())?;
        let value = CString::new(value).map_err(|_| ())?;
        let result = unsafe {
            (self.library.api.set_property_string)(self.handle, name.as_ptr(), value.as_ptr())
        };
        if result < 0 {
            Err(())
        } else {
            Ok(())
        }
    }

    fn set_double(&self, name: &str, mut value: f64) -> Result<(), ()> {
        let name = CString::new(name).map_err(|_| ())?;
        let result = unsafe {
            (self.library.api.set_property)(
                self.handle,
                name.as_ptr(),
                MPV_FORMAT_DOUBLE,
                (&mut value as *mut f64).cast(),
            )
        };
        if result < 0 {
            Err(())
        } else {
            Ok(())
        }
    }

    fn set_flag(&self, name: &str, value: bool) -> Result<(), ()> {
        let name = CString::new(name).map_err(|_| ())?;
        let mut value: c_int = value.into();
        let result = unsafe {
            (self.library.api.set_property)(
                self.handle,
                name.as_ptr(),
                MPV_FORMAT_FLAG,
                (&mut value as *mut c_int).cast(),
            )
        };
        if result < 0 {
            Err(())
        } else {
            Ok(())
        }
    }

    fn set_i64(&self, name: &str, mut value: i64) -> Result<(), ()> {
        let name = CString::new(name).map_err(|_| ())?;
        let result = unsafe {
            (self.library.api.set_property)(
                self.handle,
                name.as_ptr(),
                MPV_FORMAT_INT64,
                (&mut value as *mut i64).cast(),
            )
        };
        if result < 0 {
            Err(())
        } else {
            Ok(())
        }
    }

    fn get_double(&self, name: &str) -> Option<f64> {
        let name = CString::new(name).ok()?;
        let mut value = 0.0_f64;
        let result = unsafe {
            (self.library.api.get_property)(
                self.handle,
                name.as_ptr(),
                MPV_FORMAT_DOUBLE,
                (&mut value as *mut f64).cast(),
            )
        };
        (result >= 0).then_some(value)
    }

    fn get_i64(&self, name: &str) -> Option<i64> {
        let name = CString::new(name).ok()?;
        let mut value = 0_i64;
        let result = unsafe {
            (self.library.api.get_property)(
                self.handle,
                name.as_ptr(),
                MPV_FORMAT_INT64,
                (&mut value as *mut i64).cast(),
            )
        };
        (result >= 0).then_some(value)
    }

    fn get_flag(&self, name: &str) -> Option<bool> {
        let name = CString::new(name).ok()?;
        let mut value = 0_i32;
        let result = unsafe {
            (self.library.api.get_property)(
                self.handle,
                name.as_ptr(),
                MPV_FORMAT_FLAG,
                (&mut value as *mut i32).cast(),
            )
        };
        (result >= 0).then_some(value != 0)
    }

    fn get_string(&self, name: &str) -> Option<String> {
        let name = CString::new(name).ok()?;
        let value = unsafe { (self.library.api.get_property_string)(self.handle, name.as_ptr()) };
        if value.is_null() {
            return None;
        }
        let owned = unsafe { CStr::from_ptr(value) }
            .to_string_lossy()
            .into_owned();
        unsafe { (self.library.api.free)(value.cast()) };
        Some(owned)
    }

    fn refresh_state(&mut self) {
        if self.handle.is_null() {
            return;
        }
        self.refresh_playback_state();
        self.refresh_media_metadata();
    }

    fn refresh_playback_state(&mut self) {
        self.state.time = self.get_double("playback-time").unwrap_or(0.0).max(0.0);
        self.state.duration = self.get_double("duration").unwrap_or(0.0).max(0.0);
        self.state.paused = self.get_flag("pause").unwrap_or(true);
        self.state.rate = self.get_double("speed").unwrap_or(1.0);
        self.state.volume = self.get_double("volume").unwrap_or(self.state.volume);
        self.state.buffering = self.get_flag("paused-for-cache").unwrap_or(false);
    }

    fn refresh_media_metadata(&mut self) {
        self.state.audio_tracks = self.read_tracks("audio");
        self.state.subtitle_tracks = self.read_tracks("sub");

        self.capability.vo = self
            .get_string("current-vo")
            .or_else(|| Some("gpu-next".into()));
        self.capability.hwdec = self
            .get_string("hwdec-current")
            .filter(|value| !value.is_empty() && value != "no");
        self.capability.video_codec = self
            .get_string("video-format")
            .or_else(|| self.get_string("video-codec-name"));
        self.capability.video_profile = self.get_string("video-codec");
        self.capability.audio_codec = self.get_string("audio-codec-name");
        self.capability.pixel_format = self.get_string("video-params/pixelformat");
        self.capability.width = self
            .get_i64("video-params/w")
            .and_then(|value| u32::try_from(value).ok());
        self.capability.height = self
            .get_i64("video-params/h")
            .and_then(|value| u32::try_from(value).ok());
        let primaries = self.get_string("video-params/primaries");
        let transfer = self.get_string("video-params/gamma");
        self.capability.hdr = Some(
            primaries.as_deref() == Some("bt.2020")
                || matches!(transfer.as_deref(), Some("pq") | Some("hlg")),
        );
    }

    fn read_tracks(&self, kind: &str) -> Vec<Track> {
        let count = self.get_i64("track-list/count").unwrap_or(0).clamp(0, 256);
        (0..count)
            .filter_map(|index| {
                let prefix = format!("track-list/{index}");
                let track_kind = self.get_string(&format!("{prefix}/type"))?;
                if track_kind != kind {
                    return None;
                }
                let id = self.get_i64(&format!("{prefix}/id"))?;
                let title = self.get_string(&format!("{prefix}/title"));
                let language = self.get_string(&format!("{prefix}/lang"));
                let codec = self.get_string(&format!("{prefix}/codec"));
                let label = title
                    .clone()
                    .or_else(|| language.clone())
                    .or_else(|| codec.clone())
                    .unwrap_or_else(|| format!("{track_kind} {id}"));
                Some(Track {
                    id,
                    label,
                    kind: track_kind,
                    language,
                    codec,
                    selected: self
                        .get_flag(&format!("{prefix}/selected"))
                        .unwrap_or(false),
                })
            })
            .collect()
    }

    /// Adds the load's downloaded external subtitles as selectable tracks.
    /// "auto" keeps the current selection; the viewer picks tracks locally.
    /// Failures are ignored — missing subtitles must never break playback.
    fn attach_external_subtitles(&mut self, load: &LoadIdentity) {
        if load.subtitles.is_empty() {
            return;
        }
        for subtitle in &load.subtitles {
            let path = subtitle.path.to_string_lossy();
            let title = subtitle.title.as_str();
            let language = subtitle.language.as_deref().unwrap_or("");
            let _ = self.command(&["sub-add", &path, "auto", title, language]);
        }
        self.refresh_media_metadata();
    }

    fn handle_native_event(&mut self, event: &MpvEvent) {
        match event.event_id {
            MPV_EVENT_START_FILE => {
                let Some(data) = (unsafe { event.data.cast::<MpvEventStartFile>().as_ref() })
                else {
                    return;
                };
                if let Some(load) = self.pending_loads.pop_front() {
                    self.entry_loads.insert(data.playlist_entry_id, load);
                    self.active_entry_id = Some(data.playlist_entry_id);
                }
            }
            MPV_EVENT_FILE_LOADED => {
                self.state.loaded = true;
                self.state.buffering = false;
                self.refresh_state();
                let load = self
                    .active_entry_id
                    .and_then(|entry| self.entry_loads.get(&entry).cloned());
                if let Some(load) = load {
                    self.attach_external_subtitles(&load);
                    self.queued_events.push(PlayerEvent::Loaded {
                        generation: load.generation,
                    });
                }
            }
            MPV_EVENT_END_FILE => {
                let Some(data) = (unsafe { event.data.cast::<MpvEventEndFile>().as_ref() }) else {
                    return;
                };
                let load = self.entry_loads.remove(&data.playlist_entry_id);
                if self.active_entry_id == Some(data.playlist_entry_id) {
                    self.active_entry_id = None;
                    self.state.loaded = false;
                }
                let Some(load) = load else {
                    return;
                };
                let reason = match data.reason {
                    MPV_END_FILE_REASON_EOF => PlayerEndReason::Eof,
                    MPV_END_FILE_REASON_STOP => PlayerEndReason::Stopped,
                    _ => PlayerEndReason::Error,
                };
                self.queued_events.push(PlayerEvent::Ended {
                    generation: load.generation,
                    reason,
                    playlist_item_id: load.playlist_item_id,
                });
                if data.reason == MPV_END_FILE_REASON_ERROR || data.error < 0 {
                    self.queued_events.push(PlayerEvent::Error {
                        generation: load.generation,
                        retryable: true,
                    });
                }
            }
            MPV_EVENT_VIDEO_RECONFIG | MPV_EVENT_AUDIO_RECONFIG | MPV_EVENT_PLAYBACK_RESTART => {
                self.refresh_state()
            }
            MPV_EVENT_QUEUE_OVERFLOW | MPV_EVENT_SHUTDOWN => {
                if let Some(load) = self
                    .active_entry_id
                    .and_then(|entry| self.entry_loads.get(&entry))
                {
                    self.queued_events.push(PlayerEvent::Error {
                        generation: load.generation,
                        retryable: event.event_id != MPV_EVENT_SHUTDOWN,
                    });
                }
            }
            _ => {}
        }
    }
}

impl PlayerEngine for LibMpvPlayer {
    fn load(&mut self, request: PlaybackLoad<'_>) {
        // Next-load preferences (track languages, network timeout) must be in
        // place before loadfile so mpv honors them for this media.
        for (name, value) in next_load_property_writes(&self.preferences) {
            let _ = self.set_property_string(name, &value);
        }
        let identity = LoadIdentity {
            generation: request.generation,
            playlist_item_id: request.playlist_item_id.map(String::from),
            subtitles: request.subtitles.clone(),
        };
        self.pending_loads.push_back(identity.clone());
        self.state.loaded = false;
        self.state.buffering = true;

        let _ = self.set_property_string("user-agent", request.user_agent);
        let tls_ca_file = request.tls_ca_file.map(|path| path.to_string_lossy().into_owned()).unwrap_or_default();
        let _ = self.set_property_string("tls-ca-file", &tls_ca_file);
        let header = request.basic_auth.map(|(username, password)| {
            format!(
                "Authorization: Basic {}",
                encode_base64(format!("{username}:{password}").as_bytes())
            )
        });
        let fields = match (header.as_deref(), request.cookie_header) {
            (Some(auth), Some(cookie)) => format!("{auth}\nCookie: {cookie}"),
            (Some(auth), None) => auth.to_string(),
            (None, Some(cookie)) => format!("Cookie: {cookie}"),
            (None, None) => String::new(),
        };
        let _ = self.set_property_string("http-header-fields", &fields);

        if self.command(&["loadfile", request.url, "replace"]).is_err() {
            self.pending_loads.pop_back();
            self.state.buffering = false;
            self.queued_events.push(PlayerEvent::Error {
                generation: identity.generation,
                retryable: true,
            });
        }
    }

    fn apply_shared_state(&mut self, snapshot: &RoomSnapshot, estimated_server_time_ms: i64) {
        if !self.state.loaded {
            return;
        }
        let target = crate::playback::authoritative_position(snapshot, estimated_server_time_ms);
        if (self.state.time - target).abs() >= 0.75 {
            let _ = self.command(&["seek", &target.to_string(), "absolute+exact"]);
        }
        if (self.state.rate - snapshot.playback_rate).abs() >= 0.001 {
            let _ = self.set_double("speed", snapshot.playback_rate);
        }
        if self.state.paused != snapshot.paused {
            let _ = self.set_flag("pause", snapshot.paused);
        }
        self.refresh_playback_state();
    }

    fn set_volume(&mut self, volume: f64) {
        if volume.is_finite() && (0.0..=100.0).contains(&volume) {
            let _ = self.set_double("volume", volume);
            self.state.volume = volume;
        }
    }

    fn set_local_paused(&mut self, paused: bool) -> Result<(), PlayerControlError> {
        self.set_paused(paused)
            .map_err(|_| PlayerControlError::Rejected)
    }

    fn seek_local_absolute(&mut self, position_seconds: f64) -> Result<(), PlayerControlError> {
        self.seek_absolute(position_seconds)
            .map_err(|_| PlayerControlError::Rejected)
    }

    fn select_audio_track(&mut self, track_id: i64) -> Result<(), PlayerControlError> {
        self.select_audio(track_id)
            .map_err(|_| PlayerControlError::Rejected)
    }

    fn select_subtitle_track(&mut self, track_id: Option<i64>) -> Result<(), PlayerControlError> {
        match track_id {
            Some(track_id) => self.select_subtitle(track_id),
            None => self.disable_subtitles(),
        }
        .map_err(|_| PlayerControlError::Rejected)
    }

    fn state(&self) -> PlayerState {
        self.state.clone()
    }

    fn capability(&self) -> NativeCapabilityReport {
        self.capability.clone()
    }

    fn drain_events(&mut self) -> Vec<PlayerEvent> {
        if self.disposed || self.handle.is_null() {
            return std::mem::take(&mut self.queued_events);
        }
        loop {
            let event = unsafe { (self.library.api.wait_event)(self.handle, 0.0) };
            let Some(event) = (unsafe { event.as_ref() }) else {
                break;
            };
            if event.event_id == MPV_EVENT_NONE {
                break;
            }
            self.handle_native_event(event);
        }
        self.refresh_playback_state();
        std::mem::take(&mut self.queued_events)
    }

    fn apply_preferences(&mut self, prefs: &PlayerPreferences) -> Vec<String> {
        self.preferences = prefs.clone();
        immediate_property_writes(prefs)
            .into_iter()
            .filter(|(name, value)| self.set_property_string(name, value).is_err())
            .map(|(name, _)| name.to_owned())
            .collect()
    }

    fn dispose(&mut self) {
        if !self.disposed && !self.handle.is_null() {
            if self.initialized {
                unsafe { (self.library.api.terminate_destroy)(self.handle) };
            } else {
                unsafe { (self.library.api.destroy)(self.handle) };
            }
            self.handle = ptr::null_mut();
            self.initialized = false;
            self.disposed = true;
            self.state = PlayerState::default();
        }
    }
}

impl Drop for LibMpvPlayer {
    fn drop(&mut self) {
        self.dispose();
    }
}

fn encode_base64(input: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let first = chunk[0];
        let second = chunk.get(1).copied().unwrap_or(0);
        let third = chunk.get(2).copied().unwrap_or(0);
        output.push(TABLE[(first >> 2) as usize] as char);
        output.push(TABLE[(((first & 0x03) << 4) | (second >> 4)) as usize] as char);
        output.push(if chunk.len() > 1 {
            TABLE[(((second & 0x0f) << 2) | (third >> 6)) as usize] as char
        } else {
            '='
        });
        output.push(if chunk.len() > 2 {
            TABLE[(third & 0x3f) as usize] as char
        } else {
            '='
        });
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_config_requires_an_absolute_dll_and_real_surface() {
        assert!(LibMpvConfig::new(PathBuf::from("libmpv-2.dll"), 1).is_err());
        assert!(LibMpvConfig::new(PathBuf::from(r"C:\libmpv-2.dll"), 0).is_err());
        assert!(LibMpvConfig::new(PathBuf::from(r"C:\libmpv-2.dll"), 1).is_ok());
    }

    #[test]
    fn preference_mappings_cover_whitelist_and_defaults() {
        let defaults = PlayerPreferences::default();
        let immediate = immediate_property_writes(&defaults);
        assert!(immediate.contains(&("deinterlace", "auto".into())));
        assert!(immediate.contains(&("audio-channels", "auto-safe".into())));
        assert!(immediate.contains(&("sub-scale", "1".into())));
        assert!(immediate.contains(&("sub-ass-override", "no".into())));
        assert!(immediate.contains(&("audio-device", "auto".into())));
        // Defaults write no HDR or font entries.
        assert!(immediate.iter().all(|(name, _)| {
            !matches!(
                *name,
                "tone-mapping" | "target-colorspace-hint" | "sub-font"
            )
        }));

        let mut custom = defaults.clone();
        custom.hdr = "sdr".into();
        custom.audio_device = Some("wasapi/{guid}".into());
        custom.subtitle_font = "Microsoft YaHei".into();
        custom.subtitle_ass_override = true;
        custom.channel_layout = "stereo".into();
        let immediate = immediate_property_writes(&custom);
        assert!(immediate.contains(&("tone-mapping", "bt.2390".into())));
        assert!(immediate.contains(&("audio-device", "wasapi/{guid}".into())));
        assert!(immediate.contains(&("sub-font", "Microsoft YaHei".into())));
        assert!(immediate.contains(&("sub-ass-override", "yes".into())));
        assert!(immediate.contains(&("audio-channels", "stereo".into())));

        custom.hdr = "passthrough".into();
        assert!(
            immediate_property_writes(&custom).contains(&("target-colorspace-hint", "yes".into()))
        );

        let next_load = next_load_property_writes(&defaults);
        assert!(next_load.contains(&("network-timeout", "30".into())));
        assert!(next_load.contains(&("sub-delay", "0".into())));
        assert!(next_load
            .iter()
            .all(|(name, _)| !matches!(*name, "slang" | "alang")));
        let mut languages = defaults.clone();
        languages.subtitle_language = "chi,eng".into();
        languages.audio_language = "jpn".into();
        languages.network_timeout = 90;
        let next_load = next_load_property_writes(&languages);
        assert!(next_load.contains(&("slang", "chi,eng".into())));
        assert!(next_load.contains(&("alang", "jpn".into())));
        assert!(next_load.contains(&("network-timeout", "90".into())));
    }

    #[test]
    fn audio_device_nodes_preserve_native_ids_and_descriptions() {
        let id = CString::new("wasapi/{test-device}").unwrap();
        let description = CString::new("扬声器 USB").unwrap();
        let name_key = CString::new("name").unwrap();
        let description_key = CString::new("description").unwrap();
        let mut keys = [name_key.as_ptr() as *mut c_char, description_key.as_ptr() as *mut c_char];
        let mut values = [
            MpvNode { value: MpvNodeValue { string: id.as_ptr() as *mut c_char }, format: 1 },
            MpvNode { value: MpvNodeValue { string: description.as_ptr() as *mut c_char }, format: 1 },
        ];
        let mut fields = MpvNodeList { count: 2, values: values.as_mut_ptr(), keys: keys.as_mut_ptr() };
        let mut item = MpvNode { value: MpvNodeValue { list: &mut fields }, format: 8 };
        let mut list = MpvNodeList { count: 1, values: &mut item, keys: ptr::null_mut() };
        let node = MpvNode { value: MpvNodeValue { list: &mut list }, format: 7 };
        let result = unsafe { read_audio_devices(&node) }.unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].id, "wasapi/{test-device}");
        assert_eq!(result[0].name, "扬声器 USB");
        unsafe { (*list.values).format = 0; }
        assert!(unsafe { read_audio_devices(&node) }.unwrap().is_empty());
    }

    #[test]
    fn open_options_cover_hardware_decoding_and_cache_presets() {
        let mut prefs = PlayerPreferences::default();
        assert_eq!(open_options(&prefs), vec![("hwdec", "auto-safe".into())]);
        prefs.cache_profile = "low-latency".into();
        assert!(open_options(&prefs).contains(&("cache", "no".into())));
        prefs.cache_profile = "stable".into();
        let options = open_options(&prefs);
        assert!(options.contains(&("cache", "yes".into())));
        assert!(options.contains(&("cache-secs", "120".into())));
        prefs.hardware_decoding = "auto".into();
        assert!(open_options(&prefs).contains(&("hwdec", "auto".into())));
    }

    #[test]
    fn tls_ca_file_is_optional_and_origin_scoped_by_configuration() {
        let config = LibMpvConfig::new(PathBuf::from(r"C:\libmpv-2.dll"), 1)
            .unwrap()
            .with_tls_ca_file(Some(PathBuf::from(r"C:\app-data\tls-trust\origin-a.pem")));
        assert_eq!(config.tls_ca_file.as_deref(), Some(Path::new(r"C:\app-data\tls-trust\origin-a.pem")));
        assert!(LibMpvConfig::new(PathBuf::from(r"C:\libmpv-2.dll"), 1).unwrap().tls_ca_file.is_none());
    }

    #[test]
    fn basic_header_encoder_handles_utf8_credentials() {
        assert_eq!(encode_base64(b"viewer:secret"), "dmlld2VyOnNlY3JldA==");
        assert_eq!(
            encode_base64("用户:密码".as_bytes()),
            "55So5oi3OuWvhueggQ=="
        );
    }
}
