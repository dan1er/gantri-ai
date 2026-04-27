export function LoadingShimmer() {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-4 animate-pulse">
      {[1, 2, 3, 4].map((i) => <div key={i} className="h-28 rounded-lg bg-gray-100" />)}
      <div className="col-span-4 h-72 rounded-lg bg-gray-100" />
      <div className="col-span-4 h-96 rounded-lg bg-gray-100" />
    </div>
  );
}
