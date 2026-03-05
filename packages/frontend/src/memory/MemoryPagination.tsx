interface MemoryPaginationProps {
  currentPage: number;
  pageSize: number;
  totalItems: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
}

const PAGE_SIZE_OPTIONS = [10, 20, 50, 100];

function buildVisiblePages(currentPage: number, totalPages: number): number[] {
  const pages = new Set<number>([1, totalPages, currentPage, currentPage - 1, currentPage + 1]);
  return Array.from(pages)
    .filter((page) => page >= 1 && page <= totalPages)
    .sort((a, b) => a - b);
}

export function MemoryPagination({
  currentPage,
  pageSize,
  totalItems,
  onPageChange,
  onPageSizeChange
}: MemoryPaginationProps) {
  const safeTotal = Math.max(0, totalItems);
  const totalPages = Math.max(1, Math.ceil(safeTotal / pageSize));
  const current = Math.min(Math.max(currentPage, 1), totalPages);
  const start = safeTotal === 0 ? 0 : (current - 1) * pageSize + 1;
  const end = safeTotal === 0 ? 0 : Math.min(current * pageSize, safeTotal);
  const pages = buildVisiblePages(current, totalPages);

  return (
    <div className="memory-pagination">
      <div className="memory-pagination-left">
        <label>
          每页
          <select value={pageSize} onChange={(event) => onPageSizeChange(Number(event.currentTarget.value))}>
            {PAGE_SIZE_OPTIONS.map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="memory-pagination-center">
        显示 {start}-{end} / {safeTotal}
      </div>

      <div className="memory-pagination-right">
        <button type="button" onClick={() => onPageChange(current - 1)} disabled={current <= 1}>
          上一页
        </button>
        {pages.map((page) => (
          <button
            key={page}
            type="button"
            className={page === current ? "is-active" : ""}
            onClick={() => onPageChange(page)}
          >
            {page}
          </button>
        ))}
        <button type="button" onClick={() => onPageChange(current + 1)} disabled={current >= totalPages}>
          下一页
        </button>
      </div>
    </div>
  );
}
