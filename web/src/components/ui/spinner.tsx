import { Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";

export function Spinner({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center justify-center p-6 text-faint", className)}>
      <Loader2 className="size-4 animate-spin" />
    </div>
  );
}
