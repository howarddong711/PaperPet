import { PaperPetDatabase } from "../storage/paperpet-database";

export interface DailyReadingPoint {
  date: string;
  foregroundSeconds: number;
  effectiveSeconds: number;
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
  sessionCount: number;
  paperCount: number;
}

export interface ReadingSessionRow {
  id: string;
  startedAt: number;
  endedAt?: number;
  foregroundSeconds: number;
  effectiveSeconds: number;
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
    days = 7,
    now = Date.now(),
  ): Promise<ReadingOverviewData> {
    const start = new Date(now);
    start.setDate(start.getDate() - (days - 1));
    const cutoff = startOfLocalDay(start.getTime());
    const [
      dailyRows,
      behaviorRows,
      itemRows,
      foregroundSeconds,
      effectiveSeconds,
      sessionCount,
      paperCount,
    ] = await Promise.all([
      this.database.db.queryAsync(
        `SELECT strftime('%Y-%m-%d', started_at / 1000, 'unixepoch', 'localtime') AS local_date,
          SUM(foreground_seconds) AS foreground_seconds,
          SUM(effective_seconds) AS effective_seconds,
          COUNT(*) AS session_count
        FROM reading_sessions
        WHERE started_at >= ? AND deleted = 0 AND excluded = 0
        GROUP BY local_date
        ORDER BY local_date`,
        [cutoff],
      ),
      this.database.db.queryAsync(
        `SELECT semantic_events.event_type, SUM(semantic_events.event_count) AS event_count
        FROM semantic_events
        JOIN reading_sessions ON reading_sessions.id = semantic_events.session_id
        WHERE semantic_events.started_at >= ?
          AND reading_sessions.deleted = 0
          AND reading_sessions.excluded = 0
        GROUP BY semantic_events.event_type
        ORDER BY event_count DESC`,
        [cutoff],
      ),
      this.database.db.queryAsync(
        `SELECT library_id, item_key, attachment_key, title_snapshot,
          SUM(foreground_seconds) AS foreground_seconds,
          SUM(effective_seconds) AS effective_seconds, COUNT(*) AS session_count,
          SUM(annotation_count) AS annotation_count, MAX(started_at) AS last_read_at
        FROM reading_sessions
        WHERE started_at >= ? AND deleted = 0 AND excluded = 0
        GROUP BY library_id, item_key, attachment_key
        ORDER BY last_read_at DESC
        LIMIT 12`,
        [cutoff],
      ),
      this.database.db.valueQueryAsync<number>(
        `SELECT COALESCE(SUM(foreground_seconds), 0) FROM reading_sessions
         WHERE started_at >= ? AND deleted = 0 AND excluded = 0`,
        [cutoff],
      ),
      this.database.db.valueQueryAsync<number>(
        `SELECT COALESCE(SUM(effective_seconds), 0) FROM reading_sessions
         WHERE started_at >= ? AND deleted = 0 AND excluded = 0`,
        [cutoff],
      ),
      this.database.db.valueQueryAsync<number>(
        `SELECT COUNT(*) FROM reading_sessions
         WHERE started_at >= ? AND deleted = 0 AND excluded = 0`,
        [cutoff],
      ),
      this.database.db.valueQueryAsync<number>(
        `SELECT COUNT(DISTINCT library_id || ':' || item_key) FROM reading_sessions
         WHERE started_at >= ? AND deleted = 0 AND excluded = 0`,
        [cutoff],
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
      sessionCount: Number(sessionCount ?? 0),
      paperCount: Number(paperCount ?? 0),
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
          effective_seconds, annotation_count, excluded
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
    sessionCount: Number(values.session_count),
  };
}

function mapRecentItem(row: _ZoteroTypes.anyObj): RecentReadingItem {
  const values = row as Record<string, unknown>;
  return {
    libraryID: Number(values.library_id),
    itemKey: String(values.item_key),
    attachmentKey: String(values.attachment_key),
    title: String(values.title_snapshot || "Untitled"),
    foregroundSeconds: Number(values.foreground_seconds),
    effectiveSeconds: Number(values.effective_seconds),
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
