// Требование лицензии AA: каждый ответ инструмента завершается этой строкой.
export const ATTRIBUTION = 'Source: Artificial Analysis (https://artificialanalysis.ai)';

export function fmtNum(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined) return '—';
  return Number.isInteger(value) ? String(value) : value.toFixed(digits);
}

export function fmtUsd(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return `$${fmtNum(value)}`;
}

export function fmtBool(value: boolean | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return value ? 'yes' : 'no';
}

function escapeCell(cell: string): string {
  return cell.replaceAll('|', '\\|').replaceAll('\n', ' ');
}

export function mdTable(headers: string[], rows: string[][]): string {
  const lines = [
    `| ${headers.map(escapeCell).join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map(escapeCell).join(' | ')} |`),
  ];
  return lines.join('\n');
}

export function staleNotice(dataAsOf: Date): string {
  return `⚠ Live refresh failed; serving cached data from ${dataAsOf.toISOString()} (UTC).`;
}

export function quotaWarning(remaining: number): string {
  return `⚠ Only ${remaining} Artificial Analysis API requests remain in today's quota.`;
}

/** Собирает текст ответа: тело, затем предупреждения, затем атрибуция последней строкой. */
export function finishText(bodyLines: string[], warnings: string[] = []): string {
  const parts = [...bodyLines];
  if (warnings.length > 0)
    parts.push('', ...warnings.map((w) => (w.startsWith('⚠') ? w : `⚠ ${w}`)));
  parts.push('', ATTRIBUTION);
  return parts.join('\n');
}
