use duckdb::{Connection, Result};
use std::sync::Mutex;

pub struct AppState {
    pub db: Mutex<Connection>,
}

impl AppState {
    pub fn new() -> Result<Self> {
        let conn = Connection::open_in_memory()?;
        // Try to load json extension for dynamic row querying
        let _ = conn.execute_batch("INSTALL json; LOAD json;");
        Ok(Self {
            db: Mutex::new(conn),
        })
    }
}
