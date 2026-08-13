import {
  DashboardRepository,
  type ItemReadingDetail,
  type ReadingOverviewData,
  type RecentReadingItem,
} from "./dashboard-repository";
import type { CurrentSessionSummary } from "../sessions/reading-session-coordinator";
import type { GrowthSnapshot } from "../growth/growth-service";

const XHTML_NS = "http://www.w3.org/1999/xhtml";

export interface DashboardActions {
  onExportBackup: () => Promise<void>;
  onImportBackup: () => Promise<void>;
  onClearData: () => Promise<void>;
  onExcludeSession: (sessionID: string, excluded: boolean) => Promise<void>;
}

export class DashboardView {
  private tabID?: string;
  private root?: HTMLDivElement;

  public constructor(
    private readonly window: _ZoteroTypes.MainWindow,
    private readonly repository: DashboardRepository,
    private readonly getCurrentSession: () => CurrentSessionSummary | undefined,
    private readonly getGrowth: () => Promise<GrowthSnapshot>,
    private readonly actions: DashboardActions,
  ) {}

  public async open(): Promise<void> {
    if (this.tabID) {
      this.window.Zotero_Tabs.select(this.tabID);
      await this.renderOverview();
      return;
    }
    const tab = this.window.Zotero_Tabs.add({
      type: "paperpet-dashboard",
      title: "PaperPet",
      data: {},
      select: true,
      onClose: () => this.destroy(),
    });
    this.tabID = tab.id;
    this.root = this.createElement("div");
    this.root.className = "paperpet-dashboard";
    tab.container.appendChild(this.root);
    await this.renderOverview();
  }

  public destroy(): void {
    this.root?.remove();
    this.root = undefined;
    this.tabID = undefined;
  }

  private async renderOverview(): Promise<void> {
    if (!this.root) {
      return;
    }
    this.renderLoading();
    let data: ReadingOverviewData;
    let growth: GrowthSnapshot;
    try {
      [data, growth] = await Promise.all([
        this.repository.getOverview(7),
        this.getGrowth(),
      ]);
    } catch (error) {
      this.renderError(error);
      return;
    }
    if (!this.root) {
      return;
    }
    this.root.replaceChildren();

    const header = this.createHeader(
      this.copy("最近阅读", "Recent reading"),
      this.copy("最近七天 · 本地数据", "Last seven days · Local data"),
    );
    const current = this.getCurrentSession();
    const metrics = this.createElement("section");
    metrics.className = "paperpet-dashboard__metrics";
    metrics.append(
      this.metric(
        this.copy("有效阅读", "Effective reading"),
        formatDuration(data.effectiveSeconds, Zotero.locale),
      ),
      this.metric(
        this.copy("前台阅读器", "Foreground reader"),
        formatDuration(data.foregroundSeconds, Zotero.locale),
      ),
      this.metric(this.copy("阅读会话", "Sessions"), String(data.sessionCount)),
      this.metric(this.copy("读过论文", "Papers"), String(data.paperCount)),
    );

    const main = this.createElement("div");
    main.className = "paperpet-dashboard__grid";
    const left = this.createElement("div");
    left.className = "paperpet-dashboard__main";
    left.append(this.renderDailyChart(data), this.renderRecentItems(data));
    const aside = this.createElement("aside");
    aside.className = "paperpet-dashboard__aside";
    aside.append(
      this.renderCurrentSession(current),
      this.renderReadingRatio(data),
      this.renderBehaviors(data),
      this.renderGrowth(growth),
    );
    main.append(left, aside);
    this.root.append(header, metrics, main);
  }

  private async renderItemDetail(item: RecentReadingItem): Promise<void> {
    if (!this.root) {
      return;
    }
    this.renderLoading();
    let detail: ItemReadingDetail;
    try {
      detail = await this.repository.getItemDetail(item);
    } catch (error) {
      this.renderError(error);
      return;
    }
    if (!this.root) {
      return;
    }
    this.root.replaceChildren();
    const header = this.createHeader(
      item.title,
      this.copy("论文阅读详情", "Paper reading details"),
    );
    const back = this.createElement("button");
    back.className = "paperpet-dashboard__back";
    back.type = "button";
    back.textContent = this.copy("返回最近阅读", "Back to recent reading");
    back.addEventListener("click", () => void this.renderOverview());
    header.prepend(back);

    const metrics = this.createElement("section");
    metrics.className = "paperpet-dashboard__metrics";
    metrics.append(
      this.metric(
        this.copy("累计有效阅读", "Effective reading"),
        formatDuration(item.effectiveSeconds, Zotero.locale),
      ),
      this.metric(
        this.copy("累计前台时间", "Foreground time"),
        formatDuration(item.foregroundSeconds, Zotero.locale),
      ),
      this.metric(this.copy("会话", "Sessions"), String(item.sessionCount)),
      this.metric(
        this.copy("批注", "Annotations"),
        String(item.annotationCount),
      ),
    );
    const content = this.createElement("div");
    content.className = "paperpet-dashboard__detail-grid";
    content.append(
      this.renderItemTrend(detail),
      this.renderSessionList(detail),
      this.renderItemBehaviors(detail),
    );
    this.root.append(header, metrics, content);
  }

  private createHeader(title: string, eyebrow: string): HTMLElement {
    const header = this.createElement("header");
    header.className = "paperpet-dashboard__header";
    const copy = this.createElement("div");
    const label = this.createElement("span");
    label.className = "paperpet-dashboard__eyebrow";
    label.textContent = eyebrow;
    const heading = this.createElement("h1");
    heading.textContent = title;
    copy.append(label, heading);
    const tools = this.createElement("div");
    tools.className = "paperpet-dashboard__tools";
    const backup = this.createElement("button");
    backup.type = "button";
    backup.className = "paperpet-dashboard__tool";
    backup.textContent = this.copy("备份数据", "Backup");
    backup.addEventListener(
      "click",
      () => void this.runAction(this.actions.onExportBackup),
    );
    const restore = this.createElement("button");
    restore.type = "button";
    restore.className = "paperpet-dashboard__tool";
    restore.textContent = this.copy("导入备份", "Restore");
    restore.addEventListener(
      "click",
      () => void this.runAction(this.actions.onImportBackup),
    );
    const clear = this.createElement("button");
    clear.type = "button";
    clear.className =
      "paperpet-dashboard__tool paperpet-dashboard__tool--quiet";
    clear.textContent = this.copy("清空记录", "Clear records");
    clear.addEventListener(
      "click",
      () => void this.runAction(this.actions.onClearData),
    );
    const privacy = this.createElement("span");
    privacy.className = "paperpet-dashboard__privacy";
    privacy.textContent = this.copy(
      "仅保存在本机",
      "Stored only on this device",
    );
    tools.append(backup, restore, clear, privacy);
    header.append(copy, tools);
    return header;
  }

  private async runAction(action: () => Promise<void>): Promise<void> {
    try {
      await action();
      await this.renderOverview();
    } catch (error) {
      this.renderError(error);
    }
  }

  private metric(label: string, value: string): HTMLElement {
    const item = this.createElement("div");
    item.className = "paperpet-dashboard__metric";
    const valueElement = this.createElement("strong");
    valueElement.textContent = value;
    const labelElement = this.createElement("span");
    labelElement.textContent = label;
    item.append(valueElement, labelElement);
    return item;
  }

  private renderDailyChart(data: ReadingOverviewData): HTMLElement {
    const section = this.section(this.copy("每日阅读", "Daily reading"));
    const chart = this.createElement("div");
    chart.className = "paperpet-chart";
    const maximum = Math.max(
      60,
      ...data.daily.map((point) => point.foregroundSeconds),
    );
    for (const point of data.daily) {
      const column = this.createElement("div");
      column.className = "paperpet-chart__column";
      const bars = this.createElement("div");
      bars.className = "paperpet-chart__bars";
      bars.title = `${point.date}: ${formatDuration(point.effectiveSeconds, Zotero.locale)}`;
      const foreground = this.createElement("span");
      foreground.className = "paperpet-chart__foreground";
      foreground.style.height = `${Math.max(2, (point.foregroundSeconds / maximum) * 100)}%`;
      const effective = this.createElement("span");
      effective.className = "paperpet-chart__effective";
      effective.style.height = `${Math.max(2, (point.effectiveSeconds / maximum) * 100)}%`;
      bars.append(foreground, effective);
      const label = this.createElement("span");
      label.className = "paperpet-chart__label";
      label.textContent = shortDate(point.date);
      column.append(bars, label);
      chart.appendChild(column);
    }
    section.appendChild(chart);
    return section;
  }

  private renderRecentItems(data: ReadingOverviewData): HTMLElement {
    const section = this.section(
      this.copy("最近阅读的论文", "Recently read papers"),
    );
    const list = this.createElement("div");
    list.className = "paperpet-paper-list";
    if (data.recentItems.length === 0) {
      list.appendChild(
        this.empty(this.copy("还没有阅读记录", "No reading records yet")),
      );
    }
    for (const item of data.recentItems) {
      const button = this.createElement("button");
      button.type = "button";
      button.className = "paperpet-paper-list__item";
      const title = this.createElement("strong");
      title.textContent = item.title;
      const meta = this.createElement("span");
      meta.textContent = `${formatDuration(item.effectiveSeconds, Zotero.locale)} · ${formatDateTime(item.lastReadAt)}`;
      button.append(title, meta);
      button.addEventListener("click", () => void this.renderItemDetail(item));
      list.appendChild(button);
    }
    section.appendChild(list);
    return section;
  }

  private renderCurrentSession(current?: CurrentSessionSummary): HTMLElement {
    const section = this.section(this.copy("当前会话", "Current session"));
    if (!current) {
      section.appendChild(
        this.empty(this.copy("打开一篇论文开始阅读", "Open a paper to begin")),
      );
      return section;
    }
    const title = this.createElement("strong");
    title.className = "paperpet-current__title";
    title.textContent = current.item.title;
    const time = this.createElement("span");
    time.className = "paperpet-current__time";
    time.textContent = formatDuration(current.effectiveSeconds, Zotero.locale);
    section.append(title, time);
    return section;
  }

  private renderReadingRatio(data: ReadingOverviewData): HTMLElement {
    const section = this.section(this.copy("识别比例", "Recognized ratio"));
    const ratio =
      data.foregroundSeconds > 0
        ? Math.min(1, data.effectiveSeconds / data.foregroundSeconds)
        : 0;
    const row = this.createElement("div");
    row.className = "paperpet-ratio";
    const donut = this.createElement("div");
    donut.className = "paperpet-ratio__donut";
    donut.style.setProperty("--paperpet-ratio", `${ratio * 360}deg`);
    const value = this.createElement("strong");
    value.textContent = `${Math.round(ratio * 100)}%`;
    donut.appendChild(value);
    const explanation = this.createElement("p");
    explanation.textContent = this.copy(
      "有效阅读占前台阅读器时间。它是估计值，不是效率评分。",
      "Effective reading as a share of foreground reader time. This is an estimate, not a score.",
    );
    row.append(donut, explanation);
    section.appendChild(row);
    return section;
  }

  private renderBehaviors(data: ReadingOverviewData): HTMLElement {
    const section = this.section(this.copy("阅读动作", "Reading actions"));
    const maximum = Math.max(
      1,
      ...data.behaviors.map((behavior) => behavior.count),
    );
    const list = this.createElement("div");
    list.className = "paperpet-behaviors";
    for (const behavior of data.behaviors.slice(0, 6)) {
      const row = this.createElement("div");
      const label = this.createElement("span");
      label.textContent = behaviorLabel(behavior.type, Zotero.locale);
      const track = this.createElement("span");
      track.className = "paperpet-behaviors__track";
      const fill = this.createElement("span");
      fill.style.width = `${(behavior.count / maximum) * 100}%`;
      track.appendChild(fill);
      const count = this.createElement("strong");
      count.textContent = String(behavior.count);
      row.append(label, track, count);
      list.appendChild(row);
    }
    if (data.behaviors.length === 0) {
      list.appendChild(
        this.empty(this.copy("暂无动作记录", "No actions recorded")),
      );
    }
    section.appendChild(list);
    return section;
  }

  private renderGrowth(growth: GrowthSnapshot): HTMLElement {
    const section = this.section(this.copy("陪伴成长", "Companion growth"));
    const level = this.createElement("strong");
    level.className = "paperpet-growth__level";
    level.textContent = this.copy(
      `陪伴等级 ${growth.level}`,
      `Companion level ${growth.level}`,
    );
    const summary = this.createElement("p");
    summary.className = "paperpet-dashboard__prose";
    summary.textContent = this.copy(
      `一起读过 ${growth.paperCount} 篇论文 · ${growth.sessionCount} 次会话 · ${growth.annotationCount} 条批注。再积累 ${formatDuration(Math.max(0, growth.nextMilestoneSeconds - growth.effectiveSeconds), Zotero.locale)} 解锁下一阶段。`,
      `${growth.paperCount} papers · ${growth.sessionCount} sessions · ${growth.annotationCount} annotations. ${formatDuration(Math.max(0, growth.nextMilestoneSeconds - growth.effectiveSeconds), Zotero.locale)} to the next stage.`,
    );
    section.append(level, summary);
    return section;
  }

  private renderItemTrend(detail: ItemReadingDetail): HTMLElement {
    return this.renderDailyChart({
      daily: detail.daily.slice(-14),
      behaviors: [],
      recentItems: [],
      foregroundSeconds: detail.item.foregroundSeconds,
      effectiveSeconds: detail.item.effectiveSeconds,
      sessionCount: detail.item.sessionCount,
      paperCount: 1,
    });
  }

  private renderSessionList(detail: ItemReadingDetail): HTMLElement {
    const section = this.section(this.copy("阅读会话", "Reading sessions"));
    const list = this.createElement("div");
    list.className = "paperpet-session-list";
    for (const session of detail.sessions) {
      const row = this.createElement("div");
      const date = this.createElement("span");
      date.textContent = formatDateTime(session.startedAt);
      const time = this.createElement("strong");
      time.textContent = formatDuration(
        session.effectiveSeconds,
        Zotero.locale,
      );
      const annotation = this.createElement("span");
      annotation.textContent = this.copy(
        `${session.annotationCount} 条批注`,
        `${session.annotationCount} annotations`,
      );
      const action = this.createElement("button");
      action.type = "button";
      action.className = "paperpet-session-list__action";
      action.textContent = session.excluded
        ? this.copy("恢复统计", "Include")
        : this.copy("排除", "Exclude");
      action.addEventListener(
        "click",
        () =>
          void this.runAction(() =>
            this.actions.onExcludeSession(session.id, !session.excluded),
          ),
      );
      row.append(date, time, annotation, action);
      list.appendChild(row);
    }
    section.appendChild(list);
    return section;
  }

  private renderItemBehaviors(detail: ItemReadingDetail): HTMLElement {
    const section = this.section(this.copy("明确动作", "Explicit actions"));
    const summary = this.createElement("p");
    summary.className = "paperpet-dashboard__prose";
    summary.textContent = this.copy(
      `${detail.item.annotationCount} 条批注 · ${detail.selectionCount} 次选区 · ${detail.searchCount} 次搜索`,
      `${detail.item.annotationCount} annotations · ${detail.selectionCount} selections · ${detail.searchCount} searches`,
    );
    section.appendChild(summary);
    return section;
  }

  private section(title: string): HTMLElement {
    const section = this.createElement("section");
    section.className = "paperpet-dashboard__section";
    const heading = this.createElement("h2");
    heading.textContent = title;
    section.appendChild(heading);
    return section;
  }

  private empty(message: string): HTMLElement {
    const element = this.createElement("p");
    element.className = "paperpet-dashboard__empty";
    element.textContent = message;
    return element;
  }

  private renderLoading(): void {
    if (!this.root) {
      return;
    }
    const loading = this.createElement("p");
    loading.className = "paperpet-dashboard__loading";
    loading.textContent = this.copy(
      "正在整理阅读记录…",
      "Preparing reading records…",
    );
    this.root.replaceChildren(loading);
  }

  private renderError(error: unknown): void {
    if (!this.root) {
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    Zotero.logError(error instanceof Error ? error : new Error(message));
    const element = this.createElement("p");
    element.className = "paperpet-dashboard__error";
    element.textContent = this.copy(
      `阅读记录暂时无法打开：${message}`,
      `Reading records could not be opened: ${message}`,
    );
    this.root.replaceChildren(element);
  }

  private createElement<K extends keyof HTMLElementTagNameMap>(
    tagName: K,
  ): HTMLElementTagNameMap[K] {
    return this.window.document.createElementNS(
      XHTML_NS,
      tagName,
    ) as unknown as HTMLElementTagNameMap[K];
  }

  private copy(chinese: string, english: string): string {
    return Zotero.locale.startsWith("zh") ? chinese : english;
  }
}

function formatDuration(totalSeconds: number, locale: string): string {
  const minutes = Math.max(0, Math.round(totalSeconds / 60));
  if (minutes < 1) {
    return locale.startsWith("zh") ? "< 1 分钟" : "< 1 min";
  }
  const hours = Math.floor(minutes / 60);
  const remaining = minutes % 60;
  if (hours === 0) {
    return locale.startsWith("zh") ? `${minutes} 分钟` : `${minutes} min`;
  }
  return locale.startsWith("zh")
    ? `${hours} 小时 ${remaining} 分`
    : `${hours}h ${remaining}m`;
}

function shortDate(date: string): string {
  const [, month, day] = date.split("-");
  return `${month}/${day}`;
}

function formatDateTime(timestamp: number): string {
  return new Intl.DateTimeFormat(Zotero.locale, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

function behaviorLabel(type: string, locale: string): string {
  const chinese: Record<string, string> = {
    annotation: "批注",
    "content-click": "内容点击",
    "keyboard-navigation": "键盘翻阅",
    "page-change": "翻页",
    scroll: "滚动段",
    search: "搜索",
    selection: "选区",
    zoom: "缩放",
  };
  const english: Record<string, string> = {
    annotation: "Annotations",
    "content-click": "Content clicks",
    "keyboard-navigation": "Keyboard navigation",
    "page-change": "Page changes",
    scroll: "Scroll segments",
    search: "Searches",
    selection: "Selections",
    zoom: "Zooms",
  };
  return (locale.startsWith("zh") ? chinese : english)[type] ?? type;
}
