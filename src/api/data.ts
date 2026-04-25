import { invoke } from "@tauri-apps/api/core";

export interface SchemaColumn {
  name: string;
  data_type: string;
}

export type Row = Record<string, string | number | boolean | null>;

export interface TableResponse {
  rows: Row[];
  total_rows: number;
}

export interface Filter {
  column: string;
  operator: string;
  values: string[];
}

export interface Sort {
  column: string;
  desc: boolean;
}

export interface FetchParams {
  limit: number;
  offset: number;
  globalSearch: string;
  filters: Filter[];
  sorts: Sort[];
  selectedRowIds: number[] | null;
}

export interface TimelineData {
  bucket: string;
  count: number;
}

export const api = {
  loadFile: (path: string) =>
    invoke<void>("load_file", { path }),

  getSchema: () =>
    invoke<SchemaColumn[]>("get_schema"),

  fetchData: (params: FetchParams) =>
    invoke<TableResponse>("fetch_data", { ...params }),

  getDistinctValues: (column: string, globalSearch: string, filters: Filter[]) =>
    invoke<string[]>("get_distinct_values", { column, globalSearch, filters }),

  exportCsv: (
    path: string,
    globalSearch: string,
    filters: Filter[],
    sorts: Sort[],
    selectedRowIds: number[] | null,
  ) => invoke<void>("export_csv", { path, globalSearch, filters, sorts, selectedRowIds }),

  getTimelineData: (column: string, globalSearch: string, filters: Filter[]) =>
    invoke<TimelineData[]>("get_timeline_data", { column, globalSearch, filters }),

  /** Open a starship.duckdb file in read-only mode.
   *  Returns the list of event tables found inside. */
  openDatabase: (path: string) =>
    invoke<string[]>("open_database", { path }),

  /** Validate the Starship schema of a table and load it as the active dataset. */
  selectTable: (tableName: string) =>
    invoke<void>("select_table", { tableName }),
};
