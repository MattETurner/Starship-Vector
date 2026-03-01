use duckdb::{Connection, Result};
fn main() -> Result<()> {
    let conn = Connection::open_in_memory()?;
    conn.execute_batch("CREATE TABLE test (time_created TIMESTAMP); INSERT INTO test VALUES ('2023-10-01T12:00:00Z'), ('2023-10-01T15:00:00Z');")?;
    let mut stmt = conn.prepare("SELECT extract('epoch' FROM min(time_created)) FROM test")?;
    let val: f64 = stmt.query_row([], |row| row.get(0))?;
    println!("Min: {}", val);
    
    let mut stmt2 = conn.prepare("SELECT CAST(to_timestamp(floor(extract('epoch' FROM time_created) / 100) * 100) AS VARCHAR) as bucket, count(*) as count FROM test GROUP BY 1")?;
    let mut rows = stmt2.query([])?;
    while let Some(row) = rows.next()? {
       let bucket: String = row.get(0)?;
       let count: i64 = row.get(1)?;
       println!("Bucket: {}, Count: {}", bucket, count);
    }
    
    Ok(())
}
