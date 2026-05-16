// safeScan.ts — guard rails for table scans that may contain large rows.
//
// Convex enforces a 16 MiB per-function byte-read limit. The dangerous
// pattern is iterating `emails` (or any table whose rows can be many MBs)
// with `.collect()`, `.take(N)`, or `.filter(...)` over an unindexed field.
// A single huge row blows the budget instantly.
//
// Use `safePaginate` to walk such tables. It:
//   - calls `paginate({ numItems })` (byte-aware — Convex returns fewer rows
//     when needed to stay under the limit)
//   - returns the opaque cursor so the caller can resume in a follow-up
//     query/action
//   - accepts a `select` projection so the caller never holds onto the
//     full row beyond what's needed for the next decision
//
// For per-row work that requires the full body, fetch ONE row at a time
// inside a separate query.
//
// Example:
//
//   export const listLite = internalQuery({
//     args: { cursor: v.optional(v.string()) },
//     handler: (ctx, { cursor }) =>
//       safePaginate(ctx.db.query("emails").order("asc"), {
//         cursor,
//         numItems: 10,
//         select: (r) => ({ id: r._id, receivedAt: r.receivedAt }),
//       }),
//   });

import type { QueryInitializer, OrderedQuery } from "convex/server";

type Pageable<Doc> = QueryInitializer<any> | OrderedQuery<any>;

export async function safePaginate<Doc, T>(
  q: Pageable<Doc>,
  opts: {
    cursor?: string | null;
    numItems: number;
    select: (row: any) => T;
  },
): Promise<{ rows: T[]; cursor: string; isDone: boolean }> {
  const page = await (q as any).paginate({
    numItems: opts.numItems,
    cursor: opts.cursor ?? null,
  });
  return {
    rows: page.page.map(opts.select),
    cursor: page.continueCursor,
    isDone: page.isDone,
  };
}
