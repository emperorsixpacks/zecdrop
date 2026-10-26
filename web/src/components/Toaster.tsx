import { useToast } from "@/lib/toast";
import { cn } from "@/lib/utils";

/** Where toasts appear: bottom centre, over everything, never in the way of a tap. */
export function Toaster() {
  const text = useToast((s) => s.text);
  return (
    <div aria-hidden="true" className="pointer-events-none fixed inset-x-0 bottom-6 z-[60] flex justify-center px-4">
      <p
        data-testid="toast"
        className={cn(
          "rounded-full bg-foreground px-5 py-2.5 text-base font-semibold text-background transition-[opacity,transform] duration-300",
          text === null ? "translate-y-4 opacity-0" : "translate-y-0 opacity-100",
        )}
      >
        {text ?? ""}
      </p>
    </div>
  );
}
