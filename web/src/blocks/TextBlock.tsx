export function TextBlock({ block }: { block: { markdown: string } }) {
  let html = block.markdown
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>');
  // Headings — process line-by-line
  html = html.split('\n').map((line) => {
    if (line.startsWith('### ')) return `<h3 class="text-lg font-semibold text-gantri-ink mt-6 mb-3">${line.slice(4)}</h3>`;
    if (line.startsWith('## ')) return `<h2 class="text-xl font-semibold text-gantri-ink mt-8 mb-4">${line.slice(3)}</h2>`;
    if (line.startsWith('# ')) return `<h1 class="text-2xl font-bold text-gantri-ink mt-8 mb-4">${line.slice(2)}</h1>`;
    return line;
  }).join('\n');
  // Paragraph breaks
  html = html.replace(/\n\n/g, '<br/><br/>').replace(/\n/g, '<br/>');
  return <div className="text-sm text-gray-700 leading-relaxed" dangerouslySetInnerHTML={{ __html: html }} />;
}
