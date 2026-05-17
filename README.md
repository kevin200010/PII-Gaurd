# PII Guard

A privacy-first Windows desktop sidebar that watches your keyboard and clipboard in real time, flags personally identifiable information (PII) the moment you type or paste it, and keeps a searchable history — all running fully **offline** after a one-time model download.

---

## How it works

PII Guard runs two detection layers in parallel:

| Layer | Method | What it catches |
|-------|--------|----------------|
| 1 | Regex fast-path | Emails, credit cards, SSNs, phone numbers, IPs, IBANs, MAC addresses, dates of birth, Bitcoin/Ethereum addresses, VINs, EINs, passport numbers, CVVs |
| 2 | DeBERTa NER (ONNX INT8) | Names, street addresses, usernames, personal URLs, generic ID numbers |

The Rust backend installs a low-level Windows keyboard hook and a clipboard sequence-number watcher. Text is flushed to the detector on `Enter`, `Tab`, `Ctrl+Shift+S`, or whenever the focused window changes. Results stream back to the React UI as Tauri events.

---

## Features

- **Always-on robot mascot** — sits in the bottom-right corner; bounces and turns red when PII is detected
- **Alert bubbles** — colour-coded by risk level (red → orange → yellow) with a one-click link to the full history
- **History panel** — every entry is highlighted inline; shows source (Typed / Copied / Pasted), timestamp, and detected labels
- **Clipboard monitoring** — scans text the moment you copy it, before you paste it anywhere
- **Focus-change flush** — buffer is automatically submitted when you click into a different application
- **Fully offline** — the DeBERTa model runs locally via ONNX Runtime; no text ever leaves your machine
- **Persistent history** — stored in `localStorage` with a 5 MB rolling cap; survives app restarts
- **Resizable history window** — drag any edge or corner to resize

---

## Supported PII types

| Risk | Labels |
|------|--------|
| High (red) | `CREDIT_CARD`, `SSN`, `IBAN`, `BITCOIN`, `ETHEREUM`, `EIN`, `CVV` |
| Medium (orange) | `EMAIL`, `PHONE`, `PASSPORT`, `IP_ADDRESS`, `MAC_ADDRESS` |
| Low (yellow) | `NAME_STUDENT`, `USERNAME`, `DATE_OF_BIRTH`, `VIN`, `URL_PERSONAL`, `STREET_ADDRESS`, `ID_NUM` |

---

## Keyboard shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+Alt+G` | Toggle between robot view and history panel |
| `Ctrl+Shift+S` | Manually flush and scan the current input buffer |
| `Enter` / `Tab` | Auto-flush the buffer (same keys you already press) |

---

## Getting started

### Prerequisites

- **Windows 10/11** (the keyboard hook and clipboard watcher use Win32 APIs)
- [Rust toolchain](https://rustup.rs/) (stable)
- [Node.js](https://nodejs.org/) ≥ 18
- [Tauri CLI v2](https://v2.tauri.app/start/prerequisites/)

### Development

```powershell
npm install
npm run tauri dev
```

### Production build

```powershell
npm run tauri build
```

The installer is written to `src-tauri/target/release/bundle/`.

### First run

On first launch the robot will show a **PII Guard Setup** popup. Click **Download Model (~180 MB)** to fetch the quantized DeBERTa model from HuggingFace. Progress is shown file-by-file. Once complete, the robot's status light turns green and detection begins immediately — no restart needed.

---

## Tech stack

| Layer | Technology |
|-------|------------|
| UI | React 18, TypeScript, Vite, Tailwind CSS |
| Desktop shell | [Tauri 2](https://v2.tauri.app/) |
| ML inference | [ONNX Runtime (ort 2)](https://github.com/pykeio/ort) |
| Tokenizer | [HuggingFace tokenizers](https://github.com/huggingface/tokenizers) |
| Model | [kevin-rice/OpenMed-PII-ONNX-INT8](https://huggingface.co/kevin-rice/OpenMed-PII-ONNX-INT8) (INT8 quantized DeBERTa) |
| Windows APIs | `windows-sys` — keyboard hook, clipboard, focus watcher |

---

## Privacy

All processing is local. The only outbound network request is the one-time model download from HuggingFace. After that, the application works entirely offline. No telemetry, no cloud calls, no data sharing.
