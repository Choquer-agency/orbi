type ThreadNavigationRow = {
  id: string;
  isStarred?: boolean;
};

let visibleThreads: ThreadNavigationRow[] = [];

export function setVisibleThreadNavigationRows(rows: ThreadNavigationRow[]) {
  visibleThreads = rows.map((row) => ({ id: row.id, isStarred: row.isStarred }));
}

export function getVisibleThreadNavigationRows(): ThreadNavigationRow[] {
  return visibleThreads;
}
