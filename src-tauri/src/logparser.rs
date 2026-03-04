//! Log file parser for Starship Vector.
//!
//! Auto-detects the format by sampling the first 20 non-empty lines and
//! picking the format that matches ≥ 70 % of them.  Falls back to a single
//! `raw` column if nothing fits.
//!
//! Supported formats
//! -----------------
//! 1. Apache / Nginx **Combined Log Format**  (CLF + Referer + User-Agent)
//! 2. Apache / Nginx **Common Log Format**    (CLF only)
//! 3. **Nginx Error Log**
//! 4. **ISO 8601 Syslog**  (systemd / RFC 5424 style)
//! 5. **RFC 3164 Syslog**  (classic BSD / rsyslog style)
//! 6. **Raw** fallback     (every line becomes one `raw` column)

use once_cell::sync::Lazy;
use regex::Regex;
use std::fs::File;
use std::io::{BufRead, BufReader};

// ── compiled regexes (done once, at first use) ────────────────────────────────

/// Apache / Nginx Combined Log Format
/// `IP - user [timestamp] "METHOD /path PROTO" status bytes "referer" "ua"`
static RE_COMBINED: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r#"^(\S+)\s+(\S+)\s+(\S+)\s+\[([^\]]+)\]\s+"([^"]*)"\s+(\S+)\s+(\S+)\s+"([^"]*)"\s+"([^"]*)""#,
    )
    .unwrap()
});

/// Apache / Nginx Common Log Format (no referer / user-agent)
/// Anchored at end so it doesn't match Combined lines
static RE_COMMON: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r#"^(\S+)\s+(\S+)\s+(\S+)\s+\[([^\]]+)\]\s+"([^"]*)"\s+(\S+)\s+(\S+)\s*$"#,
    )
    .unwrap()
});

/// Nginx Error Log: `2023/01/15 12:34:56 [error] 12345#12345: message`
static RE_NGINX_ERR: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"^(\d{4}/\d{2}/\d{2} \d{2}:\d{2}:\d{2}) \[(\w+)\] \d+#\d+: (.+)$").unwrap()
});

/// Modern ISO 8601 syslog  `2023-01-15T12:34:56Z host proc[pid]: msg`
static RE_ISO_SYSLOG: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r"^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)\s+(\S+)\s+(\S+?)(?:\[(\d+)\])?:\s+(.+)$",
    )
    .unwrap()
});

/// Classic BSD / rsyslog  `Mar  4 12:34:56 host proc[pid]: msg`
static RE_SYSLOG: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r"^(\w{3}\s{1,2}\d{1,2}\s+\d{2}:\d{2}:\d{2})\s+(\S+)\s+(\S+?)(?:\[(\d+)\])?:\s+(.*)$",
    )
    .unwrap()
});

// ── column name sets ──────────────────────────────────────────────────────────

const COLS_COMBINED: &[&str] = &[
    "client_ip", "ident", "auth_user", "timestamp",
    "method", "path", "protocol", "status", "bytes",
    "referer", "user_agent",
];
const COLS_COMMON: &[&str] = &[
    "client_ip", "ident", "auth_user", "timestamp",
    "method", "path", "protocol", "status", "bytes",
];
const COLS_NGINX_ERR: &[&str] = &["timestamp", "level", "message"];
const COLS_SYSLOG: &[&str] = &["timestamp", "hostname", "process", "pid", "message"];
const COLS_RAW: &[&str] = &["raw"];

// ── per-format parse functions ────────────────────────────────────────────────

/// Return None for empty / dash values so DuckDB stores NULL.
fn opt(s: &str) -> Option<String> {
    if s.is_empty() || s == "-" {
        None
    } else {
        Some(s.to_owned())
    }
}

/// Split a CLF request string `"METHOD /path PROTO"` into its three parts.
fn split_request(req: &str) -> (Option<String>, Option<String>, Option<String>) {
    let mut parts = req.splitn(3, ' ');
    let method = opt(parts.next().unwrap_or("-"));
    let path = opt(parts.next().unwrap_or("-"));
    let proto = opt(parts.next().unwrap_or("-"));
    (method, path, proto)
}

type Row = Vec<Option<String>>;

fn parse_combined(line: &str) -> Option<Row> {
    let c = RE_COMBINED.captures(line)?;
    let g = |i: usize| opt(c.get(i).map_or("", |m| m.as_str()));
    let (method, path, proto) = split_request(c.get(5).map_or("", |m| m.as_str()));
    Some(vec![
        g(1), g(2), g(3), g(4), // ip ident user timestamp
        method, path, proto,     // method path protocol
        g(6), g(7),              // status bytes
        g(8), g(9),              // referer user_agent
    ])
}

fn parse_common(line: &str) -> Option<Row> {
    let c = RE_COMMON.captures(line)?;
    let g = |i: usize| opt(c.get(i).map_or("", |m| m.as_str()));
    let (method, path, proto) = split_request(c.get(5).map_or("", |m| m.as_str()));
    Some(vec![
        g(1), g(2), g(3), g(4),
        method, path, proto,
        g(6), g(7),
    ])
}

fn parse_nginx_err(line: &str) -> Option<Row> {
    let c = RE_NGINX_ERR.captures(line)?;
    let g = |i: usize| opt(c.get(i).map_or("", |m| m.as_str()));
    Some(vec![g(1), g(2), g(3)])
}

fn parse_iso_syslog(line: &str) -> Option<Row> {
    let c = RE_ISO_SYSLOG.captures(line)?;
    Some(vec![
        opt(c.get(1).map_or("", |m| m.as_str())),
        opt(c.get(2).map_or("", |m| m.as_str())),
        opt(c.get(3).map_or("", |m| m.as_str())),
        c.get(4).map(|m| m.as_str().to_owned()), // pid may be absent → None
        opt(c.get(5).map_or("", |m| m.as_str())),
    ])
}

fn parse_syslog(line: &str) -> Option<Row> {
    let c = RE_SYSLOG.captures(line)?;
    Some(vec![
        opt(c.get(1).map_or("", |m| m.as_str())),
        opt(c.get(2).map_or("", |m| m.as_str())),
        opt(c.get(3).map_or("", |m| m.as_str())),
        c.get(4).map(|m| m.as_str().to_owned()),
        opt(c.get(5).map_or("", |m| m.as_str())),
    ])
}

fn parse_raw(line: &str) -> Option<Row> {
    Some(vec![Some(line.to_owned())])
}

// ── format registry ───────────────────────────────────────────────────────────

struct Fmt {
    name: &'static str,
    columns: &'static [&'static str],
    parse: fn(&str) -> Option<Row>,
}

fn all_formats() -> Vec<Fmt> {
    vec![
        Fmt { name: "Apache Combined Log", columns: COLS_COMBINED, parse: parse_combined },
        Fmt { name: "Apache/Nginx Common Log", columns: COLS_COMMON, parse: parse_common },
        Fmt { name: "Nginx Error Log", columns: COLS_NGINX_ERR, parse: parse_nginx_err },
        Fmt { name: "ISO Syslog", columns: COLS_SYSLOG, parse: parse_iso_syslog },
        Fmt { name: "Syslog (RFC 3164)", columns: COLS_SYSLOG, parse: parse_syslog },
        Fmt { name: "Raw", columns: COLS_RAW, parse: parse_raw },
    ]
}

// ── public entry point ────────────────────────────────────────────────────────

/// Detect the log format by sampling up to 20 lines, then stream-insert all
/// rows into a fresh DuckDB `dataset` table (500 rows per batch).
///
/// The caller is responsible for dropping any existing `dataset` / `row_id_seq`
/// before calling this function.
pub fn detect_and_load(conn: &duckdb::Connection, path: &str) -> Result<String, String> {
    // ── sample for format detection ──────────────────────────────────────────
    let sample: Vec<String> = {
        let f = File::open(path).map_err(|e| e.to_string())?;
        BufReader::new(f)
            .lines()
            .filter_map(|l| l.ok())
            .filter(|l| !l.trim().is_empty() && !l.starts_with('#'))
            .take(20)
            .collect()
    };

    if sample.is_empty() {
        return Err("Log file appears to be empty".to_string());
    }

    let formats = all_formats();
    let fmt = formats
        .iter()
        .find(|f| {
            let hits = sample.iter().filter(|l| (f.parse)(l).is_some()).count();
            hits as f64 / sample.len() as f64 >= 0.70
        })
        .unwrap_or_else(|| formats.last().unwrap()); // Raw always matches

    // ── create table ─────────────────────────────────────────────────────────
    let col_defs: String = fmt
        .columns
        .iter()
        .map(|c| format!("\"{}\" VARCHAR", c))
        .collect::<Vec<_>>()
        .join(", ");

    conn.execute_batch(&format!(
        "CREATE SEQUENCE row_id_seq; CREATE TABLE dataset (_row_id BIGINT, {col_defs});"
    ))
    .map_err(|e| e.to_string())?;

    let col_names: String = fmt
        .columns
        .iter()
        .map(|c| format!("\"{c}\""))
        .collect::<Vec<_>>()
        .join(", ");

    // ── stream + batch-insert ─────────────────────────────────────────────────
    const BATCH: usize = 500;
    let mut buf: Vec<String> = Vec::with_capacity(BATCH);

    conn.execute_batch("BEGIN").map_err(|e| e.to_string())?;

    let f2 = File::open(path).map_err(|e| e.to_string())?;
    for line in BufReader::new(f2).lines() {
        let line = line.map_err(|e| e.to_string())?;
        if line.trim().is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some(vals) = (fmt.parse)(&line) {
            let sql_vals: Vec<String> = vals
                .iter()
                .map(|v| match v {
                    Some(s) => format!("'{}'", s.replace('\'', "''")),
                    None => "NULL".to_string(),
                })
                .collect();
            buf.push(format!("(nextval('row_id_seq'), {})", sql_vals.join(", ")));
        }
        if buf.len() >= BATCH {
            flush(&conn, &col_names, &mut buf)?;
        }
    }
    if !buf.is_empty() {
        flush(&conn, &col_names, &mut buf)?;
    }

    conn.execute_batch("COMMIT").map_err(|e| e.to_string())?;

    Ok(fmt.name.to_string())
}

fn flush(conn: &duckdb::Connection, col_names: &str, buf: &mut Vec<String>) -> Result<(), String> {
    let sql = format!(
        "INSERT INTO dataset (_row_id, {col_names}) VALUES {}",
        buf.join(", ")
    );
    conn.execute_batch(&sql).map_err(|e| e.to_string())?;
    buf.clear();
    Ok(())
}
