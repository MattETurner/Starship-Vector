use crate::db::AppState;
use serde::Serialize;

#[derive(Serialize)]
pub struct SchemaColumn {
    pub name: String,
    pub data_type: String,
}

#[derive(Serialize)]
pub struct TableResponse {
    pub rows: Vec<serde_json::Value>,
    pub total_rows: usize,
}

#[derive(Serialize)]
pub struct TimelineData {
    pub bucket: String,
    pub count: usize,
}

#[tauri::command]
pub fn load_file(state: tauri::State<AppState>, path: &str) -> Result<String, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;

    // Detach any previously attached Starship database so we return to a clean
    // in-memory session for this flat-file load.
    let _ = conn.execute_batch("DETACH IF EXISTS forensic_db;");

    // Drop existing sequence and table if any
    conn.execute_batch("DROP TABLE IF EXISTS dataset;")
        .map_err(|e| e.to_string())?;
    conn.execute_batch("DROP SEQUENCE IF EXISTS row_id_seq;")
        .map_err(|e| e.to_string())?;

    // Determine whether this looks like a log file by extension.
    let ext = std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .unwrap_or_default();

    let is_log = matches!(ext.as_str(), "log" | "syslog" | "access" | "error");

    if is_log {
        // Stream-parse the log file and insert into DuckDB.
        // Returns the detected format name for the success message.
        let fmt_name = crate::logparser::detect_and_load(&conn, path)?;
        Ok(format!("Loaded as «{fmt_name}»"))
    } else {
        // For CSV / JSON / Parquet DuckDB's reader handles everything.
        conn.execute_batch(
            &format!(
                "CREATE SEQUENCE row_id_seq;
                 CREATE TABLE dataset AS SELECT nextval('row_id_seq') as _row_id, * FROM '{}';",
                path
            )
        )
        .map_err(|e| e.to_string())?;
        Ok("File loaded successfully".to_string())
    }
}

#[tauri::command]
pub fn get_schema(state: tauri::State<AppState>) -> Result<Vec<SchemaColumn>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;

    let mut stmt = conn
        .prepare("PRAGMA table_info('dataset')")
        .map_err(|e| e.to_string())?;

    let columns = stmt
        .query_map([], |row| {
            Ok(SchemaColumn {
                name: row.get(1)?,
                data_type: row.get(2)?,
            })
        })
        .map_err(|e| e.to_string())?;

    let mut schema = Vec::new();
    for c in columns.flatten() {
        if c.name != "_row_id" {
            schema.push(c);
        }
    }

    Ok(schema)
}

#[derive(serde::Deserialize)]
pub struct Filter {
    pub column: String,
    pub operator: String,
    pub values: Vec<String>,
}

#[derive(serde::Deserialize)]
pub struct Sort {
    pub column: String,
    pub desc: bool,
}

fn build_where_clause(
    cols: &[String],
    global_search: &Option<String>,
    filters: &Option<Vec<Filter>>,
    selected_row_ids: &Option<Vec<i64>>,
) -> String {
    let mut where_clauses = Vec::new();
    
    // Explicitly selected rows OVERRIDE global search and filters
    if let Some(ids) = selected_row_ids {
        if !ids.is_empty() {
            let id_strs: Vec<String> = ids.iter().map(|id| id.to_string()).collect();
            return format!("WHERE _row_id IN ({})", id_strs.join(", "));
        }
    }
    
    if let Some(search) = global_search {
        if !search.is_empty() {
            let safe_search = search.replace("'", "''");
            let mut or_clauses = Vec::new();
            for col in cols {
                or_clauses.push(format!("CAST(\"{}\" AS VARCHAR) ILIKE '%{}%'", col.replace("\"", "\"\""), safe_search));
            }
            if !or_clauses.is_empty() {
                where_clauses.push(format!("({})", or_clauses.join(" OR ")));
            }
        }
    }

    if let Some(filts) = filters {
        for f in filts {
            if f.values.is_empty() { continue; }
            let safe_col = format!("\"{}\"", f.column.replace("\"", "\"\""));
            
            let clause = match f.operator.as_str() {
                "in" => {
                    let safe_vals: Vec<String> = f.values.iter().map(|v| format!("'{}'", v.replace("'", "''"))).collect();
                    format!("CAST({} AS VARCHAR) IN ({})", safe_col, safe_vals.join(", "))
                },
                "between" => {
                    if f.values.len() == 2 {
                        let safe_start = f.values[0].replace("'", "''");
                        let safe_end = f.values[1].replace("'", "''");
                        format!("{} BETWEEN '{}' AND '{}'", safe_col, safe_start, safe_end)
                    } else {
                        continue;
                    }
                },
                _ => {
                    let safe_val = f.values[0].replace("'", "''");
                    match f.operator.as_str() {
                        "contains" | "ilike" => format!("CAST({} AS VARCHAR) ILIKE '%{}%'", safe_col, safe_val),
                        "equals" | "=" => format!("CAST({} AS VARCHAR) = '{}'", safe_col, safe_val),
                        "starts_with" => format!("CAST({} AS VARCHAR) ILIKE '{}%'", safe_col, safe_val),
                        "ends_with" => format!("CAST({} AS VARCHAR) ILIKE '%{}'", safe_col, safe_val),
                        ">" | ">=" | "<" | "<=" | "!=" => format!("{} {} '{}'", safe_col, f.operator, safe_val),
                        _ => format!("CAST({} AS VARCHAR) ILIKE '%{}%'", safe_col, safe_val),
                    }
                }
            };
            where_clauses.push(clause);
        }
    }

    if where_clauses.is_empty() {
        "".to_string()
    } else {
        format!("WHERE {}", where_clauses.join(" AND "))
    }
}

#[tauri::command]
pub fn fetch_data(
    state: tauri::State<AppState>,
    limit: usize,
    offset: usize,
    global_search: Option<String>,
    filters: Option<Vec<Filter>>,
    sorts: Option<Vec<Sort>>,
    selected_row_ids: Option<Vec<i64>>,
) -> Result<TableResponse, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;

    // Fetch schema columns for global search dynamic bindings
    let mut stmt = conn
        .prepare("PRAGMA table_info('dataset')")
        .map_err(|e| e.to_string())?;

    let columns = stmt
        .query_map([], |row| {
            let name: String = row.get(1)?;
            Ok(name)
        })
        .map_err(|e| e.to_string())?;

    let mut cols = Vec::new();
    for name in columns.flatten() {
        if name != "_row_id" {
            cols.push(name);
        }
    }

    let inner_where = build_where_clause(&cols, &global_search, &filters, &selected_row_ids);

    // Build ORDER BY clause
    let order_sql = if let Some(srts) = sorts {
        if srts.is_empty() {
            "".to_string()
        } else {
            let order_parts: Vec<String> = srts.into_iter().map(|s| {
                let safe_col = format!("\"{}\"", s.column.replace("\"", "\"\""));
                let dir = if s.desc { "DESC" } else { "ASC" };
                format!("{} {}", safe_col, dir)
            }).collect();
            format!("ORDER BY {}", order_parts.join(", "))
        }
    } else {
        "".to_string()
    };

    // Get total rows with active filters
    let count_query = format!("SELECT count(*) FROM dataset {}", inner_where);
    let mut count_stmt = conn
        .prepare(&count_query)
        .map_err(|e| format!("Count error: {} - {}", e, count_query))?;
    let total_rows: usize = count_stmt.query_row([], |row| row.get(0)).unwrap_or(0);

    // Fetch limited rows
    let query = format!(
        "SELECT to_json(req) FROM (SELECT * FROM dataset {} {} LIMIT {} OFFSET {}) req",
        inner_where, order_sql, limit, offset
    );
    let mut stmt = conn.prepare(&query).map_err(|e| format!("Query error: {} - {}", e, query))?;

    let rows = stmt
        .query_map([], |row| {
            let json_str: String = row.get(0)?;
            Ok(json_str)
        })
        .map_err(|e| e.to_string())?;

    let mut data = Vec::new();
    for json_str in rows.flatten() {
        if let Ok(val) = serde_json::from_str(&json_str) {
            data.push(val);
        }
    }

    Ok(TableResponse {
        rows: data,
        total_rows,
    })
}

#[tauri::command]
pub fn get_distinct_values(
    state: tauri::State<AppState>,
    column: &str,
    global_search: Option<String>,
    filters: Option<Vec<Filter>>,
) -> Result<Vec<String>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    
    // Fetch schema columns for global search dynamic bindings
    let mut stmt = conn
        .prepare("PRAGMA table_info('dataset')")
        .map_err(|e| e.to_string())?;

    let columns = stmt
        .query_map([], |row| {
            let name: String = row.get(1)?;
            Ok(name)
        })
        .map_err(|e| e.to_string())?;

    let mut cols = Vec::new();
    for name in columns.flatten() {
        if name != "_row_id" {
            cols.push(name);
        }
    }

    let mut inner_where = build_where_clause(&cols, &global_search, &filters, &None);
    
    // Sanitize column name to prevent injection/syntax errors
    let safe_col = format!("\"{}\"", column.replace("\"", "\"\""));
    
    if inner_where.is_empty() {
        inner_where = format!("WHERE {} IS NOT NULL", safe_col);
    } else {
        inner_where = format!("{} AND {} IS NOT NULL", inner_where, safe_col);
    }

    // Cast to VARCHAR and order alphabetically, limiting to 1000 for safety
    let query = format!(
        "SELECT DISTINCT CAST({} AS VARCHAR) FROM dataset {} ORDER BY 1 ASC LIMIT 1000",
        safe_col, inner_where
    );
    
    let mut stmt = conn.prepare(&query).map_err(|e| format!("Query error: {} - {}", e, query))?;
    let rows = stmt.query_map([], |row| {
        let val: String = row.get(0)?;
        Ok(val)
    }).map_err(|e| e.to_string())?;
    
    let mut values = Vec::new();
    for v in rows.flatten() {
        values.push(v);
    }
    
    Ok(values)
}

#[tauri::command]
pub fn export_csv(
    state: tauri::State<AppState>,
    path: &str,
    global_search: Option<String>,
    filters: Option<Vec<Filter>>,
    sorts: Option<Vec<Sort>>,
    selected_row_ids: Option<Vec<i64>>,
) -> Result<String, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;

    // Fetch schema columns for global search dynamic bindings
    let mut stmt = conn
        .prepare("PRAGMA table_info('dataset')")
        .map_err(|e| e.to_string())?;

    let columns = stmt
        .query_map([], |row| {
            let name: String = row.get(1)?;
            Ok(name)
        })
        .map_err(|e| e.to_string())?;

    let mut cols = Vec::new();
    let mut select_cols = Vec::new(); // Columns to actually export (excluding our internal _row_id)
    
    for name in columns.flatten() {
        if name != "_row_id" {
            cols.push(name.clone());
            select_cols.push(format!("\"{}\"", name.replace("\"", "\"\"")));
        }
    }

    let inner_where = build_where_clause(&cols, &global_search, &filters, &selected_row_ids);

    // Build ORDER BY clause
    let order_sql = if let Some(srts) = sorts {
        if srts.is_empty() {
            "".to_string()
        } else {
            let order_parts: Vec<String> = srts.into_iter().map(|s| {
                let safe_col = format!("\"{}\"", s.column.replace("\"", "\"\""));
                let dir = if s.desc { "DESC" } else { "ASC" };
                format!("{} {}", safe_col, dir)
            }).collect();
            format!("ORDER BY {}", order_parts.join(", "))
        }
    } else {
        "".to_string()
    };

    // Sanitize output path (extremely rudimentary check for Tauri environment, but tauri dialog plugin typically hands safe absolute paths)
    let safe_path = path.replace("'", "''");

    // Execute DuckDB COPY command
    let query = format!(
        "COPY (SELECT {} FROM dataset {} {}) TO '{}' WITH (HEADER, DELIMITER ',');",
        select_cols.join(", "), inner_where, order_sql, safe_path
    );

    conn.execute(&query, []).map_err(|e| format!("Export error: {} - {}", e, query))?;

    Ok("Exported successfully".to_string())
}

#[tauri::command]
pub fn get_timeline_data(
    state: tauri::State<AppState>,
    column: &str,
    global_search: Option<String>,
    filters: Option<Vec<Filter>>,
) -> Result<Vec<TimelineData>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;

    // Fetch schema columns for global search dynamic bindings
    let mut stmt = conn
        .prepare("PRAGMA table_info('dataset')")
        .map_err(|e| e.to_string())?;

    let columns = stmt
        .query_map([], |row| {
            let name: String = row.get(1)?;
            Ok(name)
        })
        .map_err(|e| e.to_string())?;

    let mut cols = Vec::new();
    for name in columns.flatten() {
        if name != "_row_id" {
            cols.push(name);
        }
    }

    let mut inner_where = build_where_clause(&cols, &global_search, &filters, &None);
    let safe_col = format!("\"{}\"", column.replace("\"", "\"\""));

    if inner_where.is_empty() {
        inner_where = format!("WHERE {} IS NOT NULL", safe_col);
    } else {
        inner_where = format!("{} AND {} IS NOT NULL", inner_where, safe_col);
    }

    // Determine the min and max timestamp boundaries
    let bounds_query = format!("SELECT extract('epoch' FROM min(CAST({0} AS TIMESTAMP))), extract('epoch' FROM max(CAST({0} AS TIMESTAMP))) FROM dataset {1}", safe_col, inner_where);
    let mut stmt = conn.prepare(&bounds_query).map_err(|e| format!("Bounds query error: {} - {}", e, bounds_query))?;
    
    let (min_epoch, max_epoch): (Option<f64>, Option<f64>) = stmt.query_row([], |row| {
        Ok((row.get(0)?, row.get(1)?))
    }).unwrap_or((None, None));

    let min_e = min_epoch.unwrap_or(0.0);
    let max_e = max_epoch.unwrap_or(0.0);
    
    if min_e == 0.0 && max_e == 0.0 {
        return Ok(Vec::new()); // No data or invalid column
    }

    let diff = max_e - min_e;
    
    // We want roughly 60 buckets (approx visual width of graph)
    let num_buckets = 60.0;
    let mut bucket_size = diff / num_buckets;
    
    if bucket_size < 1.0 {
        bucket_size = 1.0; // minimum bucket size
    }

    // DuckDB query to group timestamps into buckets
    let query = format!(
        "SELECT CAST(to_timestamp(floor(extract('epoch' FROM CAST({} AS TIMESTAMP)) / {}) * {}) AS VARCHAR) as bucket, count(*) as count 
         FROM dataset {} 
         GROUP BY 1 
         ORDER BY 1 ASC",
        safe_col, bucket_size, bucket_size, inner_where
    );
    
    let mut stmt = conn.prepare(&query).map_err(|e| format!("Bucket query error: {} - {}", e, query))?;
    
    let rows = stmt.query_map([], |row| {
        Ok(TimelineData {
            bucket: row.get(0)?,
            count: row.get(1)?,
        })
    }).map_err(|e| e.to_string())?;

    let mut data = Vec::new();
    for val in rows.flatten() {
        data.push(val);
    }

    Ok(data)
}

// ── Starship Handshake commands ───────────────────────────────────────────────

/// Open a `starship.duckdb` file in **read-only** mode (Starship Handshake Rule 3).
///
/// Returns the list of user tables found in the database.  The caller must
/// subsequently call `select_table` to activate one of the returned tables.
#[tauri::command]
pub fn open_database(state: tauri::State<AppState>, path: &str) -> Result<Vec<String>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;

    // Detach any previously attached database before re-attaching.
    let _ = conn.execute_batch("DETACH IF EXISTS forensic_db;");

    let safe_path = path.replace('\'', "''");
    conn.execute_batch(&format!(
        "ATTACH '{safe_path}' AS forensic_db (READ_ONLY);"
    ))
    .map_err(|e| format!("Failed to open database: {e}"))?;

    // List all base tables in the attached database.
    let query = "SELECT table_name \
                 FROM information_schema.tables \
                 WHERE table_catalog = 'forensic_db' \
                   AND table_schema  = 'main' \
                   AND table_type    = 'BASE TABLE' \
                 ORDER BY table_name";
    let mut stmt = conn.prepare(query).map_err(|e| e.to_string())?;
    let tables: Vec<String> = stmt
        .query_map([], |row| row.get(0))
        .map_err(|e| e.to_string())?
        .flatten()
        .collect();

    Ok(tables)
}

/// The four columns every Starship event table must contain
/// (Starship Handshake Rule 2 – Schema Integrity).
const REQUIRED_COLUMNS: &[&str] = &["id", "timestamp", "event_type", "is_flagged"];

/// Validate schema, then copy the selected table from the read-only
/// `forensic_db` into the in-memory `dataset` table so all existing query
/// commands continue to work unchanged.
#[tauri::command]
pub fn select_table(state: tauri::State<AppState>, table_name: String) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;

    // ── 1. Validate Starship schema (Rule 2) ─────────────────────────────────
    let col_query = format!(
        "SELECT column_name \
         FROM information_schema.columns \
         WHERE table_catalog = 'forensic_db' \
           AND table_schema  = 'main' \
           AND table_name    = '{}'",
        table_name.replace('\'', "''")
    );
    let mut stmt = conn.prepare(&col_query).map_err(|e| e.to_string())?;
    let columns: Vec<String> = stmt
        .query_map([], |row| row.get(0))
        .map_err(|e| e.to_string())?
        .flatten()
        .map(|s: String| s.to_lowercase())
        .collect();

    let missing: Vec<&str> = REQUIRED_COLUMNS
        .iter()
        .filter(|&&req| !columns.contains(&req.to_lowercase()))
        .copied()
        .collect();

    if !missing.is_empty() {
        return Err(format!(
            "Table '{}' is missing required Starship schema columns: {}",
            table_name,
            missing.join(", ")
        ));
    }

    // ── 2. Copy into in-memory `dataset` with synthetic _row_id ──────────────
    let safe_table = table_name.replace('"', "\"\"");
    conn.execute_batch(&format!(
        "DROP TABLE IF EXISTS dataset;
         DROP SEQUENCE IF EXISTS row_id_seq;
         CREATE SEQUENCE row_id_seq;
         CREATE TABLE dataset AS
           SELECT nextval('row_id_seq') AS _row_id, *
           FROM forensic_db.main.\"{safe_table}\";"
    ))
    .map_err(|e| format!("Failed to load table '{table_name}': {e}"))?;

    Ok(())
}
