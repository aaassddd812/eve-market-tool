// ===== 排行榜导出 CSV（Excel 可直接打开）=====
// 带 UTF-8 BOM，Excel 打开中文不乱码；数字原样写出（不加千分位），方便在表格里排序、计算。
// 英文界面下表头和文字单元格用 i18n.js 的翻译函数换成英文（游戏名称同样会换成官方英文名）。

const CJK = /[㐀-鿿]/;

function tr(v) {
  return window.I18N?.lang === 'en' && typeof v === 'string' && CJK.test(v) && window.I18N.t ? window.I18N.t(v) : v;
}

function cell(v) {
  if (v == null || (typeof v === 'number' && !Number.isFinite(v))) return '';
  if (typeof v === 'number') v = Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100);
  else v = String(tr(v));
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

// name：文件名（不含扩展名）；columns：[[表头, 取值函数(row)]]；rows：全部行（不只当前页）
export function exportCsv(name, columns, rows) {
  const lines = [columns.map(([h]) => cell(h)).join(',')];
  for (const r of rows) lines.push(columns.map(([, get]) => cell(get(r))).join(','));
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${tr(name)}-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  return rows.length;
}

// 导出按钮（各排行榜统一样式）
export const exportBtnHtml = (attr) => `<button type="button" class="btn btn-ghost btn-sm csv-export-btn" ${attr} title="导出全部结果为 CSV（Excel 可直接打开）"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg><span>导出 CSV</span></button>`;
