import {
  Monitor,
  Shield,
  GitBranch,
  ChevronDown,
  Loader2,
} from "lucide-react";
import { useAppStore } from "@/stores/app-store";
import { useChatStore, selectSession } from "@/stores/chat-store";

function StatusItem({
  icon: Icon,
  label,
}: {
  icon: React.ComponentType<{ size?: number; strokeWidth?: number }>;
  label: string;
}) {
  return (
    <button className="flex items-center gap-[6px] px-2 py-[3px] rounded-md hover:bg-white/[0.05] text-[11px] text-[#606060] hover:text-[#888] transition-colors">
      <Icon size={11} strokeWidth={1.8} />
      <span>{label}</span>
      <ChevronDown size={8} className="text-[#404040]" />
    </button>
  );
}

export function StatusBar() {
  const { sessions, activeSessionId, staffSessionId } = useAppStore();
  const sid = activeSessionId || staffSessionId;
  const { isStreaming } = useChatStore(selectSession(sid));
  const activeSession = sessions.find((s) => s.id === activeSessionId);

  return (
    <div
      className="flex items-center justify-between flex-shrink-0 select-none"
      style={{
        height: 32,
        padding: "0 16px",
        borderTop: "1px solid rgba(255,255,255,0.06)",
        background: "#181818",
      }}
    >
      <div className="flex items-center gap-2">
        <StatusItem icon={Monitor} label="Local" />
        <StatusItem icon={Shield} label="Default permissions" />
      </div>
      <div className="flex items-center gap-2">
        <StatusItem icon={GitBranch} label="main" />
        {(isStreaming || activeSession?.status === "running") && (
          <Loader2 size={11} className="text-[#505050] animate-spin" strokeWidth={2} />
        )}
      </div>
    </div>
  );
}
