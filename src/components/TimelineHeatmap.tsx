import React, { useEffect, useState, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';

export interface Filter {
    column: string;
    operator: string;
    values: string[];
}

interface TimelineData {
    bucket: string;
    count: number;
}

interface TimelineHeatmapProps {
    timeColumn: string;
    globalSearch: string;
    filters: Filter[];
    onRangeSelect: (start: string, end: string) => void;
}

const TimelineHeatmap: React.FC<TimelineHeatmapProps> = ({ timeColumn, globalSearch, filters, onRangeSelect }) => {
    const [data, setData] = useState<TimelineData[]>([]);
    const [loading, setLoading] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);

    // Drag Selection State
    const [isDragging, setIsDragging] = useState(false);
    const [startX, setStartX] = useState<number | null>(null);
    const [currentX, setCurrentX] = useState<number | null>(null);
    const [hoverX, setHoverX] = useState<number | null>(null);

    // Clear selection when filters change (e.g. user removed the filter manually)
    useEffect(() => {
        if (!filters.some(f => f.column === timeColumn && f.operator === 'between')) {
            setStartX(null);
            setCurrentX(null);
        }
    }, [filters, timeColumn]);

    useEffect(() => {
        if (!timeColumn) return;

        let active = true;
        setLoading(true);

        invoke<TimelineData[]>('get_timeline_data', {
            column: timeColumn,
            globalSearch,
            filters // Zoom timeline context proportionally to active filters
        }).then(res => {
            if (active) {
                setData(res);
            }
        }).catch(e => {
            console.error("Failed to fetch timeline:", e);
        }).finally(() => {
            if (active) setLoading(false);
        });

        return () => { active = false; };
    }, [timeColumn, globalSearch, filters]);

    if (loading || data.length === 0) {
        return (
            <div className="w-full h-24 bg-zinc-900/50 border-b border-zinc-800 flex items-center justify-center pointer-events-none relative shrink-0 z-20">
                <div className="flex flex-col items-center">
                    {loading ? (
                        <>
                            <div className="w-32 h-1 bg-zinc-800 rounded overflow-hidden">
                                <div className="w-1/2 h-full bg-orange-500/50 animate-[slide_1s_infinite_ease-in-out]"></div>
                            </div>
                            <span className="text-[10px] text-zinc-500 font-mono mt-2 tracking-widest uppercase animate-pulse">Scanning Timeline</span>
                        </>
                    ) : (
                        <span className="text-[10px] text-zinc-600 font-mono tracking-widest uppercase">No Activity Detected</span>
                    )}
                </div>
            </div>
        );
    }

    const maxCount = Math.max(...data.map(d => d.count), 1);

    const getRelativeX = (clientX: number) => {
        if (!containerRef.current) return 0;
        const rect = containerRef.current.getBoundingClientRect();
        // The bars container actually has a 24px left padding (px-6) where the bars start.
        // We want '0' to be the start of the bars, and 'width - 48' to be the end.
        let x = clientX - rect.left - 24;
        const maxW = rect.width - 48;
        return Math.max(0, Math.min(x, maxW));
    };

    const handleMouseDown = (e: React.MouseEvent) => {
        const x = getRelativeX(e.clientX);
        setStartX(x);
        setCurrentX(x);
        setIsDragging(true);
    };

    const handleMouseMove = (e: React.MouseEvent) => {
        const x = getRelativeX(e.clientX);
        setHoverX(x);
        if (!isDragging) return;
        setCurrentX(x);
    };

    const handleMouseLeave = () => {
        setHoverX(null);
        handleMouseUp();
    };

    const handleMouseUp = () => {
        if (!isDragging || !containerRef.current || startX === null || currentX === null) {
            setIsDragging(false);
            setStartX(null);
            setCurrentX(null);
            return;
        }

        if (!containerRef.current) return;
        const rect = containerRef.current.getBoundingClientRect();
        const width = rect.width - 48; // Drawable area width

        let x1 = startX;
        let x2 = currentX;

        if (x1 > x2) {
            [x1, x2] = [x2, x1];
        }

        // Only trigger if dragged a meaningful amount
        if (x2 - x1 > 5) {
            const startRatio = x1 / width;
            const endRatio = x2 / width;

            const startIndex = Math.floor(startRatio * data.length);
            const endIndex = Math.min(Math.floor(endRatio * data.length), data.length - 1);

            if (data[startIndex] && data[endIndex]) {
                // Find next bucket for upper bound to be inclusive of the drawn region
                const nextIdx = Math.min(endIndex + 1, data.length - 1);
                onRangeSelect(data[startIndex].bucket, data[nextIdx].bucket);
            }
        } else {
            // Clicked without dragging, clear focus
            setStartX(null);
            setCurrentX(null);
        }

        setIsDragging(false);
    };

    return (
        <div className="w-full bg-zinc-900 border-b border-zinc-800 flex flex-col pointer-events-auto relative shrink-0 z-20 shadow-xl shadow-black/20">
            <div
                className="h-24 w-full relative group bg-zinc-900 overflow-hidden px-6 box-border cursor-crosshair pt-6 pb-2"
                ref={containerRef}
                onMouseDown={handleMouseDown}
                onMouseMove={handleMouseMove}
                onMouseUp={handleMouseUp}
                onMouseLeave={handleMouseLeave}
                onDragStart={e => e.preventDefault()}
            >
                {/* Top Fade Frame */}
                <div className="absolute top-0 left-0 right-0 h-8 bg-gradient-to-b from-zinc-950/40 to-transparent pointer-events-none z-0" />

                {/* Bars */}
                <div className="absolute top-4 bottom-2 left-6 right-6 flex items-end pointer-events-none gap-[1px]">
                    {data.map((d, i) => {
                        const heightPct = (d.count / maxCount) * 100;
                        // Very subtle intensity mapping
                        const intensity = 0.3 + (heightPct / 100) * 0.7;

                        return (
                            <div
                                key={i}
                                className="flex-1 bg-blue-500 hover:bg-orange-400 transition-colors transform origin-bottom hover:scale-y-[1.1]"
                                style={{
                                    height: `${Math.max(5, heightPct)}%`,
                                    opacity: intensity
                                }}
                                title={`${d.bucket} - ${d.count} events`}
                            />
                        );
                    })}
                </div>

                {/* Selection overlay */}
                {startX !== null && currentX !== null && (
                    <div
                        className="absolute top-4 bottom-2 bg-orange-500/20 border-x border-orange-500 pointer-events-none z-10"
                        style={{
                            left: `${Math.min(startX, currentX) + 24}px`, // +24 for the px-6 padding offset
                            width: `${Math.abs(currentX - startX)}px`
                        }}
                    />
                )}

                {/* Hover Tooltip */}
                {hoverX !== null && data.length > 0 && containerRef.current && (
                    <div
                        className="absolute top-0 px-2 py-0.5 bg-zinc-800 border border-zinc-700 text-zinc-300 text-[9px] font-mono rounded shadow-lg pointer-events-none z-30 whitespace-nowrap transform -translate-x-1/2"
                        style={{ left: `${hoverX + 24}px` }}
                    >
                        {data[Math.min(Math.floor((hoverX / (containerRef.current.getBoundingClientRect().width - 48)) * data.length), data.length - 1)]?.bucket}
                    </div>
                )}
            </div>

            {/* Time axis labels */}
            <div className="px-6 py-1 bg-zinc-900 flex justify-between text-[9px] text-zinc-500 font-mono">
                <span>{data[0]?.bucket.split(' ')[0]}</span>
                <span>{data[data.length - 1]?.bucket.split(' ')[0]}</span>
            </div>

            <div className="px-6 py-1.5 border-t border-zinc-800/80 bg-zinc-950/50 flex justify-between items-center">
                <span className="text-[10px] text-zinc-400 uppercase tracking-widest font-semibold flex items-center space-x-2">
                    <span className="w-2 h-2 rounded-full bg-blue-500 shadow-[0_0_8px_rgba(59,130,246,0.6)]"></span>
                    <span>Activity Timeline: {timeColumn}</span>
                </span>
            </div>



            <style>{`
        @keyframes slide {
            0% { transform: translateX(-100%); }
            100% { transform: translateX(200%); }
        }
      `}</style>
        </div>
    );
};

export default TimelineHeatmap;
