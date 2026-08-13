import type {
  ReaderItemIdentity,
  ReadingActivityUpdate,
  SemanticReadingEvent,
} from "../tracking/reader-activity-controller";
import { createUUID, PaperPetDatabase } from "../storage/paperpet-database";

const MODEL_VERSION = 1;
const FLUSH_INTERVAL_MS = 15_000;
const SESSION_AWAY_SPLIT_MS = 10 * 60 * 1_000;
const EVENT_MERGE_WINDOW_MS = 2_000;

interface PendingEvent {
  id: string;
  type: SemanticReadingEvent["type"];
  startedAt: number;
  endedAt: number;
  count: number;
  pageIndex?: number;
}

interface DailyDelta {
  localDate: string;
  timezone: string;
  foregroundSeconds: number;
  effectiveSeconds: number;
  annotationCount: number;
  selectionCount: number;
  searchCount: number;
  countSession: boolean;
}

interface ActiveSession {
  id: string;
  item: ReaderItemIdentity;
  startedAt: number;
  lastReaderAt: number;
  lastFlushAt: number;
  timezone: string;
  foregroundSeconds: number;
  effectiveSeconds: number;
  annotationCount: number;
  pendingForegroundSeconds: number;
  pendingEffectiveSeconds: number;
  pendingAnnotationCount: number;
  pendingItemSessionCount: number;
  pendingEvents: PendingEvent[];
  dailyDeltas: Map<string, DailyDelta>;
  countedDates: Set<string>;
}

export interface CurrentSessionSummary {
  item: ReaderItemIdentity;
  startedAt: number;
  foregroundSeconds: number;
  effectiveSeconds: number;
  annotationCount: number;
}

export class ReadingSessionCoordinator {
  private active?: ActiveSession;
  private deviceID = "";
  private writeChain: Promise<void> = Promise.resolve();

  public constructor(private readonly database: PaperPetDatabase) {}

  public async initialize(): Promise<void> {
    this.deviceID = await this.database.getOrCreateDeviceID();
  }

  public acceptUpdate(update: ReadingActivityUpdate): void {
    const { item, observedAt, snapshot } = update;
    if (this.active && item && !sameItem(this.active.item, item)) {
      this.finishSession(observedAt);
    }

    if (!this.active && item && snapshot.effectiveDeltaSeconds > 0) {
      this.startSession(item, observedAt);
    }

    const active = this.active;
    if (!active) {
      return;
    }

    if (!item) {
      if (observedAt - active.lastReaderAt >= SESSION_AWAY_SPLIT_MS) {
        this.finishSession(observedAt);
      }
      return;
    }

    active.lastReaderAt = observedAt;
    active.foregroundSeconds += snapshot.foregroundDeltaSeconds;
    active.effectiveSeconds += snapshot.effectiveDeltaSeconds;
    active.pendingForegroundSeconds += snapshot.foregroundDeltaSeconds;
    active.pendingEffectiveSeconds += snapshot.effectiveDeltaSeconds;
    this.addDailyTime(
      active,
      observedAt,
      snapshot.foregroundDeltaSeconds,
      snapshot.effectiveDeltaSeconds,
    );

    if (observedAt - active.lastFlushAt >= FLUSH_INTERVAL_MS) {
      this.queueFlush(active, false, observedAt);
    }
  }

  public recordSemanticEvent(event: SemanticReadingEvent): void {
    const active = this.active;
    if (!active) {
      return;
    }
    const previous = active.pendingEvents.at(-1);
    if (
      previous &&
      previous.type === event.type &&
      previous.pageIndex === event.pageIndex &&
      event.observedAt - previous.endedAt <= EVENT_MERGE_WINDOW_MS
    ) {
      previous.endedAt = event.observedAt;
      previous.count += 1;
    } else {
      active.pendingEvents.push({
        id: createUUID(),
        type: event.type,
        startedAt: event.observedAt,
        endedAt: event.observedAt,
        count: 1,
        pageIndex: event.pageIndex,
      });
    }

    const daily = this.getDailyDelta(active, event.observedAt);
    if (event.type === "annotation") {
      active.annotationCount += 1;
      active.pendingAnnotationCount += 1;
      daily.annotationCount += 1;
    } else if (event.type === "selection") {
      daily.selectionCount += 1;
    } else if (event.type === "search") {
      daily.searchCount += 1;
    }
  }

  public getCurrentSession(): CurrentSessionSummary | undefined {
    const active = this.active;
    if (!active) {
      return undefined;
    }
    return {
      item: active.item,
      startedAt: active.startedAt,
      foregroundSeconds: active.foregroundSeconds,
      effectiveSeconds: active.effectiveSeconds,
      annotationCount: active.annotationCount,
    };
  }

  public async shutdown(now = Date.now()): Promise<void> {
    if (this.active) {
      this.finishSession(now);
    }
    await this.writeChain;
  }

  public async clearData(): Promise<void> {
    // Drop the in-memory session without persisting it, then wait for any
    // already queued insert/flush before deleting the stored records.
    await this.discardActiveSession();
    await this.database.clearAllData();
  }

  public async discardActiveSession(): Promise<void> {
    this.active = undefined;
    await this.writeChain;
  }

  private startSession(item: ReaderItemIdentity, observedAt: number): void {
    const timezone = currentTimezone();
    const session: ActiveSession = {
      id: createUUID(),
      item,
      startedAt: observedAt,
      lastReaderAt: observedAt,
      lastFlushAt: observedAt,
      timezone,
      foregroundSeconds: 0,
      effectiveSeconds: 0,
      annotationCount: 0,
      pendingForegroundSeconds: 0,
      pendingEffectiveSeconds: 0,
      pendingAnnotationCount: 0,
      pendingItemSessionCount: 1,
      pendingEvents: [],
      dailyDeltas: new Map(),
      countedDates: new Set(),
    };
    this.active = session;
    this.getDailyDelta(session, observedAt);
    this.enqueue(async () => {
      await this.database.db.queryAsync(
        `INSERT INTO reading_sessions (
          id, device_id, library_id, item_key, attachment_key, title_snapshot,
          started_at, timezone, model_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          session.id,
          this.deviceID,
          item.libraryID,
          item.itemKey,
          item.attachmentKey,
          item.title,
          observedAt,
          timezone,
          MODEL_VERSION,
        ],
      );
    });
  }

  private finishSession(endedAt: number): void {
    const active = this.active;
    if (!active) {
      return;
    }
    this.active = undefined;
    this.queueFlush(active, true, endedAt);
  }

  private queueFlush(
    session: ActiveSession,
    finish: boolean,
    observedAt: number,
  ): void {
    const foregroundDelta = session.pendingForegroundSeconds;
    const effectiveDelta = session.pendingEffectiveSeconds;
    const annotationDelta = session.pendingAnnotationCount;
    const itemSessionDelta = session.pendingItemSessionCount;
    const events = session.pendingEvents.splice(0);
    const dailyDeltas = [...session.dailyDeltas.values()].map((value) => ({
      ...value,
    }));
    session.pendingForegroundSeconds = 0;
    session.pendingEffectiveSeconds = 0;
    session.pendingAnnotationCount = 0;
    session.pendingItemSessionCount = 0;
    session.dailyDeltas.clear();
    session.lastFlushAt = observedAt;

    this.enqueue(async () => {
      await this.database.db.executeTransaction(async () => {
        await this.database.db.queryAsync(
          `UPDATE reading_sessions SET
             ended_at = ?,
             foreground_seconds = foreground_seconds + ?,
             effective_seconds = effective_seconds + ?,
             annotation_count = annotation_count + ?
           WHERE id = ?`,
          [
            finish ? observedAt : null,
            foregroundDelta,
            effectiveDelta,
            annotationDelta,
            session.id,
          ],
        );
        for (const event of events) {
          await this.database.db.queryAsync(
            `INSERT INTO semantic_events (
              id, session_id, event_type, started_at, ended_at,
              event_count, page_index
            ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
              event.id,
              session.id,
              event.type,
              event.startedAt,
              event.endedAt,
              event.count,
              event.pageIndex ?? null,
            ],
          );
        }
        for (const daily of dailyDeltas) {
          await this.upsertDailyDelta(session, daily);
        }
        if (foregroundDelta > 0 || effectiveDelta > 0 || annotationDelta > 0) {
          await this.upsertItemTotals(
            session,
            observedAt,
            foregroundDelta,
            effectiveDelta,
            annotationDelta,
            itemSessionDelta,
            dailyDeltas.reduce((sum, day) => sum + day.selectionCount, 0),
            dailyDeltas.reduce((sum, day) => sum + day.searchCount, 0),
          );
        }
      });
    });
  }

  private async upsertDailyDelta(
    session: ActiveSession,
    daily: DailyDelta,
  ): Promise<void> {
    const { item } = session;
    await this.database.db.queryAsync(
      `INSERT INTO daily_item_stats (
        local_date, timezone, library_id, item_key, attachment_key,
        foreground_seconds, effective_seconds, session_count,
        annotation_count, selection_count, search_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(local_date, timezone, library_id, item_key, attachment_key)
      DO UPDATE SET
        foreground_seconds = foreground_seconds + excluded.foreground_seconds,
        effective_seconds = effective_seconds + excluded.effective_seconds,
        session_count = session_count + excluded.session_count,
        annotation_count = annotation_count + excluded.annotation_count,
        selection_count = selection_count + excluded.selection_count,
        search_count = search_count + excluded.search_count`,
      [
        daily.localDate,
        daily.timezone,
        item.libraryID,
        item.itemKey,
        item.attachmentKey,
        daily.foregroundSeconds,
        daily.effectiveSeconds,
        daily.countSession ? 1 : 0,
        daily.annotationCount,
        daily.selectionCount,
        daily.searchCount,
      ],
    );
  }

  private async upsertItemTotals(
    session: ActiveSession,
    observedAt: number,
    foregroundDelta: number,
    effectiveDelta: number,
    annotationDelta: number,
    sessionDelta: number,
    selectionDelta: number,
    searchDelta: number,
  ): Promise<void> {
    const { item } = session;
    await this.database.db.queryAsync(
      `INSERT INTO item_totals (
        library_id, item_key, attachment_key, title_snapshot,
        foreground_seconds, effective_seconds, session_count,
        annotation_count, selection_count, search_count,
        first_read_at, last_read_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(library_id, item_key, attachment_key) DO UPDATE SET
        title_snapshot = excluded.title_snapshot,
        foreground_seconds = foreground_seconds + excluded.foreground_seconds,
        effective_seconds = effective_seconds + excluded.effective_seconds,
        session_count = session_count + excluded.session_count,
        annotation_count = annotation_count + excluded.annotation_count,
        selection_count = selection_count + excluded.selection_count,
        search_count = search_count + excluded.search_count,
        last_read_at = excluded.last_read_at`,
      [
        item.libraryID,
        item.itemKey,
        item.attachmentKey,
        item.title,
        foregroundDelta,
        effectiveDelta,
        sessionDelta,
        annotationDelta,
        selectionDelta,
        searchDelta,
        session.startedAt,
        observedAt,
      ],
    );
  }

  private addDailyTime(
    session: ActiveSession,
    observedAt: number,
    foregroundSeconds: number,
    effectiveSeconds: number,
  ): void {
    const daily = this.getDailyDelta(session, observedAt);
    daily.foregroundSeconds += foregroundSeconds;
    daily.effectiveSeconds += effectiveSeconds;
  }

  private getDailyDelta(
    session: ActiveSession,
    observedAt: number,
  ): DailyDelta {
    const localDate = localDateFor(observedAt);
    let daily = session.dailyDeltas.get(localDate);
    if (!daily) {
      const countSession = !session.countedDates.has(localDate);
      session.countedDates.add(localDate);
      daily = {
        localDate,
        timezone: session.timezone,
        foregroundSeconds: 0,
        effectiveSeconds: 0,
        annotationCount: 0,
        selectionCount: 0,
        searchCount: 0,
        countSession,
      };
      session.dailyDeltas.set(localDate, daily);
    }
    return daily;
  }

  private enqueue(operation: () => Promise<void>): void {
    this.writeChain = this.writeChain
      .then(operation)
      .catch((error: unknown) => {
        Zotero.logError(
          error instanceof Error
            ? error
            : new Error(`PaperPet database write failed: ${String(error)}`),
        );
      });
  }
}

function sameItem(
  left: ReaderItemIdentity,
  right: ReaderItemIdentity,
): boolean {
  return (
    left.libraryID === right.libraryID &&
    left.itemKey === right.itemKey &&
    left.attachmentKey === right.attachmentKey
  );
}

function currentTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function localDateFor(timestamp: number): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  return `${values.year}-${values.month}-${values.day}`;
}
