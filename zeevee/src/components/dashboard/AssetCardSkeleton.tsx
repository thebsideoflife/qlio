export function AssetCardSkeleton() {
  return (
    <div className="rounded-xl overflow-hidden bg-gradient-to-b from-slate-900 to-slate-950 border border-slate-800/50 shadow-xl">
      {/* Hero Section Skeleton - 16:9 */}
      <div className="relative aspect-video w-full overflow-hidden">
        <div className="h-full w-full bg-slate-800 animate-pulse" />
        <div className="absolute inset-0 bg-gradient-to-t from-slate-950 via-transparent to-transparent" />

        {/* Title overlay skeleton */}
        <div className="absolute bottom-0 left-0 right-0 p-3">
          <div className="h-6 bg-slate-700/50 rounded w-2/3 mb-2 animate-pulse" />
          <div className="flex items-center gap-2">
            <div className="h-4 w-12 bg-slate-700/50 rounded animate-pulse" />
            <div className="h-4 w-14 bg-slate-700/50 rounded animate-pulse" />
          </div>
        </div>
      </div>

      {/* Scenes Section Skeleton */}
      <div className="p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="h-4 bg-slate-800 rounded w-16 animate-pulse" />
          <div className="h-7 bg-slate-800 rounded w-36 animate-pulse" />
        </div>

        {/* Scene items skeleton */}
        <div className="space-y-2">
          {[1, 2].map((i) => (
            <div key={i} className="flex items-center gap-3 p-2 -mx-2">
              <div className="w-20 h-12 bg-slate-800 rounded-md shrink-0 animate-pulse" />
              <div className="flex-1 min-w-0 space-y-2">
                <div className="h-4 bg-slate-800 rounded w-3/4 animate-pulse" />
                <div className="h-3 bg-slate-800 rounded w-1/2 animate-pulse" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
