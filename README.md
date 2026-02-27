# Starship Vector

Vector is a fast, local dataset explorer built with Tauri, React, and DuckDB. It allows users to quickly ingest, filter, sort, and search through datasets (like CSVs or Parquets) seamlessly on their desktop without needing to upload data to a remote server.

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

### MacOS (Your Current Environment)
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

### Publishing Releases
When you want to share a release on GitHub, **do not** manually upload the entire application directory or its uncompiled source code as a zipped "Release". GitHub automatically provides a zip of your source code when you cut a release tag.

Instead, you should only upload the **Compiled Application Bundles**:
- On **macOS**, upload the `.dmg` or `.app.tar.gz` from `src-tauri/target/release/bundle/dmg/`
- On **Windows**, upload the `.msi` or `.exe` installer setup from `src-tauri/target/release/bundle/msi/`
- On **Linux**, upload the `.AppImage` or `.deb` packages.

**Note on Git & GitHub:**
The root `.gitignore` and `src-tauri/.gitignore` are already configured to prevent heavy, compiled folders from being committed to your repository. 
The following folders **should always be omitted** from Git:
- `/node_modules/` (Local JS packages)
- `/dist/` (Compiled frontend assets)
- `/src-tauri/target/` (The Rust compiled backend binaries—often gigabytes in size)
- `/.env` or `.local` files
