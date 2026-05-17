use std::path::Path;
use std::sync::{Mutex, OnceLock};
use regex::Regex;
use tokenizers::Tokenizer;

// ── Public result type ────────────────────────────────────────────────────

#[derive(Debug, Clone, serde::Serialize)]
pub struct PiiMatch {
    pub label: String,
    pub text: String,
    pub start: usize,
    pub end: usize,
}

// ── Global artefacts ──────────────────────────────────────────────────────

type OrtSession = ort::session::Session;

static SESSION:   OnceLock<Mutex<OrtSession>> = OnceLock::new();
static TOKENIZER: OnceLock<Tokenizer>         = OnceLock::new();
static LABELS:    OnceLock<Vec<String>>       = OnceLock::new();

// ── Regex statics (one per PII category) ─────────────────────────────────

static EMAIL_RE:       OnceLock<Regex> = OnceLock::new();
static CC_RE:          OnceLock<Regex> = OnceLock::new();
static SSN_RE:         OnceLock<Regex> = OnceLock::new();
static PHONE_US_RE:    OnceLock<Regex> = OnceLock::new();
static PHONE_INTL_RE:  OnceLock<Regex> = OnceLock::new();
static IPV4_RE:        OnceLock<Regex> = OnceLock::new();
static IPV6_RE:        OnceLock<Regex> = OnceLock::new();
static IBAN_RE:        OnceLock<Regex> = OnceLock::new();
static MAC_RE:         OnceLock<Regex> = OnceLock::new();
static DOB_RE:         OnceLock<Regex> = OnceLock::new();
static BITCOIN_RE:     OnceLock<Regex> = OnceLock::new();
static ETHEREUM_RE:    OnceLock<Regex> = OnceLock::new();
static VIN_RE:         OnceLock<Regex> = OnceLock::new();
static EIN_RE:         OnceLock<Regex> = OnceLock::new();
static PASSPORT_RE:    OnceLock<Regex> = OnceLock::new();
static CC_CVV_RE:      OnceLock<Regex> = OnceLock::new();

const MAX_SEQ: usize = 512;

// Fallback used only if config.json cannot be parsed.
// The actual labels are read dynamically from the downloaded config.json.
const FALLBACK_LABELS: &[&str] = &["O"];

// ── Public API ────────────────────────────────────────────────────────────

pub fn is_ready() -> bool {
    SESSION.get().is_some() && TOKENIZER.get().is_some()
}

pub fn init(data_dir: &Path) -> Result<(), String> {
    // ── Regex initialisation ──────────────────────────────────────────────

    EMAIL_RE.get_or_init(|| {
        Regex::new(r"(?i)[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}").unwrap()
    });

    CC_RE.get_or_init(|| {
        // Visa, Mastercard, Amex, Discover
        Regex::new(
            r"\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13}|6(?:011|5[0-9]{2})[0-9]{12})\b"
        ).unwrap()
    });

    SSN_RE.get_or_init(|| {
        // XXX-XX-XXXX or XXXXXXXXX (Rust regex has no lookahead)
        Regex::new(r"\b\d{3}[- ]?\d{2}[- ]?\d{4}\b").unwrap()
    });

    PHONE_US_RE.get_or_init(|| {
        Regex::new(r"\b(\+1[\s\-]?)?\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}\b").unwrap()
    });

    PHONE_INTL_RE.get_or_init(|| {
        // +CC followed by 6–14 digits (non-US international)
        Regex::new(r"\+(?:[2-9][0-9]|[1][^0-9\s])[0-9\s\-\.]{6,15}[0-9]").unwrap()
    });

    IPV4_RE.get_or_init(|| {
        Regex::new(
            r"\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b"
        ).unwrap()
    });

    IPV6_RE.get_or_init(|| {
        // Full-form IPv6 only to avoid false positives
        Regex::new(r"\b(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}\b").unwrap()
    });

    IBAN_RE.get_or_init(|| {
        // 2 country-code letters + 2 check digits + 11–30 alphanumeric BBAN
        Regex::new(r"\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b").unwrap()
    });

    MAC_RE.get_or_init(|| {
        Regex::new(r"\b(?:[0-9A-Fa-f]{2}[:\-]){5}[0-9A-Fa-f]{2}\b").unwrap()
    });

    DOB_RE.get_or_init(|| {
        // MM/DD/YYYY, MM-DD-YYYY, YYYY-MM-DD, YYYY/MM/DD
        Regex::new(
            r"\b(?:(?:0?[1-9]|1[0-2])[-/](?:0?[1-9]|[12]\d|3[01])[-/](?:19|20)\d{2}|(?:19|20)\d{2}[-/](?:0?[1-9]|1[0-2])[-/](?:0?[1-9]|[12]\d|3[01]))\b"
        ).unwrap()
    });

    BITCOIN_RE.get_or_init(|| {
        // Legacy (1.../3...) and bech32 (bc1...)
        Regex::new(r"\b(?:bc1[ac-hj-np-z02-9]{6,87}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})\b").unwrap()
    });

    ETHEREUM_RE.get_or_init(|| {
        Regex::new(r"\b0x[0-9a-fA-F]{40}\b").unwrap()
    });

    VIN_RE.get_or_init(|| {
        // Exactly 17 chars from the VIN alphabet (excludes I, O, Q)
        Regex::new(r"\b[A-HJ-NPR-Z0-9]{17}\b").unwrap()
    });

    EIN_RE.get_or_init(|| {
        // US Employer Identification Number: XX-XXXXXXX
        Regex::new(r"\b\d{2}-\d{7}\b").unwrap()
    });

    PASSPORT_RE.get_or_init(|| {
        // Generic: 1–2 uppercase letters followed by 6–9 digits
        // Covers US (9 digits), UK (2 letters + 7 digits), many EU formats
        Regex::new(r"\b[A-Z]{1,2}[0-9]{6,9}\b").unwrap()
    });

    CC_CVV_RE.get_or_init(|| {
        // CVV by itself is only 3-4 digits; only flag it when preceded by
        // a keyword so we don't match every 3-digit number.
        Regex::new(r"(?i)\bcvv[:\s#]*\d{3,4}\b|\bcvc[:\s#]*\d{3,4}\b|\bsecurity code[:\s]*\d{3,4}\b").unwrap()
    });

    // ── Return early if session already loaded ────────────────────────────
    if SESSION.get().is_some() {
        return Ok(());
    }

    // ── Label map ─────────────────────────────────────────────────────────
    let config_path = data_dir.join("config.json");
    if config_path.exists() {
        if let Ok(raw) = std::fs::read_to_string(&config_path) {
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(&raw) {
                if let Some(map) = val.get("id2label").and_then(|v| v.as_object()) {
                    let count = map.len();
                    let mut labels = vec![String::from("O"); count];
                    for (k, v) in map {
                        if let (Ok(i), Some(s)) = (k.parse::<usize>(), v.as_str()) {
                            if i < count { labels[i] = s.to_string(); }
                        }
                    }
                    LABELS.get_or_init(|| labels);
                }
            }
        }
    }
    LABELS.get_or_init(|| FALLBACK_LABELS.iter().map(|s| s.to_string()).collect());

    // ── Tokenizer ─────────────────────────────────────────────────────────
    let tok_path = data_dir.join("tokenizer.json");
    if !tok_path.exists() {
        return Err("tokenizer.json not found — download model first".into());
    }
    let tok = Tokenizer::from_file(&tok_path)
        .map_err(|e| format!("tokenizer load: {e}"))?;
    TOKENIZER.get_or_init(|| tok);

    // ── ONNX session ──────────────────────────────────────────────────────
    let model_path = data_dir.join("model.onnx");
    if !model_path.exists() {
        return Err("model.onnx not found — download model first".into());
    }
    let session = OrtSession::builder()
        .map_err(|e| format!("ort builder: {e}"))?
        .with_intra_threads(2)
        .map_err(|e| format!("ort threads: {e}"))?
        .commit_from_file(&model_path)
        .map_err(|e| format!("ort load: {e}"))?;
    SESSION.get_or_init(|| Mutex::new(session));

    Ok(())
}

pub fn process_text(text: &str) -> Vec<PiiMatch> {
    let mut hits: Vec<PiiMatch> = Vec::new();

    // ── Layer 1: Regex fast-path ──────────────────────────────────────────
    // Structured PII with deterministic patterns — instant, no model needed.
    for (label, slot) in [
        ("EMAIL",        EMAIL_RE.get()),
        ("CREDIT_CARD",  CC_RE.get()),
        ("SSN",          SSN_RE.get()),
        ("PHONE",        PHONE_US_RE.get()),
        ("PHONE",        PHONE_INTL_RE.get()),   // same label, different pattern
        ("IP_ADDRESS",   IPV4_RE.get()),
        ("IP_ADDRESS",   IPV6_RE.get()),
        ("IBAN",         IBAN_RE.get()),
        ("MAC_ADDRESS",  MAC_RE.get()),
        ("DATE_OF_BIRTH",DOB_RE.get()),
        ("BITCOIN",      BITCOIN_RE.get()),
        ("ETHEREUM",     ETHEREUM_RE.get()),
        ("VIN",          VIN_RE.get()),
        ("EIN",          EIN_RE.get()),
        ("PASSPORT",     PASSPORT_RE.get()),
        ("CVV",          CC_CVV_RE.get()),
    ] {
        if let Some(re) = slot {
            for m in re.find_iter(text) {
                hits.push(PiiMatch {
                    label: label.into(),
                    text:  m.as_str().into(),
                    start: m.start(),
                    end:   m.end(),
                });
            }
        }
    }

    // De-duplicate overlapping regex hits (keep the first / longest match).
    hits.sort_by_key(|h| h.start);
    hits.dedup_by(|b, a| {
        // b comes after a in the sorted list; drop b if it overlaps a
        b.start < a.end
    });

    // ── Layer 2: DeBERTa NER ──────────────────────────────────────────────
    // Unstructured PII: names, addresses, usernames, personal URLs, IDs.
    if text.split_whitespace().count() < 3 { return hits; }

    let (Some(sess_lock), Some(tok), Some(labels)) =
        (SESSION.get(), TOKENIZER.get(), LABELS.get())
    else { return hits };

    let Ok(enc) = tok.encode(text, true) else { return hits };
    let ids   = enc.get_ids();
    let attn  = enc.get_attention_mask();
    let types = enc.get_type_ids();
    let offs  = enc.get_offsets();
    let n     = ids.len().min(MAX_SEQ);
    let num_labels = labels.len();

    let make = |v: &[u32]| -> ort::Result<ort::value::Value<ort::value::TensorValueType<i64>>> {
        let data: Vec<i64> = v[..n].iter().map(|&x| x as i64).collect();
        ort::value::Tensor::<i64>::from_array(([1usize, n], data))
    };

    let (Ok(input_ids), Ok(attn_mask), Ok(tok_types)) = (make(ids), make(attn), make(types))
    else { return hits };

    let Ok(mut sess) = sess_lock.lock() else { return hits };

    let Ok(outputs) = sess.run(ort::inputs![
        "input_ids"      => input_ids,
        "attention_mask" => attn_mask,
        "token_type_ids" => tok_types,
    ]) else { return hits };

    let Ok((_shape, data)) = outputs["logits"].try_extract_tensor::<f32>() else { return hits };

    // Greedy BIO decode (skip [CLS] token 0 and [SEP] token n-1)
    let mut span: Option<(String, usize, usize)> = None;

    for i in 1..n.saturating_sub(1) {
        let row_start = i * num_labels;
        let row = match data.get(row_start..row_start + num_labels) {
            Some(r) => r,
            None => break,
        };
        let pred = row
            .iter()
            .enumerate()
            .max_by(|a, b| a.1.partial_cmp(b.1).unwrap_or(std::cmp::Ordering::Equal))
            .map(|(idx, _)| idx)
            .unwrap_or(0);

        let label = labels.get(pred).map(String::as_str).unwrap_or("O");
        let (cs, ce) = offs.get(i).copied().unwrap_or((0, 0));

        if label.starts_with("B-") {
            flush(&mut hits, text, &mut span);
            span = Some((label[2..].into(), cs, ce));
        } else if label.starts_with("I-") {
            if let Some((ref el, _, ref mut ee)) = span {
                if label[2..] == *el { *ee = ce; }
            }
        } else {
            flush(&mut hits, text, &mut span);
        }
    }
    flush(&mut hits, text, &mut span);

    hits
}

fn flush(hits: &mut Vec<PiiMatch>, text: &str, span: &mut Option<(String, usize, usize)>) {
    if let Some((label, start, end)) = span.take() {
        let s = text.get(start..end).unwrap_or("").trim();
        if !s.is_empty() {
            hits.push(PiiMatch { label, text: s.into(), start, end });
        }
    }
}
