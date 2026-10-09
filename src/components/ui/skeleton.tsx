import { cn } from "@/lib/utils"

/**
 * #99：唯一的骨架原语。灰底 + 透明文字（`.skeleton-fill`，见 index.css）；
 * 闪光由外层 `.skeleton-shimmer`（QueryView 按「减少动态效果」决定）控制。
 * 想让真实组件（Badge / Button）直接变成骨架块时用 `skeletonClassName`。
 */
export const skeletonClassName = "skeleton-fill"

function Skeleton({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="skeleton"
      aria-hidden
      className={cn(skeletonClassName, "block rounded-md", className)}
      {...props}
    />
  )
}

export { Skeleton }
