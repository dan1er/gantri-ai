export function ErrorState({ title, detail }: { title: string; detail?: string }) {
  return (
    <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
      <strong>{title}</strong>
      {detail && <p className="mt-1 text-red-600 whitespace-pre-wrap">{detail}</p>}
    </div>
  );
}
