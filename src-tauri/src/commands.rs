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

#[tauri::command]
pub fn load_file(state: tauri::State<AppState>, path: &str) -> Result<String, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;

    // Drop existing sequence and table if any
    conn.execute_batch("DROP TABLE IF EXISTS dataset;")
        .map_err(|e| e.to_string())?;
    conn.execute_batch("DROP SEQUENCE IF EXISTS row_id_seq;")
        .map_err(|e| e.to_string())?;

    // Create new table datasets from file. We'll use read_csv_auto or read_parquet automatically based on extension,
    // but DuckDB's simple SELECT * FROM 'path' figures it out.
    conn.execute_batch(
        &format!("
            CREATE SEQUENCE row_id_seq;
            CREATE TABLE dataset AS SELECT nextval('row_id_seq') as _row_id, * FROM '{}';
        ", path)
    ).map_err(|e| e.to_string())?;

    Ok("File loaded successfully".to_string())
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
    for col in columns {
        if let Ok(c) = col {
            if c.name != "_row_id" {
                schema.push(c);
            }
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
    for c in columns {
        if let Ok(name) = c {
            if name != "_row_id" {
                cols.push(name);
            }
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
    for row in rows {
        if let Ok(json_str) = row {
            if let Ok(val) = serde_json::from_str(&json_str) {
                data.push(val);
            }
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
    for c in columns {
        if let Ok(name) = c {
            if name != "_row_id" {
                cols.push(name);
            }
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
    for row in rows {
        if let Ok(v) = row {
            values.push(v);
        }
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
    
    for c in columns {
        if let Ok(name) = c {
            if name != "_row_id" {
                cols.push(name.clone());
                select_cols.push(format!("\"{}\"", name.replace("\"", "\"\"")));
            }
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
