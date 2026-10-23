import { PaperPetDatabase } from "../storage/paperpet-database";

export interface DailyReadingPoint {
  date: string;
  foregroundSeconds: number;
  effectiveSeconds: number;
  noteEditingSeconds: number;
  sessionCount: number;
}

export interface BehaviorCount {
  type: string;
  count: number;
}

export interface RecentReadingItem {
  libraryID: number;
  itemKey: string;
  attachmentKey: string;
  title: string;
  foregroundSeconds: number;
  effectiveSeconds: number;
  noteEditingSeconds: number;
  sessionCount: number;
  annotationCount: number;
  lastReadAt: number;
}

export interface ReadingOverviewData {
  daily: DailyReadingPoint[];
  behaviors: BehaviorCount[];
  recentItems: RecentReadingItem[];
  foregroundSeconds: number;
  effectiveSeconds: number;
  noteEditingSeconds: number;
  sessionCount: number;
  paperCount: number;
  startDate: string;
  endDate: string;
}

export interface ReadingSessionRow {
  id: string;
  startedAt: number;
  endedAt?: number;
  foregroundSeconds: number;
  effectiveSeconds: number;
  noteEditingSeconds: number;
  annotationCount: number;
  excluded: boolean;
}

export interface ItemReadingDetail {
  item: RecentReadingItem;
  daily: DailyReadingPoint[];
  sessions: ReadingSessionRow[];
  selectionCount: number;
  searchCount: number;
}

export class DashboardRepository {
  public constructor(private readonly database: PaperPetDatabase) {}

  public async getOverview(
    range: number | { startDate: string; endDate: string } = 30,
    now = Date.now(),
  ): Promise<ReadingOverviewData> {
    const normalized = normalizeRange(range, now);
    const { startDate, endDate, cutoff, endExclusive, days } = normalized;
    const [
      dailyRows,
      behaviorRows,
      itemRows,
      foregroundSeconds,
      effectiveSeconds,
      noteEditingSeconds,
      sessionCount,
      paperCount,
    ] = await Promise.all([
      this.database.db.queryAsync(
        `SELECT strftime('%Y-%m-%d', started_at / 1000, 'unixepoch', 'localtime') AS local_date,
          SUM(foreground_seconds) AS foreground_seconds,
          SUM(effective_seconds) AS effective_seconds,
          SUM(note_editing_seconds) AS note_editing_seconds,
          COUNT(*) AS session_count
        FROM reading_sessions
        WHERE started_at >= ? AND started_at < ? AND deleted = 0 AND excluded = 0
        GROUP BY local_date
        ORDER BY local_date`,
        [cutoff, endExclusive],
      ),
      this.database.db.queryAsync(
        `SELECT semantic_events.event_type, SUM(semantic_events.event_count) AS event_count
        FROM semantic_events
        JOIN reading_sessions ON reading_sessions.id = semantic_events.session_id
        WHERE semantic_events.started_at >= ? AND semantic_events.started_at < ?
          AND reading_sessions.started_at >= ? AND reading_sessions.started_at < ?
          AND reading_sessions.deleted = 0
          AND reading_sessions.excluded = 0
        GROUP BY semantic_events.event_type
        ORDER BY event_count DESC`,
        [cutoff, endExclusive, cutoff, endExclusive],
      ),
      this.database.db.queryAsync(
        `SELECT library_id, item_key, attachment_key, title_snapshot,
          SUM(foreground_seconds) AS foreground_seconds,
          SUM(effective_seconds) AS effective_seconds, COUNT(*) AS session_count,
          SUM(note_editing_seconds) AS note_editing_seconds,
          SUM(annotation_count) AS annotation_count, MAX(started_at) AS last_read_at
        FROM reading_sessions
        WHERE started_at >= ? AND started_at < ? AND deleted = 0 AND excluded = 0
        GROUP BY library_id, item_key, attachment_key
        ORDER BY last_read_at DESC
        LIMIT 12`,
        [cutoff, endExclusive],
      ),
      this.database.db.valueQueryAsync<number>(
        `SELECT COALESCE(SUM(foreground_seconds), 0) FROM reading_sessions
         WHERE started_at >= ? AND started_at < ? AND deleted = 0 AND excluded = 0`,
        [cutoff, endExclusive],
      ),
      this.database.db.valueQueryAsync<number>(
        `SELECT COALESCE(SUM(effective_seconds), 0) FROM reading_sessions
         WHERE started_at >= ? AND started_at < ? AND deleted = 0 AND excluded = 0`,
        [cutoff, endExclusive],
      ),
      this.database.db.valueQueryAsync<number>(
        `SELECT COALESCE(SUM(note_editing_seconds), 0) FROM reading_sessions
         WHERE started_at >= ? AND started_at < ? AND deleted = 0 AND excluded = 0`,
        [cutoff, endExclusive],
      ),
      this.database.db.valueQueryAsync<number>(
        `SELECT COUNT(*) FROM reading_sessions
         WHERE started_at >= ? AND started_at < ? AND deleted = 0 AND excluded = 0`,
        [cutoff, endExclusive],
      ),
      this.database.db.valueQueryAsync<number>(
        `SELECT COUNT(DISTINCT library_id || ':' || item_key) FROM reading_sessions
         WHERE started_at >= ? AND started_at < ? AND deleted = 0 AND excluded = 0`,
        [cutoff, endExclusive],
      ),
    ]);

    const dailyByDate = new Map(
      (dailyRows ?? []).map((row) => {
        const values = row as Record<string, unknown>;
        return [String(values.local_date), mapDaily(values)] as const;
      }),
    );
    const daily = Array.from({ length: days }, (_, index) => {
      const day = new Date(cutoff);
      day.setDate(day.getDate() + index);
      const date = localDateFor(day.getTime());
      return (
        dailyByDate.get(date) ?? {
          date,
          foregroundSeconds: 0,
          effectiveSeconds: 0,
          noteEditingSeconds: 0,
          sessionCount: 0,
        }
      );
    });
    return {
      daily,
      behaviors: (behaviorRows ?? []).map((row) => {
        const values = row as Record<string, unknown>;
        return {
          type: String(values.event_type),
          count: Number(values.event_count),
        };
      }),
      recentItems: (itemRows ?? []).map(mapRecentItem),
      foregroundSeconds: Number(foregroundSeconds ?? 0),
      effectiveSeconds: Number(effectiveSeconds ?? 0),
      noteEditingSeconds: Number(noteEditingSeconds ?? 0),
      sessionCount: Number(sessionCount ?? 0),
      paperCount: Number(paperCount ?? 0),
      startDate,
      endDate,
    };
  }

  public async getItemDetail(
    item: RecentReadingItem,
  ): Promise<ItemReadingDetail> {
    const [dailyRows, totalRows, sessionRows] = await Promise.all([
      this.database.db.queryAsync(
        `SELECT local_date,
          SUM(foreground_seconds) AS foreground_seconds,
          SUM(effective_seconds) AS effective_seconds,
          SUM(note_editing_seconds) AS note_editing_seconds,
          SUM(session_count) AS session_count
        FROM daily_item_stats
        WHERE library_id = ? AND item_key = ? AND attachment_key = ?
        GROUP BY local_date ORDER BY local_date DESC LIMIT 30`,
        [item.libraryID, item.itemKey, item.attachmentKey],
      ),
      this.database.db.queryAsync(
        `SELECT library_id, item_key, attachment_key, title_snapshot,
          SUM(CASE WHEN excluded = 0 THEN foreground_seconds ELSE 0 END) AS foreground_seconds,
          SUM(CASE WHEN excluded = 0 THEN effective_seconds ELSE 0 END) AS effective_seconds,
          SUM(CASE WHEN excluded = 0 THEN note_editing_seconds ELSE 0 END) AS note_editing_seconds,
          SUM(CASE WHEN excluded = 0 THEN 1 ELSE 0 END) AS session_count,
          SUM(CASE WHEN excluded = 0 THEN annotation_count ELSE 0 END) AS annotation_count,
          MAX(started_at) AS last_read_at
        FROM reading_sessions
        WHERE library_id = ? AND item_key = ? AND attachment_key = ? AND deleted = 0
        GROUP BY library_id, item_key, attachment_key`,
        [item.libraryID, item.itemKey, item.attachmentKey],
      ),
      this.database.db.queryAsync(
        `SELECT id, started_at, ended_at, foreground_seconds,
          effective_seconds, note_editing_seconds, annotation_count, excluded
        FROM reading_sessions
        WHERE library_id = ? AND item_key = ? AND attachment_key = ?
          AND deleted = 0
        ORDER BY started_at DESC LIMIT 50`,
        [item.libraryID, item.itemKey, item.attachmentKey],
      ),
    ]);
    const [selectionCount, searchCount] = await Promise.all([
      this.database.db.valueQueryAsync<number>(
        `SELECT selection_count FROM item_totals
         WHERE library_id = ? AND item_key = ? AND attachment_key = ?`,
        [item.libraryID, item.itemKey, item.attachmentKey],
      ),
      this.database.db.valueQueryAsync<number>(
        `SELECT search_count FROM item_totals
         WHERE library_id = ? AND item_key = ? AND attachment_key = ?`,
        [item.libraryID, item.itemKey, item.attachmentKey],
      ),
    ]);
    return {
      item: totalRows?.length
        ? mapRecentItem(totalRows[0])
        : {
            ...item,
            foregroundSeconds: 0,
            effectiveSeconds: 0,
            noteEditingSeconds: 0,
            sessionCount: 0,
            annotationCount: 0,
          },
      daily: (dailyRows ?? [])
        .map((row) => mapDaily(row as Record<string, unknown>))
        .toReversed(),
      sessions: (sessionRows ?? []).map((row) => {
        const values = row as Record<string, unknown>;
        return {
          id: String(values.id),
          startedAt: Number(values.started_at),
          endedAt:
            values.ended_at === null || values.ended_at === undefined
              ? undefined
              : Number(values.ended_at),
          foregroundSeconds: Number(values.foreground_seconds),
          effectiveSeconds: Number(values.effective_seconds),
          noteEditingSeconds: Number(values.note_editing_seconds ?? 0),
          annotationCount: Number(values.annotation_count),
          excluded: Number(values.excluded) === 1,
        };
      }),
      selectionCount: Number(selectionCount ?? 0),
      searchCount: Number(searchCount ?? 0),
    };
  }
}

function mapDaily(values: Record<string, unknown>): DailyReadingPoint {
  return {
    date: String(values.local_date),
    foregroundSeconds: Number(values.foreground_seconds),
    effectiveSeconds: Number(values.effective_seconds),
    noteEditingSeconds: Number(values.note_editing_seconds ?? 0),
    sessionCount: Number(values.session_count),
  };
}

function mapRecentItem(row: _ZoteroTypes.anyObj): RecentReadingItem {
  const values = row as Record<string, unknown>;
  return {
    libraryID: Number(values.library_id),
    itemKey: String(values.item_key),
    attachmentKey: String(values.attachment_key),
    title: String(values.title_snapshot || ""),
    foregroundSeconds: Number(values.foreground_seconds),
    effectiveSeconds: Number(values.effective_seconds),
    noteEditingSeconds: Number(values.note_editing_seconds ?? 0),
    sessionCount: Number(values.session_count),
    annotationCount: Number(values.annotation_count),
    lastReadAt: Number(values.last_read_at),
  };
}

function startOfLocalDay(timestamp: number): number {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function localDateFor(timestamp: number): string {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function normalizeRange(
  range: number | { startDate: string; endDate: string },
  now: number,
): {
  startDate: string;
  endDate: string;
  cutoff: number;
  endExclusive: number;
  days: number;
} {
  if (typeof range === "number") {
    const days = Math.min(366, Math.max(1, Math.floor(range)));
    const end = new Date(now);
    const endExclusiveDate = new Date(end);
    endExclusiveDate.setHours(0, 0, 0, 0);
    endExclusiveDate.setDate(endExclusiveDate.getDate() + 1);
    const start = new Date(endExclusiveDate);
    start.setDate(start.getDate() - days);
    return {
      startDate: localDateFor(start.getTime()),
      endDate: localDateFor(end.getTime()),
      cutoff: start.getTime(),
      endExclusive: endExclusiveDate.getTime(),
      days,
    };
  }
  const start = parseLocalDate(range.startDate);
  const end = parseLocalDate(range.endDate);
  const startTime = Math.min(start, end);
  const endTime = Math.max(start, end);
  const endExclusiveDate = new Date(endTime);
  endExclusiveDate.setDate(endExclusiveDate.getDate() + 1);
  const limitedStartTime = Math.max(
    startTime,
    endExclusiveDate.getTime() - 366 * 86400000,
  );
  const days = Math.min(
    366,
    Math.max(
      1,
      Math.round((endExclusiveDate.getTime() - limitedStartTime) / 86400000),
    ),
  );
  return {
    startDate: localDateFor(limitedStartTime),
    endDate: localDateFor(endTime),
    cutoff: limitedStartTime,
    endExclusive: endExclusiveDate.getTime(),
    days,
  };
}

function parseLocalDate(value: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return startOfLocalDay(Date.now());
  const date = new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
  );
  return startOfLocalDay(date.getTime());
}
