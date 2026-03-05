export function MemoryTableSkeleton() {
  return (
    <div className="memory-table-shell memory-table-skeleton">
      <table className="memory-table">
        <thead>
          <tr>
            <th className="memory-cell-checkbox" />
            <th>内容</th>
            <th>分类</th>
            <th>来源</th>
            <th>审核/状态</th>
            <th>时间</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: 5 }).map((_, index) => (
            <tr key={`skeleton-row-${index}`}>
              <td className="memory-cell-checkbox">
                <span className="memory-skeleton-block memory-skeleton-checkbox" />
              </td>
              <td>
                <span className="memory-skeleton-block memory-skeleton-content" />
              </td>
              <td>
                <span className="memory-skeleton-block memory-skeleton-category" />
              </td>
              <td>
                <span className="memory-skeleton-block memory-skeleton-source" />
              </td>
              <td>
                <span className="memory-skeleton-block memory-skeleton-status" />
              </td>
              <td>
                <span className="memory-skeleton-block memory-skeleton-time" />
              </td>
              <td>
                <span className="memory-skeleton-block memory-skeleton-action" />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
