#![allow(non_camel_case_types)]

use std::env;
use std::ffi::{c_char, c_int, c_void, CString};
use std::ptr;
use std::time::{Duration, Instant};

type MpvHandle = c_void;

#[repr(C)]
struct MpvEvent {
    event_id: c_int,
    error: c_int,
    reply_userdata: u64,
    data: *mut c_void,
}

#[link(name = "mpv")]
unsafe extern "C" {
    fn mpv_create() -> *mut MpvHandle;
    fn mpv_set_option_string(
        ctx: *mut MpvHandle,
        name: *const c_char,
        value: *const c_char,
    ) -> c_int;
    fn mpv_initialize(ctx: *mut MpvHandle) -> c_int;
    fn mpv_command(ctx: *mut MpvHandle, args: *const *const c_char) -> c_int;
    fn mpv_get_property(
        ctx: *mut MpvHandle,
        name: *const c_char,
        format: *const c_char,
        data: *mut *mut c_void,
    ) -> c_int;
    fn mpv_free(data: *mut c_void);
    fn mpv_wait_event(ctx: *mut MpvHandle, timeout: f64) -> *const MpvEvent;
    fn mpv_terminate_destroy(ctx: *mut MpvHandle);
}

const MPV_EVENT_NONE: c_int = 0;
const MPV_EVENT_START_FILE: c_int = 6;
const MPV_EVENT_END_FILE: c_int = 7;
const MPV_EVENT_FILE_LOADED: c_int = 8;
const MPV_EVENT_SHUTDOWN: c_int = 1;

fn option(ctx: *mut MpvHandle, name: &str, value: &str) -> Result<(), String> {
    let name = CString::new(name).map_err(|e| e.to_string())?;
    let value = CString::new(value).map_err(|e| e.to_string())?;
    let rc = unsafe { mpv_set_option_string(ctx, name.as_ptr(), value.as_ptr()) };
    if rc < 0 {
        Err(format!("mpv_set_option_string({}) returned {}", name.to_string_lossy(), rc))
    } else {
        Ok(())
    }
}

fn command(ctx: *mut MpvHandle, args: &[&str]) -> Result<(), String> {
    let values: Vec<CString> = args
        .iter()
        .map(|arg| CString::new(*arg).map_err(|e| e.to_string()))
        .collect::<Result<_, _>>()?;
    let mut pointers: Vec<*const c_char> = values.iter().map(|arg| arg.as_ptr()).collect();
    pointers.push(ptr::null());
    let rc = unsafe { mpv_command(ctx, pointers.as_ptr()) };
    if rc < 0 {
        Err(format!("mpv_command returned {}", rc))
    } else {
        Ok(())
    }
}

fn property_exists(ctx: *mut MpvHandle, name: &str, format: &str) -> Result<bool, String> {
    let name = CString::new(name).map_err(|e| e.to_string())?;
    let format = CString::new(format).map_err(|e| e.to_string())?;
    let mut value: *mut c_void = ptr::null_mut();
    let rc = unsafe { mpv_get_property(ctx, name.as_ptr(), format.as_ptr(), &mut value) };
    if !value.is_null() {
        unsafe { mpv_free(value) };
    }
    if rc < 0 {
        Ok(false)
    } else {
        Ok(true)
    }
}

fn main() -> Result<(), String> {
    let media = env::args().nth(1);
    let ctx = unsafe { mpv_create() };
    if ctx.is_null() {
        return Err("mpv_create returned null".into());
    }

    let result = (|| {
        option(ctx, "vo", &env::var("GATE3_VO").unwrap_or_else(|_| "null".into()))?;
        option(ctx, "ao", &env::var("GATE3_AO").unwrap_or_else(|_| "null".into()))?;
        option(ctx, "hwdec", &env::var("GATE3_HWDEC").unwrap_or_else(|_| "no".into()))?;
        option(ctx, "terminal", "no")?;
        option(ctx, "idle", "yes")?;
        option(ctx, "keep-open", "yes")?;
        let rc = unsafe { mpv_initialize(ctx) };
        if rc < 0 {
            return Err(format!("mpv_initialize returned {}", rc));
        }
        command(ctx, &["set", "pause", "yes"])?;
        println!("libmpv lifecycle: PASS");

        let Some(media) = media else {
            command(ctx, &["quit"])?;
            return Ok(());
        };

        command(ctx, &["loadfile", &media, "replace"])?;
        let deadline = Instant::now() + Duration::from_secs(60);
        let mut loaded = false;
        while Instant::now() < deadline {
            let event = unsafe { &*mpv_wait_event(ctx, 0.25) };
            match event.event_id {
                MPV_EVENT_FILE_LOADED => {
                    loaded = true;
                    println!("file-loaded: PASS");
                    break;
                }
                MPV_EVENT_START_FILE => println!("start-file: observed"),
                MPV_EVENT_END_FILE => return Err(format!("end-file before file-loaded (error {})", event.error)),
                MPV_EVENT_SHUTDOWN => return Err("mpv shut down before file-loaded".into()),
                MPV_EVENT_NONE => {}
                _ => {}
            }
        }
        if !loaded {
            return Err("timed out waiting for file-loaded".into());
        }

        command(ctx, &["set", "pause", "yes"])?;
        command(ctx, &["set", "pause", "no"])?;
        command(ctx, &["seek", "1", "absolute"])?;
        command(ctx, &["set", "speed", "1.25"])?;
        command(ctx, &["set", "volume", "35"])?;
        if !property_exists(ctx, "track-list", "node")? {
            return Err("track-list property unavailable".into());
        }
        println!("play-pause-seek-rate-volume-track-list: PASS");

        command(ctx, &["stop"])?;
        let deadline = Instant::now() + Duration::from_secs(20);
        let mut ended = false;
        while Instant::now() < deadline {
            let event = unsafe { &*mpv_wait_event(ctx, 0.25) };
            if event.event_id == MPV_EVENT_END_FILE {
                ended = true;
                break;
            }
            if event.event_id == MPV_EVENT_SHUTDOWN {
                break;
            }
        }
        if !ended {
            return Err("timed out waiting for end-file".into());
        }
        println!("end-file: PASS");
        command(ctx, &["quit"])?;
        Ok(())
    })();

    unsafe { mpv_terminate_destroy(ctx) };
    result
}
