import { useEffect, useRef, useState } from "react";
import { getCurrentWindow, LogicalPosition, LogicalSize } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";

// ── Types ─────────────────────────────────────────────────────────────────────

type Source = "typed" | "clipboard" | "pasted";
type View = "pet" | "history";
type ResizeDirection =
  | "East" | "North" | "NorthEast" | "NorthWest"
  | "South" | "SouthEast" | "SouthWest" | "West";

interface PiiMatch { label: string; text: string; start: number; end: number; }
interface Entry {
  id: number;
  text: string;
  timestamp: string;
  source: Source;
  matches: PiiMatch[] | null; // null = not yet scanned
}
interface AlertItem { id: number; matches: PiiMatch[]; }
interface DownloadProgress { file: string; pct: number; done: boolean; }

// ── Constants ─────────────────────────────────────────────────────────────────

const PET_W = 260, PET_H = 420;
const HIST_W = 340, HIST_H = 680;
const MARGIN = 20;
const MAX_STORAGE = 5 * 1024 * 1024; // 5 MB in chars ≈ bytes for ASCII
const STORAGE_KEY = "pii-history-v1";

const RISK_HEX: Record<string, string> = {
  CREDIT_CARD: "#ef4444", SSN: "#ef4444", IBAN: "#ef4444",
  BITCOIN: "#ef4444", ETHEREUM: "#ef4444", EIN: "#ef4444", CVV: "#ef4444",
  EMAIL: "#f97316", PHONE: "#f97316", PASSPORT: "#f97316",
  IP_ADDRESS: "#f97316", MAC_ADDRESS: "#f97316",
};
const riskHex = (l: string) => RISK_HEX[l] ?? "#f59e0b";

const HIGHLIGHT: Record<string, string> = {
  CREDIT_CARD: "bg-red-800/80 text-red-100",    SSN: "bg-red-800/80 text-red-100",
  IBAN:        "bg-red-800/80 text-red-100",    BITCOIN: "bg-red-800/80 text-red-100",
  ETHEREUM:    "bg-red-800/80 text-red-100",    EIN: "bg-red-800/80 text-red-100",
  CVV:         "bg-red-800/80 text-red-100",
  EMAIL:       "bg-orange-800/70 text-orange-100", PHONE: "bg-orange-800/70 text-orange-100",
  PASSPORT:    "bg-orange-800/70 text-orange-100", IP_ADDRESS: "bg-orange-800/70 text-orange-100",
  MAC_ADDRESS: "bg-orange-800/70 text-orange-100",
  NAME_STUDENT: "bg-yellow-800/70 text-yellow-100", USERNAME: "bg-yellow-800/70 text-yellow-100",
  DATE_OF_BIRTH: "bg-yellow-800/70 text-yellow-100", VIN: "bg-yellow-800/70 text-yellow-100",
  URL_PERSONAL: "bg-yellow-800/70 text-yellow-100", STREET_ADDRESS: "bg-yellow-800/70 text-yellow-100",
  ID_NUM: "bg-yellow-800/70 text-yellow-100",
};
const hlClass = (l: string) => HIGHLIGHT[l] ?? "bg-red-800/70 text-red-100";

let nextId = 0;
let nextAlertId = 0;

// ── Storage ───────────────────────────────────────────────────────────────────

function loadHistory(): Entry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: Entry[] = JSON.parse(raw);
    nextId = parsed.reduce((m, e) => Math.max(m, e.id), -1) + 1;
    return parsed;
  } catch { return []; }
}

function saveHistory(entries: Entry[]): Entry[] {
  let list = entries;
  while (list.length > 0 && JSON.stringify(list).length > MAX_STORAGE) {
    list = list.slice(1); // drop oldest until under limit
  }
  if (list.length === 0) { localStorage.removeItem(STORAGE_KEY); return []; }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  return list;
}

function storageUsedBytes(): number {
  return localStorage.getItem(STORAGE_KEY)?.length ?? 0;
}

// ── Pet Robot SVG ─────────────────────────────────────────────────────────────

function PetRobot({ alerting, ready }: { alerting: boolean; ready: boolean }) {
  return (
    <svg width="120" height="143" viewBox="0 0 84 100" xmlns="http://www.w3.org/2000/svg">
      {/* Antenna */}
      <line x1="42" y1="5" x2="42" y2="18" stroke="#93c5fd" strokeWidth="2.5" strokeLinecap="round"/>
      {alerting && <circle cx="42" cy="4" r="9" fill="#ef444420"/>}
      <circle cx="42" cy="4" r="5" fill={alerting ? "#ef4444" : "#93c5fd"}/>

      {/* Head */}
      <rect x="16" y="18" width="52" height="34" rx="11" fill="#1e40af"/>
      <rect x="19" y="21" width="46" height="28" rx="9" fill="#3b82f6"/>

      {/* Eyes */}
      <ellipse cx="31" cy="33" rx={alerting ? 7 : 5.5} ry={alerting ? 8 : 5.5} fill="white"/>
      <ellipse cx="53" cy="33" rx={alerting ? 7 : 5.5} ry={alerting ? 8 : 5.5} fill="white"/>
      <circle cx="32" cy="34" r={alerting ? 4 : 3} fill="#172554"/>
      <circle cx="54" cy="34" r={alerting ? 4 : 3} fill="#172554"/>
      <circle cx="30" cy="30" r="1.5" fill="white" opacity="0.9"/>
      <circle cx="52" cy="30" r="1.5" fill="white" opacity="0.9"/>

      {/* Mouth */}
      {alerting
        ? <path d="M27 46 Q42 40 57 46" stroke="white" strokeWidth="2" fill="none" strokeLinecap="round"/>
        : <path d="M27 44 Q42 50 57 44" stroke="white" strokeWidth="2" fill="none" strokeLinecap="round"/>
      }

      {/* Body */}
      <rect x="12" y="52" width="60" height="28" rx="10" fill="#1e40af"/>
      <rect x="15" y="55" width="54" height="22" rx="8" fill="#2563eb"/>

      {/* Status panel */}
      <rect x="21" y="59" width="42" height="12" rx="4" fill="#172554"/>
      {ready ? (
        <>
          <circle cx="31" cy="65" r="3" fill="#22c55e"/>
          <rect x="37" y="62" width="18" height="2" rx="1" fill="#4ade80" opacity="0.8"/>
          <rect x="37" y="67" width="12" height="2" rx="1" fill="#4ade80" opacity="0.5"/>
        </>
      ) : (
        <text x="42" y="69" textAnchor="middle" fill="#f87171" fontSize="10"
          fontWeight="bold" fontFamily="monospace">!</text>
      )}

      {/* Arms */}
      <rect x="2"  y="55" width="10" height="18" rx="5" fill="#1e40af"/>
      <rect x="72" y="55" width="10" height="18" rx="5" fill="#1e40af"/>

      {/* Legs */}
      <rect x="19" y="78" width="14" height="16" rx="7" fill="#1e40af"/>
      <rect x="51" y="78" width="14" height="16" rx="7" fill="#1e40af"/>
    </svg>
  );
}

// ── Alert Bubble ──────────────────────────────────────────────────────────────

function AlertBubble({ alert, onDismiss, onView }: {
  alert: AlertItem;
  onDismiss: () => void;
  onView: () => void;
}) {
  const labels = [...new Set(alert.matches.map(m => m.label))];
  const snippet = alert.matches[0].text;

  return (
    <div
      style={{ animation: "alertSlideUp 0.22s ease-out", backgroundColor: "rgba(10,5,5,0.96)" }}
      className="mx-2 mb-2 rounded-2xl border border-red-600/40 p-3 shadow-2xl"
    >
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 mb-1.5">
            <svg className="w-3.5 h-3.5 text-red-500 shrink-0" fill="none" viewBox="0 0 24 24"
              stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round"
                d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
            </svg>
            <span className="text-xs font-bold text-red-400 uppercase tracking-wide">PII Detected</span>
          </div>
          <div className="flex flex-wrap gap-1 mb-1.5">
            {labels.map(label => (
              <span key={label}
                style={{
                  color: riskHex(label),
                  borderColor: riskHex(label) + "70",
                  backgroundColor: riskHex(label) + "18",
                }}
                className="text-xs font-semibold px-1.5 py-0.5 rounded border"
              >
                {label}
              </span>
            ))}
          </div>
          <p className="text-xs text-gray-500 font-mono truncate mb-2">
            {snippet.length > 32 ? snippet.slice(0, 32) + "…" : snippet}
          </p>
          <button
            onClick={onView}
            className="text-xs text-blue-400 hover:text-blue-300 transition-colors font-medium"
          >
            View history →
          </button>
        </div>
        <button onClick={onDismiss}
          className="text-gray-600 hover:text-gray-300 text-xl leading-none shrink-0 transition-colors">
          ×
        </button>
      </div>
    </div>
  );
}

// ── Setup Popup ───────────────────────────────────────────────────────────────

function SetupPopup({ onStart, progress, downloading, onClose }: {
  onStart: () => void;
  progress: DownloadProgress | null;
  downloading: boolean;
  onClose: () => void;
}) {
  return (
    <div
      style={{ animation: "alertSlideUp 0.22s ease-out", backgroundColor: "rgba(8,12,20,0.97)" }}
      className="mx-2 mb-2 rounded-2xl border border-blue-700/30 p-3 shadow-2xl"
    >
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-bold text-blue-400 uppercase tracking-wide">PII Guard Setup</span>
        <button onClick={onClose}
          className="text-gray-600 hover:text-gray-300 text-xl leading-none transition-colors">×</button>
      </div>
      <p className="text-xs text-gray-500 leading-relaxed mb-1.5">
        Detects names, SSNs, emails, credit cards, and 15+ PII types. Runs fully offline.
      </p>
      <p className="text-xs text-gray-600 leading-relaxed mb-2.5">
        Tip: type in any app then press <span className="text-gray-400 font-mono">Enter</span>,{" "}
        <span className="text-gray-400 font-mono">Tab</span>, or{" "}
        <span className="text-gray-400 font-mono">Ctrl+Shift+S</span> to scan.
      </p>
      {progress && (
        <div className="mb-2.5">
          <div className="flex justify-between text-xs text-gray-600 mb-1">
            <span className="truncate max-w-[120px]">{progress.file}</span>
            <span>{progress.pct}%</span>
          </div>
          <div className="h-1 bg-gray-800 rounded-full overflow-hidden">
            <div className="h-full bg-blue-500 rounded-full transition-all duration-300"
              style={{ width: `${progress.pct}%` }}/>
          </div>
        </div>
      )}
      <button
        onClick={onStart}
        disabled={downloading}
        className="w-full py-1.5 rounded-xl text-xs font-semibold transition-colors
          bg-blue-600 hover:bg-blue-500 disabled:bg-gray-800 disabled:text-gray-600
          text-white disabled:cursor-not-allowed"
      >
        {downloading ? "Downloading…" : "Download Model (~180 MB)"}
      </button>
    </div>
  );
}

// ── Highlighted Text ──────────────────────────────────────────────────────────

function HighlightedText({ text, matches }: { text: string; matches: PiiMatch[] | null }) {
  if (!matches?.length) return <>{text}</>;
  const sorted = [...matches].sort((a, b) => a.start - b.start);
  const parts: React.ReactNode[] = [];
  let pos = 0;
  for (const m of sorted) {
    if (m.start < pos) continue;
    if (m.start > pos) parts.push(<span key={`t${pos}`}>{text.slice(pos, m.start)}</span>);
    parts.push(
      <span key={`m${m.start}`} title={m.label}
        className={`rounded px-0.5 mx-px ${hlClass(m.label)}`}>
        {text.slice(m.start, m.end)}
      </span>
    );
    pos = m.end;
  }
  if (pos < text.length) parts.push(<span key={`t${pos}`}>{text.slice(pos)}</span>);
  return <>{parts}</>;
}

function ResizeHandles({ onResize }: { onResize: (direction: ResizeDirection) => void }) {
  const handle = (direction: ResizeDirection) => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onResize(direction);
  };

  return (
    <>
      <div onMouseDown={handle("North")} className="absolute top-0 left-3 right-3 h-1.5 cursor-n-resize z-50" />
      <div onMouseDown={handle("South")} className="absolute bottom-0 left-3 right-3 h-1.5 cursor-s-resize z-50" />
      <div onMouseDown={handle("West")} className="absolute left-0 top-3 bottom-3 w-1.5 cursor-w-resize z-50" />
      <div onMouseDown={handle("East")} className="absolute right-0 top-3 bottom-3 w-1.5 cursor-e-resize z-50" />
      <div onMouseDown={handle("NorthWest")} className="absolute top-0 left-0 w-4 h-4 cursor-nw-resize z-50" />
      <div onMouseDown={handle("NorthEast")} className="absolute top-0 right-0 w-4 h-4 cursor-ne-resize z-50" />
      <div onMouseDown={handle("SouthWest")} className="absolute bottom-0 left-0 w-4 h-4 cursor-sw-resize z-50" />
      <div onMouseDown={handle("SouthEast")} className="absolute bottom-0 right-0 w-4 h-4 cursor-se-resize z-50" />
    </>
  );
}

// ── History View ──────────────────────────────────────────────────────────────

function HistoryView({ entries, modelReady, onMinimize, onQuit, onClear, onResize }: {
  entries: Entry[];
  modelReady: boolean;
  onMinimize: () => void;
  onQuit: () => void;
  onClear: () => void;
  onResize: (direction: ResizeDirection) => void;
}) {
  const used = storageUsedBytes();
  const usedMB = (used / (1024 * 1024)).toFixed(2);
  const pct = Math.min(100, Math.round((used / MAX_STORAGE) * 100));
  const piiCount = entries.filter(e => e.matches && e.matches.length > 0).length;

  return (
    <div className="relative flex flex-col h-screen bg-gray-900 text-gray-100 select-none"
      style={{ animation: "fadeIn 0.15s ease-out" }}>
      <ResizeHandles onResize={onResize} />

      {/* Header */}
      <div
        data-tauri-drag-region
        className="flex items-center justify-between px-3 py-2.5 bg-gray-800
          border-b border-gray-700 cursor-grab shrink-0"
      >
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-gray-300">PII Guard</span>
          {modelReady
            ? <span className="flex items-center gap-1 text-xs text-emerald-400">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400"/>active
              </span>
            : <span className="text-xs text-yellow-500">model not loaded</span>
          }
          {piiCount > 0 && (
            <span className="text-xs text-red-400 font-semibold">{piiCount} PII</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button onClick={onClear}
            className="text-xs text-gray-500 hover:text-gray-200 transition-colors">Clear</button>
          <button
            onClick={onMinimize}
            aria-label="Minimize to robot"
            title="Minimize to robot"
            className="w-6 h-6 text-gray-500 hover:text-gray-200 text-lg leading-none transition-colors"
          >
            -
          </button>
          <button
            onClick={onQuit}
            aria-label="Close application"
            title="Close application"
            className="w-6 h-6 text-gray-500 hover:text-red-300 text-lg leading-none transition-colors"
          >
            x
          </button>
        </div>
      </div>

      {/* Entry list */}
      <main className="flex-1 overflow-y-auto p-3 space-y-2">
        {entries.length === 0 && (
          <p className="text-gray-600 italic text-sm mt-6 text-center">
            {modelReady
              ? "No entries yet. Type anywhere to begin monitoring."
              : "Download the model to enable PII detection."}
          </p>
        )}
        {[...entries].reverse().map(entry => {
          const hasPii  = entry.matches !== null && entry.matches.length > 0;
          const isClean = entry.matches !== null && entry.matches.length === 0;
          const pending = entry.matches === null;

          return (
            <div
              key={entry.id}
              className={`rounded-lg p-3 border transition-all ${
                hasPii  ? "bg-red-950/40 border-red-600/70 shadow shadow-red-950/50"
                : isClean ? "bg-emerald-950/20 border-emerald-800/50"
                : "bg-gray-800 border-gray-700"
              }`}
            >
              <div className="flex items-center gap-1.5 mb-1.5 flex-wrap">
                <span className={`text-xs font-medium ${
                  entry.source === "clipboard" ? "text-blue-400"
                  : entry.source === "pasted" ? "text-purple-400"
                  : "text-green-400"
                }`}>
                  {entry.source === "clipboard" ? "Copied"
                    : entry.source === "pasted" ? "Pasted" : "Typed"}
                </span>

                {pending && (
                  <span className="text-xs text-gray-500 italic flex items-center gap-1">
                    <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10"
                        stroke="currentColor" strokeWidth="4"/>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
                    </svg>
                    scanning…
                  </span>
                )}
                {isClean && (
                  <span className="text-xs text-emerald-400 flex items-center gap-0.5">
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24"
                      stroke="currentColor" strokeWidth={2.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7"/>
                    </svg>
                    Clean
                  </span>
                )}
                {hasPii && (
                  <span className="text-xs text-red-400 font-semibold">
                    ⚠ {entry.matches!.map(m => m.label).join(", ")}
                  </span>
                )}

                <span className="text-xs text-gray-500 ml-auto">{entry.timestamp}</span>
              </div>
              <pre className="whitespace-pre-wrap break-words text-sm text-gray-100 font-mono">
                <HighlightedText text={entry.text} matches={entry.matches}/>
              </pre>
            </div>
          );
        })}
      </main>

      {/* Footer — storage bar */}
      <div className="shrink-0 px-3 py-2 bg-gray-800 border-t border-gray-700">
        <div className="flex justify-between text-xs text-gray-500 mb-1">
          <span>{entries.length} {entries.length === 1 ? "entry" : "entries"}</span>
          <span className="flex items-center gap-2">
            <span className="text-gray-600 font-mono">Ctrl+Alt+G</span>
            <span>{usedMB} / 5.00 MB ({pct}%)</span>
          </span>
        </div>
        <div className="h-0.5 bg-gray-700 rounded overflow-hidden">
          <div
            className={`h-full rounded transition-all ${pct > 80 ? "bg-red-500" : "bg-blue-600"}`}
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
    </div>
  );
}

// ── App ───────────────────────────────────────────────────────────────────────

export default function App() {
  const appWindow = getCurrentWindow();

  const [view,        setView]        = useState<View>("pet");
  const [modelReady,  setModelReady]  = useState(false);
  const [entries,     setEntries]     = useState<Entry[]>(() => loadHistory());
  const [alerts,      setAlerts]      = useState<AlertItem[]>([]);
  const [dlProgress,  setDlProgress]  = useState<DownloadProgress | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [showSetup,   setShowSetup]   = useState(false);

  const modelReadyRef  = useRef(false);
  const viewRef        = useRef<View>("pet");
  const hideTimerRef   = useRef<ReturnType<typeof setTimeout> | null>(null);
  const robotDownPos   = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => { modelReadyRef.current = modelReady; }, [modelReady]);
  useEffect(() => { viewRef.current = view; }, [view]);

  const alerting = alerts.length > 0;

  // ── Persist history ───────────────────────────────────────────────────────
  useEffect(() => {
    if (entries.length === 0) return;
    const trimmed = saveHistory(entries);
    if (trimmed.length !== entries.length) setEntries(trimmed);
  }, [entries]);

  // ── Window helpers ────────────────────────────────────────────────────────
  const positionAt = async (w: number, h: number) => {
    const x = window.screen.availWidth  - w - MARGIN;
    const y = window.screen.availHeight - h - MARGIN;
    await appWindow.setSize(new LogicalSize(w, h));
    await appWindow.setPosition(new LogicalPosition(x, y));
  };

  const scheduleHide = () => { /* always visible — no-op */ };

  const cancelHide = () => {
    if (hideTimerRef.current) { clearTimeout(hideTimerRef.current); hideTimerRef.current = null; }
  };

  // ── Init ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    (async () => {
      // Always show + position first so we know the window is reachable.
      try { await appWindow.show(); } catch (e) { console.error("[init] show:", e); }
      try { await positionAt(PET_W, PET_H); } catch (e) { console.error("[init] position:", e); }

      // Check whether the model is already on disk.
      let modelIsReady = false;
      try {
        modelIsReady = await invoke<boolean>("is_model_ready");
        setModelReady(modelIsReady);
        modelReadyRef.current = modelIsReady;
      } catch (e) { console.error("[init] is_model_ready:", e); }

      if (!modelIsReady) {
        setShowSetup(true);
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Retroactively scan entries that were recorded before the model was ready.
  useEffect(() => {
    if (!modelReady) return;
    const pending = entries.filter(e => e.matches === null);
    pending.forEach(entry => {
      invoke<PiiMatch[]>("scan_input", { text: entry.text })
        .then(matches => {
          setEntries(prev => prev.map(e => e.id === entry.id ? { ...e, matches } : e));
          if (matches.length > 0) {
            setAlerts(prev => [...prev.slice(-2), { id: nextAlertId++, matches }]);
          }
        })
        .catch(() => {});
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelReady]);

  // ── Event listeners ───────────────────────────────────────────────────────
  useEffect(() => {
    const ts = () => new Date().toLocaleTimeString([], {
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });

    const scan = async (text: string, source: Source) => {
      if (text.trim().length < 4) return;
      const id = nextId++;
      const base: Entry = { id, text, timestamp: ts(), source, matches: null };

      if (!modelReadyRef.current) {
        setEntries(prev => [...prev, base]);
        return;
      }

      try {
        const matches = await invoke<PiiMatch[]>("scan_input", { text });
        const entry: Entry = { ...base, matches };
        setEntries(prev => [...prev, entry]);

        if (matches.length > 0) {
          const item: AlertItem = { id: nextAlertId++, matches };
          setAlerts(prev => [...prev.slice(-2), item]);
          if (viewRef.current === "pet") {
            try { await appWindow.show(); } catch {}
            scheduleHide();
          }
        }
      } catch {
        setEntries(prev => [...prev, base]);
      }
    };

    const unlisteners = [
      listen<string>("input-complete",   e => scan(e.payload.trim(), "typed")),
      listen<string>("clipboard-update", e => scan(e.payload.trim(), "clipboard")),
      listen<string>("paste-event",      e => scan(e.payload.trim(), "pasted")),

      // Ctrl+Alt+G: toggle between pet ↔ history view
      listen("toggle-window", async () => {
        if (viewRef.current === "history") {
          setView("pet");
          try { await appWindow.setResizable(false); } catch {}
          try { await appWindow.setMinSize(new LogicalSize(PET_W, PET_H)); } catch {}
          try { await positionAt(PET_W, PET_H); } catch {}
        } else {
          cancelHide();
          try { await appWindow.setMinSize(new LogicalSize(300, 420)); } catch {}
          try { await appWindow.setResizable(true); } catch {}
          try { await positionAt(HIST_W, HIST_H); } catch {}
          setView("history");
        }
      }),

      listen("model-ready", () => {
        setModelReady(true);
        modelReadyRef.current = true;
        setDownloading(false);
        setShowSetup(false);
        // Schedule auto-hide: model just loaded, window was visible for setup.
        // If no PII in the next 30 s it will disappear on its own.
        scheduleHide();
      }),
      listen<DownloadProgress>("download-progress", e => setDlProgress(e.payload)),
    ];

    return () => { unlisteners.forEach(p => p.then(f => f())); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-dismiss oldest alert after 6 s
  useEffect(() => {
    if (!alerts.length) return;
    const t = setTimeout(() => setAlerts(prev => prev.slice(1)), 6000);
    return () => clearTimeout(t);
  }, [alerts]);

  // ── Actions ───────────────────────────────────────────────────────────────
  const startDownload = () => {
    setDownloading(true);
    setDlProgress({ file: "Starting…", pct: 0, done: false });
    invoke("download_model").catch(() => setDownloading(false));
  };

  const openHistory = async () => {
    cancelHide();
    try { await appWindow.setMinSize(new LogicalSize(300, 420)); } catch {}
    try { await appWindow.setResizable(true); } catch {}
    try { await positionAt(HIST_W, HIST_H); } catch {}
    try { await appWindow.show(); } catch {}
    setView("history");
  };

  const minimizeToRobot = async () => {
    setView("pet");
    try { await appWindow.setResizable(false); } catch {}
    try { await appWindow.setMinSize(new LogicalSize(PET_W, PET_H)); } catch {}
    try { await positionAt(PET_W, PET_H); } catch {}
  };

  const resizeWindow = (direction: ResizeDirection) => {
    appWindow.startResizeDragging(direction).catch(() => {});
  };

  const quitApp = () => {
    invoke("quit_app").catch(() => appWindow.close());
  };

  const clearHistory = () => {
    setEntries([]);
    setAlerts([]);
    localStorage.removeItem(STORAGE_KEY);
  };

  const handlePetClick = () => {
    if (!modelReady) {
      setShowSetup(s => !s);
    } else {
      openHistory();
    }
  };


  // ── Render: History view ──────────────────────────────────────────────────
  if (view === "history") {
    return (
      <HistoryView
        entries={entries}
        modelReady={modelReady}
        onMinimize={minimizeToRobot}
        onQuit={quitApp}
        onClear={clearHistory}
        onResize={resizeWindow}
      />
    );
  }

  // ── Render: Pet view ──────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-screen select-none" style={{ background: "transparent" }}>

      {/* rgba(0,0,0,0.01) is the minimum alpha that makes Windows send mouse
          events to this window instead of passing them through to whatever is
          below (fully-transparent pixels are click-through on Windows). */}
      <div data-tauri-drag-region className="flex-1"
        style={{ cursor: "grab", background: "rgba(0,0,0,0.01)" }}/>

      {/* Setup popup (model not ready) or alert bubble (PII detected) */}
      {showSetup && !modelReady ? (
        <SetupPopup
          onStart={startDownload}
          progress={dlProgress}
          downloading={downloading}
          onClose={() => setShowSetup(false)}
        />
      ) : alerting ? (
        <AlertBubble
          key={alerts[alerts.length - 1].id}
          alert={alerts[alerts.length - 1]}
          onDismiss={() => setAlerts(prev => prev.slice(0, -1))}
          onView={openHistory}
        />
      ) : null}

      {/* Pet robot */}
      <div
        data-tauri-drag-region
        className="flex justify-center pb-3"
        onMouseDown={(e) => {
          if (e.button === 0) robotDownPos.current = { x: e.clientX, y: e.clientY };
        }}
        onMouseUp={(e) => {
          const p = robotDownPos.current;
          robotDownPos.current = null;
          if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) < 5) handlePetClick();
        }}
        style={{
          cursor: "grab",
          animation: alerting
            ? "petBounce 0.6s ease-in-out"
            : "petBob 3s ease-in-out infinite",
        }}
      >
        <PetRobot alerting={alerting} ready={modelReady} />
      </div>
    </div>
  );
}
