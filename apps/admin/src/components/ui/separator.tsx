import * as SeparatorPrimitive from "@radix-ui/react-separator";
import type { ComponentPropsWithoutRef } from "react";
import { cn } from "@/lib/utils";

export type SeparatorProps = ComponentPropsWithoutRef<typeof SeparatorPrimitive.Root>;

export function Separator({ className, orientation = "horizontal", decorative = true, ...props }: SeparatorProps) {
  return <SeparatorPrimitive.Root decorative={decorative} orientation={orientation} className={cn("shrink-0 bg-slate-200", orientation === "horizontal" ? "h-px w-full" : "h-full w-px", className)} {...props} />;
}
