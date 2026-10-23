import {
  DashboardRepository,
  type ItemReadingDetail,
  type ReadingOverviewData,
  type RecentReadingItem,
} from "./dashboard-repository";
import type { CurrentSessionSummary } from "../sessions/reading-session-coordinator";
import type { GrowthSnapshot } from "../growth/growth-service";
import type { BackupScope } from "../storage/paperpet-database";
import { NOTE_EDITING_IDLE_SECONDS } from "../model/reading-activity-model";

const XHTML_NS = "http://www.w3.org/1999/xhtml";

export interface DashboardActions {
  onExportBackup: (scope: BackupScope) => Promise<void>;
  onImportBackup: (scope: BackupScope) => Promise<void>;
  onExcludeSession: (sessionID: string, excluded: boolean) => Promise<void>;
  onOpenItem: (item: RecentReadingItem) => Promise<void>;
  onResolveItemTitle: (item: RecentReadingItem) => Promise<string | undefined>;
}

export class DashboardView {
  private tabID?: string;
  private root?: HTMLDivElement;
  private rangeMode: "7" | "30" | "custom" = "30";
  private customStartDate = localDateInput(Date.now() - 29 * 86400000);
  private customEndDate = localDateInput(Date.now());
  private detailItem?: RecentReadingItem;
  private revision = 0;

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
    this.revision++;
    this.root?.remove();
    this.root = undefined;
    this.tabID = undefined;
  }

  private async renderOverview(): Promise<void> {
    if (!this.root) {
      return;
    }
    this.renderLoading();
    this.detailItem = undefined;
    const revision = ++this.revision;
    let data: ReadingOverviewData;
    let growth: GrowthSnapshot;
    try {
      [data, growth] = await Promise.all([
        this.repository.getOverview(this.getRange()),
        this.getGrowth(),
      ]);
    } catch (error) {
      if (revision === this.revision) this.renderError(error);
      return;
    }
    if (!this.root || revision !== this.revision) {
      return;
    }
    await this.resolveItemTitles(data.recentItems);
    if (!this.root || revision !== this.revision) return;
    this.root.replaceChildren();

    const header = this.createHeader(
      this.copy("最近阅读", "Recent reading"),
      this.copy(
        `${data.startDate} 至 ${data.endDate} · 本地数据 · 按会话开始日期统计`,
        `${data.startDate} to ${data.endDate} · Local data · By session start date`,
      ),
    );
    const range = this.createElement("select");
    range.className =
      "paperpet-dashboard__tool paperpet-dashboard__range-select";
    range.setAttribute("aria-label", this.copy("统计时间范围", "Date range"));
    for (const days of [7, 30] as const) {
      const option = this.createElement("option");
      option.value = String(days);
      option.textContent = this.copy(`近 ${days} 天`, `Last ${days} days`);
      option.selected = String(days) === this.rangeMode;
      range.appendChild(option);
    }
    const customOption = this.createElement("option");
    customOption.value = "custom";
    customOption.textContent = this.copy("自定义日期", "Custom dates");
    customOption.selected = this.rangeMode === "custom";
    range.appendChild(customOption);
    range.addEventListener("change", () => {
      if (range.value === "custom") {
        this.rangeMode = "custom";
        this.appendCustomRangeControls(header);
        return;
      }
      this.rangeMode = range.value === "30" ? "30" : "7";
      void this.renderOverview();
    });
    header.querySelector(".paperpet-dashboard__tools")?.prepend(range);
    if (this.rangeMode === "custom") this.appendCustomRangeControls(header);
    const current = this.getCurrentSession();
    const metrics = this.createElement("section");
    metrics.className = "paperpet-dashboard__metrics";
    metrics.append(
      this.metric(
        this.copy("估计阅读时长", "Estimated reading time"),
        formatDuration(data.effectiveSeconds, Zotero.locale),
      ),
      this.metric(
        this.copy("其中笔记编辑", "Of which: note editing"),
        formatDuration(data.noteEditingSeconds, Zotero.locale),
      ),
      this.metric(
        this.copy("阅读器前台时长", "Foreground reader time"),
        formatDuration(data.foregroundSeconds, Zotero.locale),
      ),
      this.metric(this.copy("阅读会话", "Sessions"), String(data.sessionCount)),
      this.metric(this.copy("阅读文献", "Documents"), String(data.paperCount)),
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
      this.renderMethodology(),
      this.renderGrowth(growth),
    );
    main.append(left, aside);
    this.root.append(header, metrics, main);
  }

  private async renderItemDetail(
    item: RecentReadingItem,
    notice?: string,
  ): Promise<void> {
    if (!this.root) {
      return;
    }
    this.renderLoading();
    this.detailItem = item;
    const revision = ++this.revision;
    let detail: ItemReadingDetail;
    try {
      detail = await this.repository.getItemDetail(item);
    } catch (error) {
      if (revision === this.revision) this.renderError(error);
      return;
    }
    if (!this.root || revision !== this.revision) {
      return;
    }
    item = detail.item;
    item.title = (await this.actions.onResolveItemTitle(item)) || item.title;
    this.detailItem = item;
    this.root.replaceChildren();
    const header = this.createHeader(
      item.title,
      this.copy(
        "文献阅读详情 · 全部时间 · 本地数据",
        "Document details · All time · Local data",
      ),
    );
    const back = this.createElement("button");
    back.className = "paperpet-dashboard__back";
    back.type = "button";
    back.textContent = this.copy("返回最近阅读", "Back to recent reading");
    back.addEventListener("click", () => void this.renderOverview());
    header.prepend(back);
    const open = this.createElement("button");
    open.type = "button";
    open.className = "paperpet-dashboard__tool";
    open.textContent = this.copy("继续阅读", "Continue reading");
    open.addEventListener(
      "click",
      () => void this.runAction(() => this.actions.onOpenItem(item)),
    );
    header.querySelector(".paperpet-dashboard__tools")?.prepend(open);

    const metrics = this.createElement("section");
    metrics.className = "paperpet-dashboard__metrics";
    metrics.append(
      this.metric(
        this.copy("累计有效阅读", "Effective reading"),
        formatDuration(item.effectiveSeconds, Zotero.locale),
      ),
      this.metric(
        this.copy("其中笔记编辑", "Of which: note editing"),
        formatDuration(item.noteEditingSeconds, Zotero.locale),
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
    if (notice) {
      const status = this.empty(notice);
      status.setAttribute("role", "status");
      metrics.before(status);
    }
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
    backup.textContent = this.copy("完整备份", "Full backup");
    backup.addEventListener(
      "click",
      () => void this.runAction(() => this.actions.onExportBackup("all")),
    );
    const management = this.createElement("details");
    management.className = "paperpet-data-menu";
    const summary = this.createElement("summary");
    summary.textContent = this.copy("数据管理", "Manage data");
    const menu = this.createElement("div");
    menu.className = "paperpet-data-menu__body";
    menu.append(
      this.empty(
        this.copy(
          "管理全部本地记录，不受日期范围限制。",
          "Manage all local records, regardless of the selected date range.",
        ),
      ),
      backup,
      this.createDataMenuAction(
        this.copy("备份阅读数据", "Back up reading data"),
        () => this.actions.onExportBackup("reading"),
      ),
      this.createDataMenuAction(
        this.copy("备份设置与角色包", "Back up settings and packs"),
        () => this.actions.onExportBackup("settings"),
      ),
      this.createDataMenuAction(
        this.copy("导入阅读数据", "Restore reading data"),
        () => this.actions.onImportBackup("reading"),
      ),
      this.createDataMenuAction(
        this.copy("导入设置与角色包", "Restore settings and packs"),
        () => this.actions.onImportBackup("settings"),
      ),
      this.createDataMenuAction(
        this.copy("导入完整备份", "Restore full backup"),
        () => this.actions.onImportBackup("all"),
      ),
    );
    management.append(summary, menu);
    tools.append(management);
    const refresh = this.createElement("button");
    refresh.type = "button";
    refresh.className = "paperpet-dashboard__tool";
    refresh.textContent = this.copy("刷新数据", "Refresh data");
    refresh.addEventListener("click", () => {
      if (this.detailItem) void this.renderItemDetail(this.detailItem);
      else void this.renderOverview();
    });
    tools.prepend(refresh);
    header.append(copy, tools);
    return header;
  }

  private createDataMenuAction(
    label: string,
    action: () => Promise<void>,
  ): HTMLButtonElement {
    const button = this.createElement("button");
    button.type = "button";
    button.className = "paperpet-dashboard__tool";
    button.textContent = label;
    button.addEventListener("click", () => void this.runAction(action));
    return button;
  }

  private getRange(): number | { startDate: string; endDate: string } {
    if (this.rangeMode === "30") return 30;
    if (this.rangeMode === "custom") {
      return { startDate: this.customStartDate, endDate: this.customEndDate };
    }
    return 7;
  }

  private appendCustomRangeControls(header: HTMLElement): void {
    header.querySelector(".paperpet-custom-range")?.remove();
    const tools = header.querySelector(".paperpet-dashboard__tools");
    if (!tools) return;
    const wrapper = this.createElement("span");
    wrapper.className = "paperpet-custom-range";
    const start = this.createElement("input");
    start.type = "date";
    start.value = this.customStartDate;
    start.setAttribute("aria-label", this.copy("开始日期", "Start date"));
    const end = this.createElement("input");
    end.type = "date";
    end.value = this.customEndDate;
    end.setAttribute("aria-label", this.copy("结束日期", "End date"));
    const apply = this.createElement("button");
    apply.type = "button";
    apply.className = "paperpet-dashboard__tool";
    apply.textContent = this.copy("应用", "Apply");
    apply.addEventListener("click", () => {
      if (!start.value || !end.value) return;
      this.customStartDate = start.value;
      this.customEndDate = end.value;
      void this.renderOverview();
    });
    wrapper.append(start, end, apply);
    tools.prepend(wrapper);
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
    const legend = this.empty(
      this.copy(
        "深色：估计阅读 · 浅色：阅读器前台时间",
        "Solid: estimated reading · Faint: foreground reader time",
      ),
    );
    section.appendChild(legend);
    section.appendChild(this.renderCalendarHeatmap(data));
    if (!data.daily.some((point) => point.foregroundSeconds > 0)) {
      section.appendChild(
        this.empty(
          this.copy(
            "这段时间还没有阅读记录。打开一篇文献开始阅读，记录会显示在这里。",
            "No reading recorded in this period. Open a document to begin.",
          ),
        ),
      );
      return section;
    }
    const chart = this.createElement("div");
    chart.className = "paperpet-chart";
    const maximum = Math.max(
      60,
      ...data.daily.map((point) => point.foregroundSeconds),
    );
    chart.style.gridTemplateColumns = `repeat(${Math.max(1, data.daily.length)}, minmax(24px, 1fr))`;
    section.appendChild(
      this.empty(
        this.copy(
          `刻度：0 — ${formatDuration(maximum, Zotero.locale)}`,
          `Scale: 0 — ${formatDuration(maximum, Zotero.locale)}`,
        ),
      ),
    );
    for (const point of data.daily) {
      const column = this.createElement("div");
      column.className = "paperpet-chart__column";
      const bars = this.createElement("div");
      bars.className = "paperpet-chart__bars";
      bars.title = `${point.date} · ${this.copy("估计阅读", "Estimated reading")}: ${formatDuration(point.effectiveSeconds, Zotero.locale)} · ${this.noteEditingLabel(point.noteEditingSeconds)} · ${this.copy("前台时间", "Foreground time")}: ${formatDuration(point.foregroundSeconds, Zotero.locale)}`;
      bars.tabIndex = 0;
      bars.setAttribute("role", "img");
      bars.setAttribute("aria-label", bars.title);
      const foreground = this.createElement("span");
      foreground.className = "paperpet-chart__foreground";
      foreground.style.height = `${(point.foregroundSeconds / maximum) * 100}%`;
      foreground.hidden = point.foregroundSeconds <= 0;
      const effective = this.createElement("span");
      effective.className = "paperpet-chart__effective";
      effective.style.height = `${(point.effectiveSeconds / maximum) * 100}%`;
      effective.hidden = point.effectiveSeconds <= 0;
      bars.append(foreground, effective);
      const label = this.createElement("span");
      label.className = "paperpet-chart__label";
      label.textContent = shortDate(point.date);
      column.append(bars, label);
      chart.appendChild(column);
    }
    const scroll = this.createElement("div");
    scroll.className = "paperpet-chart-scroll";
    chart.style.minWidth = `${data.daily.length * 42}px`;
    scroll.appendChild(chart);
    section.appendChild(scroll);
    return section;
  }

  private renderCalendarHeatmap(data: ReadingOverviewData): HTMLElement {
    const wrapper = this.createElement("div");
    wrapper.className = "paperpet-heatmap-wrap";
    const label = this.empty(
      this.copy(
        "日历热力图 · 每格代表一天",
        "Calendar heatmap · one cell per day",
      ),
    );
    wrapper.appendChild(label);
    const heatmap = this.createElement("div");
    heatmap.className = "paperpet-heatmap";
    heatmap.style.gridTemplateColumns = `repeat(${Math.max(1, data.daily.length)}, 18px)`;
    const maximum = Math.max(
      60,
      ...data.daily.map((point) => point.effectiveSeconds),
    );
    for (const point of data.daily) {
      const cell = this.createElement("span");
      const intensity =
        point.effectiveSeconds > 0
          ? Math.max(0.12, Math.min(1, point.effectiveSeconds / maximum))
          : 0;
      cell.className = "paperpet-heatmap__cell";
      cell.style.setProperty("--paperpet-heat", String(intensity));
      cell.title = `${point.date} · ${this.copy("有效阅读", "Effective reading")}: ${formatDuration(point.effectiveSeconds, Zotero.locale)} · ${this.noteEditingLabel(point.noteEditingSeconds)}`;
      cell.setAttribute("aria-label", cell.title);
      cell.tabIndex = 0;
      heatmap.appendChild(cell);
    }
    wrapper.appendChild(heatmap);
    return wrapper;
  }

  private renderRecentItems(data: ReadingOverviewData): HTMLElement {
    const section = this.section(
      this.copy("最近阅读的文献", "Recently read documents"),
    );
    const list = this.createElement("div");
    list.className = "paperpet-paper-list";
    if (data.recentItems.length === 0) {
      list.appendChild(
        this.empty(this.copy("还没有阅读记录", "No reading records yet")),
      );
    }
    for (const item of data.recentItems) {
      const row = this.createElement("div");
      row.className = "paperpet-paper-list__item";
      const title = this.createElement("strong");
      title.className = "paperpet-paper-list__title";
      title.textContent =
        item.title ||
        this.copy(
          `文献名称暂不可用（${item.itemKey}）`,
          `Document name unavailable (${item.itemKey})`,
        );
      const meta = this.createElement("span");
      meta.textContent = `${formatDuration(item.effectiveSeconds, Zotero.locale)} · ${formatDateTime(item.lastReadAt)}`;
      if (item.noteEditingSeconds > 0) {
        meta.textContent += ` · ${this.noteEditingLabel(item.noteEditingSeconds)}`;
      }
      const detail = this.createElement("div");
      detail.className = "paperpet-paper-list__detail";
      detail.setAttribute("role", "button");
      detail.tabIndex = 0;
      detail.setAttribute(
        "aria-label",
        item.title || this.copy("打开文献详情", "Open document details"),
      );
      detail.append(title, meta);
      detail.addEventListener("click", () => void this.renderItemDetail(item));
      detail.addEventListener("keydown", (event) => {
        const keyboardEvent = event as KeyboardEvent;
        if (keyboardEvent.key === "Enter" || keyboardEvent.key === " ") {
          keyboardEvent.preventDefault();
          void this.renderItemDetail(item);
        }
      });
      const open = this.createElement("button");
      open.type = "button";
      open.className = "paperpet-dashboard__tool paperpet-paper-list__open";
      open.textContent = this.copy("继续阅读", "Continue");
      open.addEventListener(
        "click",
        () => void this.runAction(() => this.actions.onOpenItem(item)),
      );
      row.append(detail, open);
      list.appendChild(row);
    }
    section.appendChild(list);
    return section;
  }

  private renderCurrentSession(current?: CurrentSessionSummary): HTMLElement {
    const section = this.section(
      this.copy("阅读会话快照", "Reading session snapshot"),
    );
    if (!current) {
      section.appendChild(
        this.empty(this.copy("打开文献或笔记开始阅读", "Open a paper or note to begin")),
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
    if (current.noteEditingSeconds > 0) {
      section.appendChild(
        this.empty(this.noteEditingLabel(current.noteEditingSeconds)),
      );
    }
    section.appendChild(
      this.empty(
        this.copy(
          "此处展示打开或刷新报告时的记录。离开文献或笔记查看报告时，暂停阅读计时。",
          "Recorded when this report was opened or refreshed. Reading time pauses while viewing the report instead of a paper or note.",
        ),
      ),
    );
    return section;
  }

  private renderReadingRatio(data: ReadingOverviewData): HTMLElement {
    const section = this.section(this.copy("识别比例", "Recognized ratio"));
    if (data.foregroundSeconds < 300) {
      section.appendChild(
        this.empty(
          this.copy(
            "累计前台阅读不足 5 分钟，暂不展示比例。阅读时长仍会正常记录。",
            "Less than five minutes of foreground reading; the ratio is hidden. Reading time is still recorded.",
          ),
        ),
      );
      return section;
    }
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

  private renderMethodology(): HTMLElement {
    const section = this.section(
      this.copy("统计说明", "How this is calculated"),
    );
    const details = this.createElement("details");
    details.className = "paperpet-methodology";
    const summary = this.createElement("summary");
    summary.textContent = this.copy("查看计算口径", "View calculation details");
    const body = this.createElement("div");
    body.className = "paperpet-dashboard__prose";
    body.textContent = this.copy(
      "有效阅读时长由前台阅读器或笔记编辑器时间、可见文字采样和翻页、滚动、选区、笔记编辑等信号估算；前台时间包含阅读文献和读写笔记。论文下的笔记归属父文献，独立笔记单独记录；笔记编辑动作不会增加 PDF 批注数。识别比例 = 有效阅读时长 ÷ 前台时间。所有统计均按会话开始日期归档，仅计算未删除且未排除的会话，不代表学习效率评分。",
      "Effective reading is estimated from foreground reader or note-editor time, visible-text samples, navigation, selections, and note edits. Foreground time includes reading papers and reading or writing notes. Child notes belong to their parent paper; standalone notes are tracked separately. Note edits do not increase PDF annotation counts. Recognition ratio = effective reading ÷ foreground time. Reports use the session start date and include only non-deleted, non-excluded sessions; this is not an efficiency score.",
    );
    const noteTiming = this.createElement("p");
    noteTiming.textContent = this.copy(
      `笔记编辑时长是有效阅读的一部分，不重复累加。实际输入、粘贴或格式修改后开始估计，连续 ${NOTE_EDITING_IDLE_SECONDS} 秒没有编辑就暂停；切换内容或离开前台立即暂停，返回后需再次编辑。该时长沿用有效阅读的置信度加权，不代表精确按键时间。仅阅读笔记、选区或自动保存不会启动编辑计时，不保存笔记正文。旧记录未采集此项，显示为零。`,
      `Note editing is part of effective reading, not additional time. Actual input, pasting, or formatting starts the estimate, which pauses after ${NOTE_EDITING_IDLE_SECONDS} seconds without edits, on a source switch, or on focus loss; returning requires a new edit. The same confidence weighting is applied as for effective reading, so this is not exact keystroke time. Reading, selecting text, and autosaves do not start it. Note content is never stored. Older records show zero because this metric was not collected.`,
    );
    body.appendChild(noteTiming);
    details.append(summary, body);
    section.appendChild(details);
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
    const section = this.section(
      this.copy("陪伴成长 · 全部时间", "Companion growth · All time"),
    );
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
    const chart = this.renderDailyChart({
      daily: detail.daily.slice(-14),
      behaviors: [],
      recentItems: [],
      foregroundSeconds: detail.item.foregroundSeconds,
      effectiveSeconds: detail.item.effectiveSeconds,
      noteEditingSeconds: detail.item.noteEditingSeconds,
      sessionCount: detail.item.sessionCount,
      paperCount: 1,
      startDate: detail.daily[0]?.date ?? localDateInput(Date.now()),
      endDate: detail.daily.at(-1)?.date ?? localDateInput(Date.now()),
    });
    chart.querySelector("h2")!.textContent = this.copy(
      "最近 14 个有记录的日期",
      "Last 14 recorded dates",
    );
    return chart;
  }

  private renderSessionList(detail: ItemReadingDetail): HTMLElement {
    const section = this.section(this.copy("阅读会话", "Reading sessions"));
    const list = this.createElement("div");
    list.className = "paperpet-session-list";
    section.appendChild(
      this.empty(
        this.copy(
          "最近 50 次会话；已排除的会话不计入累计统计。",
          "Latest 50 sessions; excluded sessions do not count toward totals.",
        ),
      ),
    );
    for (const session of detail.sessions) {
      const row = this.createElement("div");
      row.dataset.excluded = String(session.excluded);
      const date = this.createElement("span");
      date.textContent = formatDateTime(session.startedAt);
      const time = this.createElement("strong");
      time.textContent = formatDuration(
        session.effectiveSeconds,
        Zotero.locale,
      );
      const annotation = this.createElement("span");
      annotation.textContent =
        (session.excluded ? this.copy("已排除 · ", "Excluded · ") : "") +
        this.copy(
          `${session.annotationCount} 条批注`,
          `${session.annotationCount} annotations`,
        );
      if (session.noteEditingSeconds > 0) {
        const editing = this.createElement("span");
        editing.className = "paperpet-session-list__note-editing";
        editing.textContent = this.noteEditingLabel(session.noteEditingSeconds);
        annotation.appendChild(editing);
      }
      const action = this.createElement("button");
      action.type = "button";
      action.className = "paperpet-session-list__action";
      action.textContent = session.excluded
        ? this.copy("恢复统计", "Include")
        : this.copy("排除", "Exclude");
      action.addEventListener("click", async () => {
        action.disabled = true;
        try {
          await this.actions.onExcludeSession(session.id, !session.excluded);
          await this.renderItemDetail(
            detail.item,
            session.excluded
              ? this.copy("已恢复此会话的统计。", "Session included again.")
              : this.copy(
                  "已排除此会话，可随时恢复统计。",
                  "Session excluded; you can include it again anytime.",
                ),
          );
        } catch (error) {
          action.disabled = false;
          const message = this.empty(String(error));
          message.setAttribute("role", "alert");
          section.appendChild(message);
        }
      });
      row.append(date, time, annotation, action);
      list.appendChild(row);
    }
    section.appendChild(list);
    return section;
  }

  private noteEditingLabel(seconds: number): string {
    const duration = formatDuration(seconds, Zotero.locale);
    return this.copy(
      `其中笔记编辑 ${duration}`,
      `Incl. ${duration} editing notes`,
    );
  }

  private async resolveItemTitles(items: RecentReadingItem[]): Promise<void> {
    await Promise.all(
      items.map(async (item) => {
        try {
          const title = await this.actions.onResolveItemTitle(item);
          if (title) item.title = title;
        } catch (error) {
          Zotero.logError(
            error instanceof Error ? error : new Error(String(error)),
          );
        }
      }),
    );
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

export function formatDuration(totalSeconds: number, locale: string): string {
  const seconds = Number.isFinite(totalSeconds)
    ? Math.max(0, Math.floor(totalSeconds))
    : 0;
  if (seconds < 60) {
    return locale.startsWith("zh") ? `${seconds} 秒` : `${seconds} sec`;
  }
  const minutes = Math.floor(seconds / 60);
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

function localDateInput(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
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
    "note-edit": "笔记编辑",
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
    "note-edit": "Note edits",
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
