# Starship Vector

A fast, local dataset explorer built with [Tauri](https://tauri.app), [React](https://react.dev), and [DuckDB](https://duckdb.org). Load CSV, Parquet, JSON, and log files instantly — no server, no uploads, no cloud.

## Features

- **Local ingestion** — files are read directly by an embedded DuckDB instance; nothing leaves your machine.
- **Filtering & search** — column-level filters plus a global text search across the full dataset.
- **Row selection** — pin rows of interest; they remain visible as filters change.
- **Timeline heatmap** — auto-detected timestamp columns are visualised as an activity heatmap.
- **Log file support** — parses Apache/Nginx access & error logs, syslog (RFC 3164/5424), and plain-text logs into structured columns.
- **Export to CSV** — save the current filtered or selected view as a `.csv`.

---

## Installation

Pre-built binaries are available on the [Releases](../../releases) page for macOS (Apple Silicon & Intel), Windows, and Linux.

### macOS — Gatekeeper bypass

The macOS binary is currently **unsigned**. On first launch, macOS will block it with a "cannot be opened" alert. To allow it:

1. Open **System Settings → Privacy & Security**.
2. Scroll to the Security section; click **Open Anyway** next to the blocked app name.
3. Confirm in the dialog that follows.

Alternatively, from Terminal:
```bash
xattr -dr com.apple.quarantine /Applications/Starship\ Vector.app
```

### Windows

Download and run the `.msi` installer. If Windows Defender SmartScreen shows a warning, click **More info → Run anyway**.

### Linux (Debian/Ubuntu)

Download the `.deb` package and install it:
```bash
sudo dpkg -i starship-vector_*.deb
```

---

## Development

### Prerequisites

**All platforms**
- [Node.js](https://nodejs.org/) v18 or later
- [Rust](https://www.rust-lang.org/tools/install) (`rustup` / `cargo`)

**macOS**
```bash
xcode-select --install
```

**Linux (Debian/Ubuntu)**
```bash
sudo apt update && sudo apt install \
  libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
```

**Windows** — install [Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) with the "Desktop development with C++" workload. WebView2 is pre-installed on Windows 10/11.

> **Note:** Windows builds must be compiled on a Windows machine or via CI. Cross-compiling from macOS is not supported.

### Running locally

```bash
npm install
npx tauri dev
```

This starts Vite on `localhost:1420` and compiles the Rust backend in development mode.

### Building a release binary

```bash
npx tauri build
```

Output bundles are written to `src-tauri/target/release/bundle/`.
