pub mod commands;
pub mod db;
pub mod logparser;

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app_state = match db::AppState::new() {
        Ok(state) => state,
        Err(e) => {
            eprintln!("Failed to initialize DuckDB state: {}", e);
            std::process::exit(1);
        }
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(app_state)
        .invoke_handler(tauri::generate_handler![
            greet,
            commands::load_file,
            commands::get_schema,
            commands::fetch_data,
            commands::get_distinct_values,
            commands::export_csv,
            commands::get_timeline_data,
            commands::open_database,
            commands::select_table
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
