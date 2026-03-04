import { useState, useEffect, useRef, useCallback } from "react";
import { open, save as tauriSave } from "@tauri-apps/plugin-dialog";
import { useVirtualizer } from "@tanstack/react-virtual";
import { FolderOpen, ArrowRight, Loader2, Search, ArrowDownAZ, ArrowUpZA, Filter as FilterIcon, X, PanelLeftClose, PanelLeftOpen, CheckSquare, Square, Download } from "lucide-react";
import TimelineHeatmap from "./components/TimelineHeatmap";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { useToast } from "./components/Toast";
import { api, type SchemaColumn, type Row, type Filter, type Sort } from "./api/data";

// Helper for highlighting text
const HighlightedText = ({ text, highlight, onDoubleClick, className }: { text: string, highlight: string, onDoubleClick?: () => void, className?: string }) => {
  if (!highlight.trim() || !text) return <span className={className || "text-xs text-zinc-400 font-mono truncate cursor-default select-text"} title={String(text)} onDoubleClick={onDoubleClick}>{String(text)}</span>;

  const str = String(text);
  // Safely escape the highlight string so regex doesn't crash on characters like `[` or `.`
  const safeHighlight = highlight.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`(${safeHighlight})`, "gi");
  const parts = str.split(regex);

  return (
    <span className={className || "text-xs text-zinc-400 font-mono truncate cursor-default select-text w-full"} title={str} onDoubleClick={onDoubleClick}>
      {parts.map((part, i) =>
        regex.test(part) ? (
          <mark key={i} className="bg-orange-500/40 text-orange-200 rounded-sm px-[1px] font-semibold">{part}</mark>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </span>
  );
};

const CHUNK_SIZE = 500;

function App() {
  const toast = useToast();

  const [loading, setLoading] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [filePath, setFilePath] = useState<string | null>(null);
  const [schema, setSchema] = useState<SchemaColumn[]>([]);
  const [totalRows, setTotalRows] = useState(0);
  const [dataCache, setDataCache] = useState<Record<number, Row>>({});
  const [fetchingBlocks, setFetchingBlocks] = useState<Set<number>>(new Set());
  const [isExporting, setIsExporting] = useState(false);

  // Search, Sort, Filter State
  const [globalSearch, setGlobalSearch] = useState("");
  const [globalSearchInput, setGlobalSearchInput] = useState("");
  const [filters, setFilters] = useState<Filter[]>([]);
  const [sorts, setSorts] = useState<Sort[]>([]);

  // Row Selection State
  const [selectedRowIds, setSelectedRowIds] = useState<Set<number>>(new Set());
  const [showSelectedOnly, setShowSelectedOnly] = useState(false);
  const lastActiveRowId = useRef<number | null>(null);

  // Layout State
  const [colWidths, setColWidths] = useState<Record<string, number>>({});
  const [hiddenCols, setHiddenCols] = useState<Set<string>>(new Set());
  const isResizing = useRef<string | null>(null);
  const startX = useRef<number>(0);
  const startWidth = useRef<number>(0);

  // Cell Modal State
  const [activeCellContent, setActiveCellContent] = useState<string | null>(null);
  // Filter Popover State
  const [activeFilterCol, setActiveFilterCol] = useState<string | null>(null);
  const [filterInputVal, setFilterInputVal] = useState("");
  const [filterDateOp, setFilterDateOp] = useState(">=");
  const [filterDateVal2, setFilterDateVal2] = useState("");
  const [distinctValues, setDistinctValues] = useState<string[]>([]);
  const [selectedDistinctValues, setSelectedDistinctValues] = useState<Set<string>>(new Set());
  const [isDistinctLoading, setIsDistinctLoading] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: totalRows,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 35,
    overscan: 20,
  });

  const loadData = async (path: string, initialLoad: boolean = false) => {
    setLoading(true);
    try {
      if (initialLoad) {
        setFilePath(path);
        await api.loadFile(path);
        const currentSchema = await api.getSchema();
        setSchema(currentSchema);
      }

      setDataCache({});
      setFetchingBlocks(new Set());

      const data = await api.fetchData({
        limit: CHUNK_SIZE,
        offset: 0,
        globalSearch,
        filters,
        sorts,
        selectedRowIds: showSelectedOnly ? Array.from(selectedRowIds) : null
      });

      setTotalRows(data.total_rows);

      const newCache: Record<number, Row> = {};
      data.rows.forEach((row, i) => {
        newCache[i] = row;
      });
      setDataCache(newCache);

      // Attempt to scroll to the last active row if it's in the first chunk
      if (lastActiveRowId.current !== null) {
        const index = data.rows.findIndex(r => r._row_id === lastActiveRowId.current);
        if (index !== -1) {
          setTimeout(() => virtualizer.scrollToIndex(index, { align: 'center' }), 100);
        }
      }
    } catch (e) {
      console.error(e);
      toast("error", `Failed to load data: ${e}`);
    } finally {
      setLoading(false);
    }
  };

  const handleOpenClick = async () => {
    try {
      const selected = await open({
        multiple: false,
        filters: [
          { name: "Data", extensions: ["csv", "json", "parquet"] },
          { name: "Logs", extensions: ["log", "syslog", "access", "error"] },
          { name: "All", extensions: ["*"] },
        ],
      });

      if (!selected) return;
      const path = typeof selected === "string" ? selected : null;
      if (!path) return;

      // Reset states
      setGlobalSearch("");
      setGlobalSearchInput("");
      setFilters([]);
      setSorts([]);
      setColWidths({});
      setHiddenCols(new Set());
      setSelectedRowIds(new Set());
      setShowSelectedOnly(false);
      lastActiveRowId.current = null;
      await loadData(path, true);
      // Automatically collapse sidebar to maximize view area
      setIsSidebarOpen(false);
    } catch (e) { console.error(e) }
  };

  const handleExportClick = async () => {
    if (!filePath) return;
    try {
      const savePath = await tauriSave({
        filters: [{ name: "CSV", extensions: ["csv"] }],
        defaultPath: "export.csv"
      });

      if (!savePath) return;

      setIsExporting(true);
      await api.exportCsv(
        savePath,
        globalSearch,
        filters,
        sorts,
        showSelectedOnly ? Array.from(selectedRowIds) : null
      );
      toast("success", `Exported to ${savePath.split('/').pop() ?? savePath}`);
    } catch (e) {
      console.error(e);
      toast("error", `Failed to export: ${e}`);
    } finally {
      setIsExporting(false);
    }
  };

  // Mouse up event for drag resizing
  useEffect(() => {
    const handleMouseUp = () => {
      isResizing.current = null;
      document.body.style.cursor = '';
    };

    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing.current) return;
      const col = isResizing.current;
      const delta = e.clientX - startX.current;
      const newWidth = Math.max(100, startWidth.current + delta);
      setColWidths(prev => ({ ...prev, [col]: newWidth }));
    };

    window.addEventListener('mouseup', handleMouseUp);
    window.addEventListener('mousemove', handleMouseMove);
    return () => {
      window.removeEventListener('mouseup', handleMouseUp);
      window.removeEventListener('mousemove', handleMouseMove);
    };
  }, []);

  const fetchChunk = useCallback(async (startIndex: number) => {
    const blockIndex = Math.floor(startIndex / CHUNK_SIZE);

    if (fetchingBlocks.has(blockIndex)) return;

    setFetchingBlocks(prev => new Set(prev).add(blockIndex));

    try {
      const offset = blockIndex * CHUNK_SIZE;
      const data = await api.fetchData({
        limit: CHUNK_SIZE,
        offset,
        globalSearch,
        filters,
        sorts,
        selectedRowIds: showSelectedOnly ? Array.from(selectedRowIds) : null
      });

      setDataCache(prev => {
        const newCache = { ...prev };
        data.rows.forEach((row, i) => {
          newCache[offset + i] = row;
        });
        return newCache;
      });
    } catch (e) {
      console.error("Failed to fetch block", blockIndex, e);
    }
  }, [fetchingBlocks, globalSearch, filters, sorts, showSelectedOnly, selectedRowIds]);

  useEffect(() => {
    const virtualItems = virtualizer.getVirtualItems();
    if (!virtualItems.length) return;

    for (const item of virtualItems) {
      if (!dataCache[item.index]) {
        fetchChunk(item.index);
      }
    }
  }, [virtualizer.getVirtualItems(), dataCache, fetchChunk]);

  // Effect to reload when query states change
  useEffect(() => {
    if (filePath) {
      loadData(filePath, false);
    }
  }, [globalSearch, filters, sorts, showSelectedOnly]);

  const toggleSort = (colName: string) => {
    setSorts(prev => {
      const existing = prev.find(s => s.column === colName);
      if (!existing) return [{ column: colName, desc: false }];
      if (!existing.desc) return [{ column: colName, desc: true }];
      return []; // Reset
    });
  };

  const openFilter = async (colName: string) => {
    if (activeFilterCol === colName) {
      setActiveFilterCol(null);
      return;
    }
    setActiveFilterCol(colName);
    setFilterInputVal("");
    setFilterDateOp(">=");
    setFilterDateVal2("");
    setDistinctValues([]);
    setSelectedDistinctValues(new Set());
    setIsDistinctLoading(true);
    try {
      const vals = await api.getDistinctValues(colName, globalSearch, filters);
      setDistinctValues(vals);
    } catch (e) { console.error(e) } finally { setIsDistinctLoading(false) }
  };

  const addFilter = (colName: string, op: string, vals: string[]) => {
    if (!vals || vals.length === 0) return;
    setFilters(prev => [...prev.filter(f => f.column !== colName), { column: colName, operator: op, values: vals }]);
    setActiveFilterCol(null);
    setFilterInputVal("");
  };

  const removeFilter = (colName: string) => {
    setFilters(prev => prev.filter(f => f.column !== colName));
  };

  return (
    <div className="flex h-screen bg-zinc-950 text-zinc-100 font-sans overflow-hidden">
      {/* Sidebar - NASA Theme (Blue borders/accents) */}
      <div className={`border-r border-zinc-800 bg-zinc-900/50 flex flex-col shadow-xl z-20 transition-all duration-300 relative flex-shrink-0 ${isSidebarOpen ? 'w-64 p-4' : 'w-16 p-2 items-center'}`}>
        <div className={`flex items-center space-x-3 mb-8 ${!isSidebarOpen && 'justify-center'}`}>
          <div className="w-10 h-10 flex items-center justify-center shrink-0 rounded-xl overflow-hidden shadow-lg shadow-orange-500/20 border border-zinc-800">
            <img src="/logo_square.png" alt="Starship Vector Logo" className="w-full h-full object-cover" />
          </div>
          {isSidebarOpen && (
            <div>
              <h1 className="font-bold text-lg tracking-tight bg-clip-text text-transparent bg-gradient-to-br from-white to-zinc-400">Vector</h1>
              <p className="text-[10px] text-zinc-500 font-medium tracking-wide border border-zinc-700/50 rounded-full px-2 inline-block mt-0.5 uppercase">Dataset Explorer</p>
            </div>
          )}
        </div>

        <div className="space-y-2">
          <button
            onClick={handleOpenClick}
            disabled={loading || isExporting}
            title={!isSidebarOpen ? "Open Dataset" : undefined}
            className={`w-full flex items-center justify-center space-x-2 bg-zinc-100 hover:bg-white text-zinc-900 transition-all duration-200 rounded-lg text-sm font-semibold shadow-sm focus:outline-none focus:ring-2 focus:ring-orange-500/50 disabled:opacity-50 disabled:cursor-not-allowed ${isSidebarOpen ? 'px-4 py-2.5' : 'p-2.5 aspect-square'}`}
          >
            {loading ? <Loader2 size={16} className="animate-spin text-orange-600" /> : <FolderOpen size={16} className="text-blue-600" />}
            {isSidebarOpen && <span>{loading ? "Loading..." : "Open Dataset"}</span>}
          </button>

          <button
            onClick={handleExportClick}
            disabled={loading || isExporting || !filePath}
            title={!isSidebarOpen ? "Export CSV" : undefined}
            className={`w-full flex items-center justify-center space-x-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition-all duration-200 rounded-lg text-sm font-semibold border border-zinc-700/50 shadow-sm focus:outline-none focus:ring-2 focus:ring-orange-500/50 disabled:opacity-50 disabled:cursor-not-allowed ${isSidebarOpen ? 'px-4 py-2.5' : 'p-2.5 aspect-square'}`}
          >
            {isExporting ? <Loader2 size={16} className="animate-spin text-orange-500" /> : <Download size={16} className={filePath ? "text-orange-500" : "text-zinc-600"} />}
            {isSidebarOpen && <span>{isExporting ? "Exporting..." : "Export CSV"}</span>}
          </button>
        </div>

        {isSidebarOpen && (
          <div className="mt-8 space-y-4">
            <div className="bg-zinc-800/50 rounded-xl p-4 border border-zinc-700/50">
              <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-3">Status</h3>
              <div className="flex flex-col space-y-3">
                <div className="flex justify-between items-center text-sm">
                  <span className="text-zinc-500">File</span>
                  <span className="text-zinc-300 font-mono truncate max-w-[120px]" title={filePath || "None"}>
                    {filePath ? filePath.split('/').pop() : "None"}
                  </span>
                </div>
                <div className="flex justify-between items-center text-sm">
                  <span className="text-zinc-500">Rows</span>
                  <span className="text-zinc-300 font-mono">{totalRows.toLocaleString()}</span>
                </div>
                <div className="flex justify-between items-center text-sm">
                  <span className="text-zinc-500">Columns</span>
                  <span className="text-zinc-300 font-mono">{schema.length}</span>
                </div>
              </div>
            </div>
          </div>
        )}

        {isSidebarOpen && (
          <div className="mt-auto pb-2 text-center flex flex-col items-center">
            <div className="text-xs text-zinc-600 font-semibold tracking-widest uppercase">Starship Space Command</div>
            <div className="w-12 h-1 bg-gradient-to-r from-blue-600 to-orange-500 rounded-full mt-2" />
          </div>
        )}
      </div>

      {/* Main Content */}
      <div className="flex-1 flex flex-col overflow-hidden relative bg-zinc-950/50">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,_var(--tw-gradient-stops))] from-blue-900/10 via-zinc-950/0 to-orange-900/5 pointer-events-none" />

        <div className="px-6 py-4 border-b border-zinc-800/80 bg-zinc-900/40 backdrop-blur-md sticky top-0 z-30 flex justify-between items-center w-full">
          <div className="flex flex-col">
            <div className="flex items-center space-x-3">
              <button
                onClick={() => setIsSidebarOpen(!isSidebarOpen)}
                className="text-zinc-500 hover:text-white transition-colors p-1 -ml-2 rounded-md hover:bg-zinc-800"
              >
                {isSidebarOpen ? <PanelLeftClose size={18} /> : <PanelLeftOpen size={18} />}
              </button>
              <h2 className="text-lg font-medium text-zinc-200 tracking-tight flex items-center space-x-2">
                <span>Data View</span>
                {schema.length > 0 && <span className="text-xs px-2 py-0.5 rounded bg-blue-500/10 text-blue-400 font-mono border border-blue-500/20">{totalRows.toLocaleString()} rows selected</span>}
              </h2>
            </div>

            {/* Filter Badges & Show Selected Toggle */}
            <div className="flex items-center gap-4 mt-2">
              <div
                className={`flex items-center space-x-1.5 text-xs font-medium px-2 py-1 rounded cursor-pointer border transition-colors ${showSelectedOnly ? 'bg-orange-500/20 text-orange-400 border-orange-500/30' : 'bg-zinc-800/50 text-zinc-400 border-zinc-700/50 hover:bg-zinc-800'}`}
                onClick={() => setShowSelectedOnly(!showSelectedOnly)}
              >
                {showSelectedOnly ? <CheckSquare size={14} /> : <Square size={14} />}
                <span>Selected Only</span>
                <span className="bg-zinc-950/50 px-1.5 rounded-sm text-[10px] ml-1">{selectedRowIds.size}</span>
              </div>

              {filters.length > 0 && (
                <div className="flex gap-2">
                  {filters.map(f => (
                    <div key={f.column} className="flex items-center space-x-1 text-[11px] font-mono bg-blue-500/10 text-blue-400 border border-blue-500/20 rounded px-2 py-0.5">
                      <span>{f.column} {f.operator} {f.values.join(', ')}</span>
                      <button onClick={() => removeFilter(f.column)} className="hover:text-white rounded-full p-0.5 hover:bg-blue-500/20"><X size={10} /></button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="flex items-center space-x-3">
            {/* Column Toggler */}
            <div className="relative group">
              <button className="flex items-center space-x-1 text-xs bg-zinc-800 hover:bg-zinc-700 text-zinc-300 px-3 py-1.5 rounded border border-zinc-700/50 transition-colors cursor-pointer">
                <span>Columns</span>
                <span className="bg-zinc-900 px-1.5 py-0.5 rounded text-[10px]">{schema.length - hiddenCols.size} / {schema.length}</span>
              </button>

              <div className="absolute right-0 top-full mt-2 w-48 bg-zinc-800 border border-zinc-700 rounded shadow-2xl p-2 z-50 flex flex-col max-h-64 opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all">
                <div className="text-[10px] text-zinc-500 uppercase tracking-wider mb-2 px-1">Toggle Visibility</div>
                <div className="flex-1 overflow-y-auto custom-scrollbar space-y-1">
                  {schema.map((col, idx) => (
                    <label key={idx} className="flex items-center space-x-2 text-xs text-zinc-300 hover:bg-zinc-700/50 px-2 py-1.5 rounded cursor-pointer transition-colors">
                      <input
                        type="checkbox"
                        checked={!hiddenCols.has(col.name)}
                        onChange={() => {
                          setHiddenCols(prev => {
                            const next = new Set(prev);
                            if (next.has(col.name)) next.delete(col.name);
                            else next.add(col.name);
                            return next;
                          });
                        }}
                        className="rounded border-zinc-600 text-orange-500 focus:ring-orange-500 bg-zinc-900 border"
                      />
                      <span className="truncate" title={col.name}>{col.name}</span>
                    </label>
                  ))}
                </div>
              </div>
            </div>

            <div className="relative w-64">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
              <input
                type="text"
                placeholder="Global search (press Enter)..."
                value={globalSearchInput}
                onChange={(e) => setGlobalSearchInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') setGlobalSearch(globalSearchInput);
                }}
                className="w-full bg-zinc-950/50 border border-zinc-800 text-sm text-zinc-200 rounded-full pl-9 pr-4 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500/50 placeholder-zinc-600 transition-all"
              />
            </div>
          </div>
        </div>

        {schema.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center text-zinc-600 space-y-4 z-10 w-full">
            <div className="w-16 h-16 rounded-3xl bg-zinc-900 border border-zinc-800 flex items-center justify-center shadow-inner">
              <ArrowRight size={24} className="text-zinc-700" />
            </div>
            <p className="text-sm">Open a CSV or Parquet file from the sidebar to begin.</p>
          </div>
        ) : (
          <div className="flex flex-col flex-1 overflow-hidden z-10 w-full">
            {(() => {
              const timeCol = schema.find(c => c.data_type.toLowerCase().includes('timestamp'));
              return timeCol ? (
                <ErrorBoundary label="Timeline">
                  <TimelineHeatmap
                    timeColumn={timeCol.name}
                    globalSearch={globalSearch}
                    filters={filters}
                    onRangeSelect={(start, end) => addFilter(timeCol.name, 'between', [start, end])}
                  />
                </ErrorBoundary>
              ) : null;
            })()}

            <ErrorBoundary label="Data table">
              <div className="flex-1 overflow-auto custom-scrollbar relative w-full" ref={scrollRef}>
                <div
                  style={{
                    height: `${virtualizer.getTotalSize()}px`,
                    width: `${Math.max(100, schema.filter(col => !hiddenCols.has(col.name)).reduce((acc, col) => acc + (colWidths[col.name] || 192), 0) + 64)}px`,
                    position: 'relative',
                  }}
                  className="min-w-full"
                >
                  <div className="absolute inset-0 pb-10">
                    {/* Table Header */}
                    <div className="sticky top-0 z-20 flex bg-zinc-900/95 backdrop-blur-md border-b border-zinc-800 shadow-sm" style={{ width: 'fit-content' }}>
                      {/* Column Index Space */}
                      <div className="sticky left-0 z-30 w-16 flex-shrink-0 px-3 py-2 text-xs font-semibold text-zinc-500 uppercase tracking-wider border-r border-zinc-800/50 bg-zinc-900/95 backdrop-blur-md shadow-[4px_0_12px_rgba(0,0,0,0.5)]">
                        #
                      </div>
                      {schema.filter(col => !hiddenCols.has(col.name)).map((col, i) => {
                        const sort = sorts.find(s => s.column === col.name);
                        const isTime = col.data_type.toLowerCase().includes('timestamp') || col.name.toLowerCase().includes('time') || col.name.toLowerCase().includes('date');

                        return (
                          <div
                            key={i}
                            style={{ width: `${colWidths[col.name] || 192}px` }}
                            className="flex-shrink-0 px-4 py-2 border-r last:border-r-0 border-zinc-800/50 flex flex-col group relative"
                          >
                            <div className="flex items-center justify-between">
                              <span
                                className="text-xs font-semibold text-zinc-300 truncate cursor-pointer hover:text-white"
                                title={col.name}
                                onClick={() => toggleSort(col.name)}
                              >
                                {col.name}
                              </span>
                              <div className="flex items-center space-x-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                {sort ? (
                                  sort.desc ? <ArrowUpZA size={12} className="text-blue-400" /> : <ArrowDownAZ size={12} className="text-blue-400" />
                                ) : null}
                                <button onClick={() => openFilter(col.name)} className="text-zinc-500 hover:text-orange-400">
                                  <FilterIcon size={12} className={filters.find(f => f.column === col.name) ? "text-orange-500" : ""} />
                                </button>
                              </div>
                            </div>
                            <span className="text-[10px] text-zinc-600 uppercase mt-0.5 tracking-wider font-mono">{col.data_type}</span>

                            {/* Filter Popover */}
                            {activeFilterCol === col.name && (
                              <div className="absolute top-12 left-0 w-64 bg-zinc-800 border border-zinc-700 rounded shadow-xl p-3 z-50 flex flex-col max-h-80 cursor-default" onClick={e => e.stopPropagation()}>

                                {isTime ? (
                                  <div className="flex flex-col space-y-2 mb-3">
                                    <label className="text-[10px] text-zinc-500 uppercase tracking-wider">Date Operator</label>
                                    <select
                                      className="bg-zinc-900 border border-zinc-700 text-xs text-white px-2 py-1.5 rounded focus:outline-none focus:border-orange-500"
                                      value={filterDateOp}
                                      onChange={(e) => {
                                        setFilterDateOp(e.target.value);
                                        if (e.target.value !== 'starts_with' && filterInputVal.length > 0 && !filterInputVal.includes('T')) {
                                          setFilterInputVal('');
                                        }
                                      }}
                                    >
                                      <option value=">=">Since (&gt;=)</option>
                                      <option value="<=">Before (&lt;=)</option>
                                      <option value="starts_with">Exact/Partial Match</option>
                                      <option value="between">Between (Range)</option>
                                    </select>

                                    <label className="text-[10px] text-zinc-500 uppercase tracking-wider">Date/Time {filterDateOp === 'between' && 'Start'}</label>
                                    <input
                                      type={filterDateOp === 'starts_with' ? "text" : "datetime-local"}
                                      placeholder={filterDateOp === 'starts_with' ? "e.g. 2018 or 2018-05-13" : ""}
                                      value={filterInputVal}
                                      onChange={(e) => setFilterInputVal(e.target.value)}
                                      className="w-full bg-zinc-900 border border-zinc-700 text-xs px-2 py-1.5 rounded focus:outline-none focus:border-orange-500 shrink-0 text-white"
                                    />

                                    {filterDateOp === 'between' && (
                                      <>
                                        <label className="text-[10px] text-zinc-500 uppercase tracking-wider mt-1">Date/Time End</label>
                                        <input
                                          type="datetime-local"
                                          value={filterDateVal2}
                                          onChange={(e) => setFilterDateVal2(e.target.value)}
                                          className="w-full bg-zinc-900 border border-zinc-700 text-xs px-2 py-1.5 rounded focus:outline-none focus:border-orange-500 shrink-0 text-white"
                                        />
                                      </>
                                    )}

                                    {filterDateOp === 'starts_with' && (
                                      <span className="text-[9px] text-zinc-500 font-mono mt-1">Hint: Use ISO 8601 (YYYY, YYYY-MM, YYYY-MM-DD)</span>
                                    )}
                                  </div>
                                ) : (
                                  <>
                                    <input
                                      type="text"
                                      placeholder="Search distinct values..."
                                      value={filterInputVal}
                                      onChange={(e) => setFilterInputVal(e.target.value)}
                                      onKeyDown={(e) => {
                                        if (e.key === 'Enter') addFilter(col.name, "ilike", [filterInputVal]);
                                      }}
                                      className="w-full bg-zinc-900 border border-zinc-700 text-xs px-2 py-1.5 rounded focus:outline-none focus:border-orange-500 mb-2 shrink-0 text-white"
                                    />

                                    <div className="flex-1 overflow-y-auto custom-scrollbar border border-zinc-700/50 rounded bg-zinc-900/50 mb-3 h-40">
                                      {isDistinctLoading ? (
                                        <div className="p-2 text-xs text-zinc-500 flex items-center justify-center">
                                          <Loader2 size={12} className="animate-spin mr-2" /> Loading...
                                        </div>
                                      ) : (
                                        <div className="p-1 space-y-0.5">
                                          {distinctValues
                                            .filter(v => v.toLowerCase().includes(filterInputVal.toLowerCase()))
                                            .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
                                            .map((val, idx) => {
                                              const isSelected = selectedDistinctValues.has(val);
                                              return (
                                                <div
                                                  key={idx}
                                                  className="flex items-center space-x-2 text-xs text-zinc-300 hover:bg-zinc-800 px-2 py-1 rounded cursor-pointer"
                                                  onClick={(e) => {
                                                    e.stopPropagation();
                                                    setSelectedDistinctValues(prev => {
                                                      const next = new Set(prev);
                                                      if (next.has(val)) next.delete(val);
                                                      else next.add(val);
                                                      return next;
                                                    });
                                                  }}
                                                >
                                                  <input type="checkbox" checked={isSelected} readOnly className="rounded border-zinc-700 text-orange-500 focus:ring-orange-500 bg-zinc-900" />
                                                  <span className="truncate" title={val}>{val || <span className="text-zinc-600 italic">null</span>}</span>
                                                </div>
                                              )
                                            })}
                                          {distinctValues.length === 0 && <div className="p-2 text-xs text-zinc-500">No values found.</div>}
                                        </div>
                                      )}
                                    </div>
                                  </>
                                )}

                                <div className="flex justify-between shrink-0 align-end border-t border-zinc-700/50 pt-3">
                                  <button onClick={(e) => { e.stopPropagation(); setActiveFilterCol(null); }} className="text-xs text-zinc-400 hover:text-white px-2 py-0.5">Cancel</button>
                                  <button onClick={(e) => {
                                    e.stopPropagation();
                                    if (isTime) {
                                      const vals = [filterInputVal];
                                      if (filterDateOp === 'between') vals.push(filterDateVal2);
                                      addFilter(col.name, filterDateOp, vals);
                                    } else {
                                      if (selectedDistinctValues.size > 0) {
                                        addFilter(col.name, "in", Array.from(selectedDistinctValues));
                                      } else if (filterInputVal) {
                                        addFilter(col.name, "ilike", [filterInputVal]);
                                      }
                                    }
                                  }} className="text-xs bg-orange-500 hover:bg-orange-600 text-white px-3 py-1 rounded">Apply</button>
                                </div>
                              </div>
                            )}

                            {/* Drag Resizer Handle */}
                            <div
                              className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-orange-500/50 transition-colors z-30"
                              onMouseDown={(e) => {
                                e.preventDefault();
                                isResizing.current = col.name;
                                startX.current = e.clientX;
                                startWidth.current = colWidths[col.name] || 192;
                                document.body.style.cursor = 'col-resize';
                              }}
                            />
                          </div>
                        )
                      })}
                    </div>

                    {/* Table Body - Virtualized */}
                    {virtualizer.getVirtualItems().map((virtualRow) => {
                      const rowData = dataCache[virtualRow.index];
                      const isLoading = !rowData;

                      return (
                        <div
                          key={virtualRow.index}
                          style={{
                            position: 'absolute',
                            top: 0,
                            left: 0,
                            width: 'fit-content',
                            transform: `translateY(${virtualRow.start + 51}px)`,
                            height: `${virtualRow.size}px`,
                          }}
                          className={`flex border-b border-zinc-800/50 transition-colors ${virtualRow.index % 2 === 0 ? 'bg-zinc-950/20' : 'bg-transparent'} hover:bg-zinc-800/30 group`}
                        >
                          <div className="sticky left-0 z-20 w-16 flex-shrink-0 px-2 py-2 text-[10px] text-zinc-600 font-mono border-r border-zinc-800/50 bg-zinc-950/80 backdrop-blur-md group-hover:bg-zinc-900 flex items-center justify-between transition-colors shadow-[4px_0_12px_rgba(0,0,0,0.5)]">
                            <span>{virtualRow.index + 1}</span>
                            {!isLoading && (
                              <div
                                className="cursor-pointer text-zinc-500 hover:text-orange-400 mt-0.5"
                                onClick={() => {
                                  const id = rowData._row_id as number;
                                  setSelectedRowIds(prev => {
                                    const next = new Set(prev);
                                    if (next.has(id)) next.delete(id);
                                    else next.add(id);
                                    return next;
                                  });
                                }}
                              >
                                {selectedRowIds.has(rowData._row_id as number) ? <CheckSquare size={14} className="text-orange-500" /> : <Square size={14} />}
                              </div>
                            )}
                          </div>

                          {schema.filter(col => !hiddenCols.has(col.name)).map((col, i) => {
                            const isSorted = sorts.find(s => s.column === col.name);
                            return (
                              <div
                                key={i}
                                style={{ width: `${colWidths[col.name] || 192}px` }}
                                className={`flex-shrink-0 px-4 py-2 border-r last:border-r-0 border-zinc-800/50 flex items-center overflow-hidden ${isSorted ? 'bg-blue-900/5 group-hover:bg-transparent' : ''}`}
                              >
                                {isLoading ? (
                                  <div className="h-3 w-1/2 bg-zinc-800/50 animate-pulse rounded-sm" />
                                ) : (
                                  <HighlightedText
                                    text={String(rowData[col.name])}
                                    highlight={globalSearch}
                                    onDoubleClick={() => {
                                      lastActiveRowId.current = rowData._row_id as number;
                                      setActiveCellContent(String(rowData[col.name]));
                                    }}
                                    className="text-xs text-zinc-400 font-mono truncate cursor-pointer select-text w-full"
                                  />
                                )}
                              </div>
                            )
                          })}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </ErrorBoundary>
          </div>
        )}
      </div>

      {/* Active Cell Details Modal */}
      {activeCellContent !== null && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4 cursor-default" onClick={() => setActiveCellContent(null)}>
          <div className="bg-zinc-900 border border-zinc-700/50 rounded-xl shadow-2xl overflow-hidden w-full max-w-2xl flex flex-col max-h-[80vh]" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800/50 bg-zinc-900/50">
              <h3 className="font-semibold text-zinc-200">Cell Details</h3>
              <button
                onClick={() => setActiveCellContent(null)}
                className="text-zinc-500 hover:text-white p-1 rounded-md hover:bg-zinc-800 transition-colors"
              >
                <X size={16} />
              </button>
            </div>
            <div className="p-4 overflow-y-auto custom-scrollbar flex-1">
              <pre className="text-xs text-zinc-300 font-mono whitespace-pre-wrap break-words format-pre">
                {activeCellContent}
              </pre>
            </div>
            <div className="px-4 py-3 border-t border-zinc-800/50 bg-zinc-900/50 flex justify-end">
              <button
                onClick={() => {
                  navigator.clipboard.writeText(activeCellContent);
                  setActiveCellContent(null);
                }}
                className="bg-orange-500 hover:bg-orange-600 text-white px-4 py-1.5 rounded-md text-xs font-medium transition-colors"
              >
                Copy & Close
              </button>
            </div>
          </div>
        </div>
      )}

      <style>{`
        .custom-scrollbar::-webkit-scrollbar {
          width: 8px;
          height: 8px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: rgba(24, 24, 27, 0.5);
          border-left: 1px solid rgba(39, 39, 42, 0.5);
          border-top: 1px solid rgba(39, 39, 42, 0.5);
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: rgba(82, 82, 91, 0.5);
          border-radius: 4px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background: rgba(113, 113, 122, 0.8);
        }
        .custom-scrollbar::-webkit-scrollbar-corner {
          background: transparent;
        }
        input[type="datetime-local"]::-webkit-calendar-picker-indicator {
            filter: invert(1);
            opacity: 0.5;
            cursor: pointer;
        }
        input[type="datetime-local"]::-webkit-calendar-picker-indicator:hover {
            opacity: 1;
        }
      `}</style>
    </div>
  );
}

export default App;
