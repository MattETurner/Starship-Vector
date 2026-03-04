# Starship Vector

Vector is a fast, local dataset explorer built with Tauri, React, and DuckDB. It allows users to quickly ingest, filter, sort, and search through datasets (like CSVs or Parquets) seamlessly on their desktop without needing to upload data to a remote server.

<img width="680" height="435" alt="image" src="https://github.com/user-attachments/assets/6ff37164-9238-4f69-b615-790cdee807c9" />

## Features
- **Local Ingestion:** Parse local files instantly using an embedded DuckDB instance.
- **Advanced Filtering and Search:** Use comprehensive Datagrid-like filters or a global text search across the dataset.
- **Row Selection:** Select specific rows to isolate data, maintaining visibility even when global filters change.
- **Export to CSV:** Instantly save out your filtered or selected view as a cleanly formatted local `.csv`.

## Development Prerequisites

To work on or compile Starship Vector, you will need the standard Tauri dependencies installed on your system.

### All Platforms
- **[Node.js](https://nodejs.org/)** (v18 or higher)
- **[Rust](https://www.rust-lang.org/tools/install)** (`rustup`, `cargo`, `rustc`)

### MacOS
- Xcode Command Line Tools: `xcode-select --install`

### Windows Compilation
Compiling a Tauri application for Windows *must* generally be done **on a Windows machine** (or via a CI/CD pipeline like GitHub Actions). Cross-compiling from macOS to Windows with native WebView2 bindings is highly complex and error-prone. 

If compiling locally on Windows, you require:
- **Microsoft C++ Build Tools** (Select "Desktop development with C++")
- **WebView2 Runtime** (Generally pre-installed on modern Windows 10/11)

### Linux (Debian/Ubuntu)
```bash
sudo apt update
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
```

## Running Locally

1. Install Node dependencies:
   ```bash
   npm install
   ```
2. Start the development server (This boots up Vite on localhost:1420 and compiles the Rust backend):
   ```bash
   npx tauri dev
   ```

## Compiling for Release

To build a production-ready application bundle:

```bash
npx tauri build
```

This will compile the frontend and the Rust backend in release mode. The resulting application binaries and installers will be located in:
`src-tauri/target/release/bundle/`

### macOS Gatekeeper Notice

When you build the app locally without an Apple Developer certificate, macOS Gatekeeper may show a warning such as **"Vector is damaged and can't be opened"** when you try to run it. This is expected for unsigned applications and does not mean the app is actually damaged.

To fix this, remove the quarantine attribute from the built app:

```bash
xattr -cr src-tauri/target/release/bundle/macos/Vector.app
```

Alternatively, you can right-click (or Control-click) the app and select **Open** to bypass the Gatekeeper warning for that session.

