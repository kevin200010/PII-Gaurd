mod detector;

use std::sync::{atomic::{AtomicBool, Ordering}, Mutex, OnceLock};
use tauri::{AppHandle, Manager, State};

// ── Global state ──────────────────────────────────────────────────────────

static APP_HANDLE:   OnceLock<AppHandle>     = OnceLock::new();
static INPUT_BUFFER: OnceLock<Mutex<String>> = OnceLock::new();

// ── Tauri managed state ───────────────────────────────────────────────────

pub struct DetectorState {
    pub ready: AtomicBool,
}

// ── Model download command ────────────────────────────────────────────────

// const MODEL_FILES: &[(&str, &str)] = &[
//     (
//         "model.onnx",
//         "https://huggingface.co/protectai/lakshyakh93-deberta_finetuned_pii-onnx/resolve/main/model.onnx",
//     ),
//     (
//         "tokenizer.json",
//         "https://huggingface.co/protectai/lakshyakh93-deberta_finetuned_pii-onnx/resolve/main/tokenizer.json",
//     ),
//     (
//         "config.json",
//         "https://huggingface.co/lakshyakh93/deberta_finetuned_pii/resolve/main/config.json",
//     ),
// ];

const MODEL_FILES: &[(&str, &str)] = &[
    (
        "model.onnx",
        "https://huggingface.co/kevin-rice/OpenMed-PII-ONNX-INT8/resolve/main/model_quantized.onnx",
    ),
    (
        "tokenizer.json",
        "https://huggingface.co/kevin-rice/OpenMed-PII-ONNX-INT8/resolve/main/tokenizer.json",
    ),
    (
        "config.json",
        "https://huggingface.co/kevin-rice/OpenMed-PII-ONNX-INT8/resolve/main/config.json",
    ),
];

#[tauri::command]
async fn download_model(
    app: AppHandle,
    state: State<'_, DetectorState>,
) -> Result<(), String> {
    use tauri::Emitter;

    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;

    let client = reqwest::Client::builder()
        .user_agent("pii-sidebar/0.1")
        .build()
        .map_err(|e| e.to_string())?;

    for (filename, url) in MODEL_FILES {
        let dest = data_dir.join(filename);
        if dest.exists() {
            let _ = app.emit("download-progress", serde_json::json!({
                "file": filename, "pct": 100, "done": true
            }));
            continue;
        }

        let mut response = client
            .get(*url)
            .send()
            .await
            .map_err(|e| format!("fetch {filename}: {e}"))?;

        let total = response.content_length().unwrap_or(0);
        let mut bytes: Vec<u8> = if total > 0 { Vec::with_capacity(total as usize) } else { Vec::new() };
        let mut downloaded = 0u64;

        while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
            downloaded += chunk.len() as u64;
            bytes.extend_from_slice(&chunk);
            if total > 0 {
                let pct = (downloaded * 100 / total) as u32;
                let _ = app.emit("download-progress", serde_json::json!({
                    "file": filename, "pct": pct, "done": false
                }));
            }
        }

        std::fs::write(&dest, &bytes).map_err(|e| e.to_string())?;
        let _ = app.emit("download-progress", serde_json::json!({
            "file": filename, "pct": 100, "done": true
        }));
    }

    detector::init(&data_dir).map_err(|e| e.to_string())?;
    state.ready.store(true, Ordering::SeqCst);
    let _ = app.emit("model-ready", ());

    Ok(())
}

// ── PII scan command ──────────────────────────────────────────────────────

#[tauri::command]
async fn scan_input(
    text: String,
    state: State<'_, DetectorState>,
) -> Result<Vec<detector::PiiMatch>, String> {
    if !state.ready.load(Ordering::SeqCst) || text.trim().len() < 4 {
        return Ok(vec![]);
    }
    tauri::async_runtime::spawn_blocking(move || detector::process_text(&text))
        .await
        .map_err(|e| e.to_string())
}

// ── Model status command ──────────────────────────────────────────────────

#[tauri::command]
fn is_model_ready(state: State<'_, DetectorState>) -> bool {
    state.ready.load(Ordering::SeqCst)
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

// ── Keyboard hook ─────────────────────────────────────────────────────────

#[cfg(windows)]
mod hook {
    use super::{APP_HANDLE, INPUT_BUFFER};
    use crate::clipboard;
    use tauri::Emitter;
    use windows_sys::Win32::Foundation::*;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::*;
    use windows_sys::Win32::UI::WindowsAndMessaging::*;

    pub unsafe fn install_and_run() {
        let hook = SetWindowsHookExW(
            WH_KEYBOARD_LL,
            Some(keyboard_proc),
            std::ptr::null_mut(),
            0,
        );
        if hook.is_null() {
            eprintln!("Failed to install keyboard hook");
            return;
        }
        let mut msg = std::mem::zeroed::<MSG>();
        while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) != 0 {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
        UnhookWindowsHookEx(hook);
    }

    unsafe extern "system" fn keyboard_proc(
        n_code: i32,
        w_param: WPARAM,
        l_param: LPARAM,
    ) -> LRESULT {
        if n_code == HC_ACTION as i32 {
            let kb = &*(l_param as *const KBDLLHOOKSTRUCT);
            let is_down = w_param as u32 == WM_KEYDOWN || w_param as u32 == WM_SYSKEYDOWN;
            if is_down {
                handle_key(kb.vkCode, kb.scanCode, kb.flags);
            }
        }
        CallNextHookEx(std::ptr::null_mut(), n_code, w_param, l_param)
    }

    unsafe fn is_pressed(vk: i32) -> bool {
        GetAsyncKeyState(vk) as u16 & 0x8000 != 0
    }

    // Flush the buffer as a completed entry and clear the live preview.
    unsafe fn flush_buf(buf: &mut String, handle: &tauri::AppHandle) {
        let text = buf.trim().to_string();
        buf.clear();
        let _ = handle.emit("typing-live", "");
        if !text.is_empty() {
            let _ = handle.emit("input-complete", text);
        }
    }

    unsafe fn handle_key(vk: u32, scan: u32, flags: u32) {
        let Some(buf_lock) = INPUT_BUFFER.get() else { return };
        let Some(handle)   = APP_HANDLE.get()   else { return };

        let mut buf = buf_lock.lock().unwrap();

        match vk as u16 {
            VK_BACK => {
                let mut chars = buf.chars();
                chars.next_back();
                *buf = chars.as_str().to_string();
            }

            // Enter / Tab → treat as field submission; flush immediately.
            VK_RETURN => { flush_buf(&mut buf, handle); return; }
            VK_TAB    => { flush_buf(&mut buf, handle); return; }

            VK_SPACE  => buf.push(' '),

            VK_ESCAPE => {
                buf.clear();
                let _ = handle.emit("typing-live", "");
                return;
            }

            // Ctrl+Shift+S hotkey → manual flush / scan trigger
            0x53 if is_pressed(VK_CONTROL as i32) && is_pressed(VK_SHIFT as i32) => {
                flush_buf(&mut buf, handle);
                return;
            }

            // Ctrl+Alt+G → toggle history window
            0x47 if is_pressed(VK_CONTROL as i32) && is_pressed(VK_MENU as i32) => {
                let _ = handle.emit("toggle-window", ());
                return;
            }

            // Ctrl+V → emit paste event (clipboard content scanned separately)
            0x56 if is_pressed(VK_CONTROL as i32) => {
                if let Some(text) = clipboard::read_current() {
                    let _ = handle.emit("paste-event", text);
                }
                let _ = handle.emit("typing-live", buf.clone());
                return;
            }

            _ => {
                let mut kb_state = [0u8; 256];

                if is_pressed(VK_SHIFT    as i32) { kb_state[VK_SHIFT    as usize] = 0x80; }
                if is_pressed(VK_LSHIFT   as i32) { kb_state[VK_LSHIFT   as usize] = 0x80; }
                if is_pressed(VK_RSHIFT   as i32) { kb_state[VK_RSHIFT   as usize] = 0x80; }
                if is_pressed(VK_CONTROL  as i32) { kb_state[VK_CONTROL  as usize] = 0x80; }
                if is_pressed(VK_LCONTROL as i32) { kb_state[VK_LCONTROL as usize] = 0x80; }
                if is_pressed(VK_RCONTROL as i32) { kb_state[VK_RCONTROL as usize] = 0x80; }

                let alt_down = (flags & 0x20) != 0 || is_pressed(VK_MENU as i32);
                if alt_down                    { kb_state[VK_MENU  as usize] = 0x80; }
                if is_pressed(VK_LMENU as i32) { kb_state[VK_LMENU as usize] = 0x80; }
                if is_pressed(VK_RMENU as i32) { kb_state[VK_RMENU as usize] = 0x80; }

                if GetKeyState(VK_CAPITAL as i32) & 0x0001 != 0 {
                    kb_state[VK_CAPITAL as usize] = 0x01;
                }

                let mut out = [0u16; 4];
                let layout = GetKeyboardLayout(0);
                let n = ToUnicodeEx(vk, scan, kb_state.as_ptr(), out.as_mut_ptr(), out.len() as i32, 0, layout);
                if n == 1 {
                    if let Some(ch) = char::from_u32(out[0] as u32) {
                        if !ch.is_control() {
                            buf.push(ch);
                        }
                    }
                }
            }
        }

        let _ = handle.emit("typing-live", buf.clone());
    }
}

// ── Clipboard watcher ─────────────────────────────────────────────────────

#[cfg(windows)]
mod clipboard {
    use super::APP_HANDLE;
    use tauri::Emitter;
    use windows_sys::Win32::System::DataExchange::{
        CloseClipboard, GetClipboardData, GetClipboardSequenceNumber, OpenClipboard,
    };
    use windows_sys::Win32::System::Memory::{GlobalLock, GlobalUnlock};

    const CF_UNICODETEXT: u32 = 13;

    pub fn watch() {
        let mut last_seq = unsafe { GetClipboardSequenceNumber() };
        loop {
            std::thread::sleep(std::time::Duration::from_millis(300));
            let seq = unsafe { GetClipboardSequenceNumber() };
            if seq == last_seq { continue; }
            last_seq = seq;
            if let Some(text) = unsafe { read_text() } {
                if let Some(handle) = APP_HANDLE.get() {
                    let _ = handle.emit("clipboard-update", text);
                }
            }
        }
    }

    pub unsafe fn read_current() -> Option<String> { read_text() }

    unsafe fn read_text() -> Option<String> {
        if OpenClipboard(std::ptr::null_mut()) == 0 { return None; }
        let h = GetClipboardData(CF_UNICODETEXT);
        let result = if h.is_null() {
            None
        } else {
            let ptr = GlobalLock(h) as *const u16;
            if ptr.is_null() { None } else {
                let mut len = 0usize;
                while *ptr.add(len) != 0 { len += 1; }
                let text = String::from_utf16_lossy(std::slice::from_raw_parts(ptr, len));
                GlobalUnlock(h);
                let t = text.trim().to_string();
                if t.is_empty() { None } else { Some(t) }
            }
        };
        CloseClipboard();
        result
    }
}

// ── Focus watcher — flush buffer when active window changes ───────────────
// Covers "cursor leaves field" when user clicks into a different app.

#[cfg(windows)]
fn focus_watcher() {
    use windows_sys::Win32::UI::WindowsAndMessaging::GetForegroundWindow;
    use tauri::Emitter;

    let mut last = unsafe { GetForegroundWindow() };

    loop {
        std::thread::sleep(std::time::Duration::from_millis(150));

        let current = unsafe { GetForegroundWindow() };
        if current == last { continue; }
        last = current;

        let (Some(buf_lock), Some(handle)) = (INPUT_BUFFER.get(), APP_HANDLE.get())
        else { continue };

        let mut buf = buf_lock.lock().unwrap();
        let text = buf.trim().to_string();
        if text.is_empty() { continue; }
        buf.clear();
        let _ = handle.emit("typing-live", "");
        let _ = handle.emit("input-complete", text);
    }
}

// ── Try to init detector from already-downloaded files ────────────────────

fn try_init_detector(app: &tauri::App) -> bool {
    if let Ok(data_dir) = app.path().app_data_dir() {
        if data_dir.join("model.onnx").exists() && data_dir.join("tokenizer.json").exists() {
            if detector::init(&data_dir).is_ok() {
                return true;
            }
        }
    }
    false
}

// ── Entry point ───────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    INPUT_BUFFER.get_or_init(|| Mutex::new(String::new()));

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(DetectorState { ready: AtomicBool::new(false) })
        .setup(|app| {
            APP_HANDLE.get_or_init(|| app.handle().clone());

            let already_ready = try_init_detector(app);
            if already_ready {
                app.state::<DetectorState>().ready.store(true, Ordering::SeqCst);
            }

            #[cfg(windows)]
            std::thread::spawn(|| unsafe { hook::install_and_run() });

            #[cfg(windows)]
            std::thread::spawn(clipboard::watch);

            #[cfg(windows)]
            std::thread::spawn(focus_watcher);

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            download_model,
            scan_input,
            is_model_ready,
            quit_app,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
