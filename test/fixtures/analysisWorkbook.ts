import * as XLSX from 'xlsx'

// Synthetic, deterministic input. No user data or saved application profile is required.
export function createAnalysisWorkbook(): Buffer {
  const book = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(
    book,
    XLSX.utils.aoa_to_sheet([
      ['日期', '区域', '销售额', '数量'],
      ['2026-10-01', '华东', 0.1, 1],
      ['2026-10-02', '华东', 0.2, 2],
      ['2026-10-03', '华南', 10.05, 3],
      ['2026-10-04', '华南', -2.05, 4],
      ['2026-10-05', '华东', null, 5],
      ['2026-10-06', '华南', 0, 6]
    ]),
    '销售明细'
  )
  XLSX.utils.book_append_sheet(
    book,
    XLSX.utils.aoa_to_sheet([
      ['序号', '金额'],
      ...Array.from({ length: 65 }, (_, index) => [index + 1, (index + 1) * 10])
    ]),
    '分页检查'
  )
  return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' })
}
