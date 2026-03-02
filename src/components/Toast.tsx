import { createContext, useContext, useState, useCallback, ReactNode } from "react";
import { X, CheckCircle2, AlertCircle, Info } from "lucide-react";

type ToastType = "success" | "error" | "info";

interface ToastItem {
  id: number;
  type: ToastType;
  message: string;
}

interface ToastContextValue {
  toast: (type: ToastType, message: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

let idCounter = 0;

const ICONS: Record<ToastType, ReactNode> = {
  success: <CheckCircle2 size={16} className="text-green-400 shrink-0 mt-0.5" />,
  error: <AlertCircle size={16} className="text-red-400 shrink-0 mt-0.5" />,
  info: <Info size={16} className="text-blue-400 shrink-0 mt-0.5" />,
};

const COLORS: Record<ToastType, string> = {
  success: "border-green-500/30 bg-green-950/90",
  error: "border-red-500/30 bg-red-950/90",
  info: "border-blue-500/30 bg-blue-950/90",
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback(
    (type: ToastType, message: string) => {
      const id = ++idCounter;
      setToasts((prev) => [...prev, { id, type, message }]);
      setTimeout(() => dismiss(id), 4500);
    },
    [dismiss],
  );

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <div className="fixed bottom-4 right-4 z-[200] flex flex-col gap-2 pointer-events-none w-80">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`flex items-start gap-3 px-4 py-3 rounded-lg border shadow-2xl backdrop-blur-md pointer-events-auto text-sm text-zinc-200 ${COLORS[t.type]}`}
          >
            {ICONS[t.type]}
            <span className="flex-1 leading-snug break-words">{t.message}</span>
            <button
              onClick={() => dismiss(t.id)}
              className="text-zinc-500 hover:text-white shrink-0 ml-1 mt-0.5"
            >
              <X size={14} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within ToastProvider");
  return ctx.toast;
}
