import { PaperPetDatabase, createUUID } from "../storage/paperpet-database";

export interface GrowthSnapshot {
  effectiveSeconds: number;
  paperCount: number;
  sessionCount: number;
  annotationCount: number;
  level: number;
  intimacy: number;
  nextMilestoneSeconds: number;
}

export class GrowthService {
  public constructor(private readonly database: PaperPetDatabase) {}

  public async recordSessionGrowth(
    sessionID: string,
    effectiveSeconds: number,
    annotationCount: number,
  ): Promise<void> {
    const amount = Math.max(0, effectiveSeconds) / 60;
    if (amount <= 0 && annotationCount <= 0) {
      return;
    }
    await this.database.db.executeTransaction(async () => {
      if (amount > 0) {
        await this.database.db.queryAsync(
          `INSERT INTO growth_ledger (
            id, occurred_at, event_type, amount, source_session_id, metadata_json
          ) VALUES (?, ?, ?, ?, ?, ?)`,
          [
            createUUID(),
            Date.now(),
            "effective-minute",
            amount,
            sessionID,
            JSON.stringify({ modelVersion: 1 }),
          ],
        );
      }
      if (annotationCount > 0) {
        await this.database.db.queryAsync(
          `INSERT INTO growth_ledger (
            id, occurred_at, event_type, amount, source_session_id, metadata_json
          ) VALUES (?, ?, ?, ?, ?, ?)`,
          [
            createUUID(),
            Date.now(),
            "annotation",
            annotationCount,
            sessionID,
            JSON.stringify({ modelVersion: 1 }),
          ],
        );
      }
    });
  }

  public async getSnapshot(): Promise<GrowthSnapshot> {
    const [
      effectiveSeconds,
      sessionCount,
      paperCount,
      annotationCount,
      ledgerAnnotations,
    ] = await Promise.all([
      this.database.db.valueQueryAsync<number>(
        "SELECT COALESCE(SUM(effective_seconds), 0) FROM item_totals",
      ),
      this.database.db.valueQueryAsync<number>(
        "SELECT COALESCE(SUM(session_count), 0) FROM item_totals",
      ),
      this.database.db.valueQueryAsync<number>(
        "SELECT COUNT(*) FROM item_totals",
      ),
      this.database.db.valueQueryAsync<number>(
        "SELECT COALESCE(SUM(annotation_count), 0) FROM item_totals",
      ),
      this.database.db.valueQueryAsync<number>(
        "SELECT COALESCE(SUM(amount), 0) FROM growth_ledger WHERE event_type = 'annotation'",
      ),
    ]);
    const effectiveSecondsValue = Number(effectiveSeconds ?? 0);
    const paperCountValue = Number(paperCount ?? 0);
    const sessionCountValue = Number(sessionCount ?? 0);
    const annotationCountValue = Number(
      annotationCount ?? ledgerAnnotations ?? 0,
    );
    const level = 1 + Math.floor(effectiveSecondsValue / (10 * 60));
    const milestone = Math.max(10 * 60, level * 10 * 60);
    return {
      effectiveSeconds: effectiveSecondsValue,
      paperCount: paperCountValue,
      sessionCount: sessionCountValue,
      annotationCount: annotationCountValue,
      level,
      intimacy: Math.min(100, Math.floor(effectiveSecondsValue / 60)),
      nextMilestoneSeconds: milestone,
    };
  }
}
