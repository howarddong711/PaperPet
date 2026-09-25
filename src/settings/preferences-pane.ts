import {
  DEFAULT_PAPERPET_SETTINGS,
  normalizePaperPetSettings,
  type PaperPetSettings,
} from "./paperpet-settings";
import type { CharacterPackStatus, PaperPetDiagnostics } from "../runtime";
import type { InstalledCharacterPackRecord } from "../storage/paperpet-database";

declare const document: Document;

interface PaperPetPreferenceAPI {
  getSettings: () => PaperPetSettings;
  previewSettings: (settings: PaperPetSettings) => void;
  saveSettings: (settings: PaperPetSettings) => Promise<PaperPetSettings>;
  openDashboard: () => Promise<void>;
  installCharacterPack: () => Promise<string | undefined>;
  getCharacterPacks: () => Promise<InstalledCharacterPackRecord[]>;
  enableCharacterPack: (packID: string) => Promise<void>;
  disableCharacterPack: () => Promise<void>;
  removeCharacterPack: (packID: string) => Promise<void>;
  getCharacterPackStatus: () => CharacterPackStatus;
  getPreviewURL: (
    mode: "idle" | "reading" | "thinking" | "annotating" | "sleeping" | "away",
  ) => string;
  resetPetPosition: () => void;
  getDiagnostics: () => PaperPetDiagnostics;
}

const PREVIEW_MODES = [
  "idle",
  "reading",
  "thinking",
  "annotating",
  "sleeping",
  "away",
] as const;

const API_UNAVAILABLE = "PaperPet 设置服务暂不可用，请重启 Zotero 后重试。";

function preferenceAPI(): PaperPetPreferenceAPI | undefined {
  return (Zotero as unknown as { PaperPet?: PaperPetPreferenceAPI }).PaperPet;
}

function refreshPreviewSources(api: PaperPetPreferenceAPI): void {
  for (const mode of PREVIEW_MODES) {
    const preview = document.getElementById(
      `paperpet-preview-${mode}`,
    ) as HTMLImageElement | null;
    if (!preview) continue;
    const url = api.getPreviewURL(mode);
    if (preview.getAttribute("src") !== url) preview.src = url;
  }
}

function renderCharacterPackStatus(api: PaperPetPreferenceAPI): void {
  const statusValue = document.getElementById(
    "paperpet-character-pack-status-value",
  );
  const pathValue = document.getElementById(
    "paperpet-character-pack-path-value",
  );
  const archivePathValue = document.getElementById(
    "paperpet-character-pack-archive-path-value",
  );
  const errorValue = document.getElementById(
    "paperpet-character-pack-error-value",
  );
  if (!statusValue || !pathValue || !archivePathValue || !errorValue) {
    return;
  }
  const packStatus = api.getCharacterPackStatus();
  const labels: Record<CharacterPackStatus["state"], string> = {
    loading: "正在检查角色包…",
    loaded: `已加载${packStatus.name ? `：${packStatus.name}` : ""}${packStatus.version ? `（${packStatus.version}）` : ""}`,
    default: "未加载角色包，当前使用默认角色",
    error: "角色包加载失败，当前使用默认角色",
  };
  statusValue.textContent = labels[packStatus.state];
  pathValue.textContent = packStatus.installPath || "未记录安装路径";
  archivePathValue.textContent = packStatus.archivePath || "未记录源文件路径";
  errorValue.textContent = packStatus.error || "无";
  const diagnostics = document.getElementById(
    "paperpet-pack-diagnostics",
  ) as HTMLDetailsElement | null;
  if (diagnostics) {
    diagnostics.dataset.hasError = String(Boolean(packStatus.error));
    if (packStatus.state === "error") diagnostics.open = true;
  }
}

function renderDiagnostics(api: PaperPetPreferenceAPI): void {
  const diagnostics = api.getDiagnostics();
  const event = document.getElementById("paperpet-diagnostic-event");
  const eventAt = document.getElementById("paperpet-diagnostic-event-at");
  const lookup = document.getElementById("paperpet-diagnostic-title-lookup");
  const result = document.getElementById("paperpet-diagnostic-title-result");
  if (event) event.textContent = diagnostics.lastEvent;
  if (eventAt)
    eventAt.textContent = diagnostics.lastEventAt
      ? new Date(diagnostics.lastEventAt).toLocaleString()
      : "无";
  if (lookup) lookup.textContent = diagnostics.lastTitleLookup;
  if (result) result.textContent = diagnostics.lastTitleResult;
}

async function renderCharacterPackManager(
  api: PaperPetPreferenceAPI,
  root: HTMLElement,
  setStatus: (message: string) => void,
  refreshPreview?: () => void,
): Promise<void> {
  const host = root.querySelector<HTMLElement>(
    "#paperpet-character-pack-manager",
  );
  if (!host) return;
  host.replaceChildren();
  try {
    const packs = await api.getCharacterPacks();
    if (packs.length === 0) {
      host.textContent = "尚未安装其他角色包";
      return;
    }
    for (const pack of packs) {
      const row = document.createElementNS(
        "http://www.w3.org/1999/xhtml",
        "div",
      ) as HTMLDivElement;
      row.className = "paperpet-pack-manager__row";
      const label = document.createElementNS(
        "http://www.w3.org/1999/xhtml",
        "span",
      );
      label.textContent = `${pack.name} · ${pack.version}${pack.enabled ? " · 已启用" : ""}`;
      const actions = document.createElementNS(
        "http://www.w3.org/1999/xhtml",
        "span",
      );
      actions.className = "paperpet-pack-manager__actions";
      const toggle = document.createElementNS(
        "http://www.w3.org/1999/xhtml",
        "button",
      ) as HTMLButtonElement;
      toggle.type = "button";
      toggle.textContent = pack.enabled ? "停用" : "启用";
      toggle.addEventListener("click", () => {
        toggle.disabled = true;
        void (
          pack.enabled
            ? api.disableCharacterPack()
            : api.enableCharacterPack(pack.packID)
        )
          .then(() => {
            setStatus(pack.enabled ? "已停用角色包" : "已启用角色包");
            renderCharacterPackStatus(api);
            refreshPreview?.();
            return renderCharacterPackManager(
              api,
              root,
              setStatus,
              refreshPreview,
            );
          })
          .catch((error: unknown) => {
            toggle.disabled = false;
            setStatus(
              `角色包操作失败：${error instanceof Error ? error.message : String(error)}`,
            );
          });
      });
      const remove = document.createElementNS(
        "http://www.w3.org/1999/xhtml",
        "button",
      ) as HTMLButtonElement;
      remove.type = "button";
      remove.textContent = "删除";
      remove.disabled = pack.enabled;
      remove.addEventListener("click", () => {
        if (!document.defaultView?.confirm(`删除角色包“${pack.name}”？`))
          return;
        remove.disabled = true;
        void api
          .removeCharacterPack(pack.packID)
          .then(() => {
            setStatus("角色包已删除");
            return renderCharacterPackManager(api, root, setStatus);
          })
          .catch((error: unknown) => {
            remove.disabled = false;
            setStatus(
              `删除角色包失败：${error instanceof Error ? error.message : String(error)}`,
            );
          });
      });
      actions.append(toggle, remove);
      row.append(label, actions);
      host.appendChild(row);
    }
  } catch (error) {
    host.textContent = `无法读取角色包列表：${error instanceof Error ? error.message : String(error)}`;
  }
}

function init(): void {
  const root = document.getElementById(
    "paperpet-preferences",
  ) as HTMLElement | null;
  if (!root || root.dataset.initialized === "true") {
    return;
  }
  root.dataset.initialized = "true";

  const status = document.getElementById("paperpet-preferences-status");
  const api = preferenceAPI();
  if (!api) {
    if (status) {
      status.textContent = API_UNAVAILABLE;
    }
    return;
  }

  const setStatus = (message: string): void => {
    if (status) {
      status.textContent = message;
    }
  };

  const packSection = root.querySelector(".paperpet-preferences__pack-status");
  const grid = root.querySelector(".paperpet-preferences__grid");
  if (packSection && grid) grid.before(packSection);
  const tools = root.querySelector(".paperpet-preferences__tools");
  if (tools && packSection) packSection.appendChild(tools);
  const updatePreview = (settings: PaperPetSettings): void => {
    refreshPreviewSources(api);
    for (const mode of PREVIEW_MODES) {
      const preview = document.getElementById(
        `paperpet-preview-${mode}`,
      ) as HTMLImageElement | null;
      if (!preview) continue;
      const previewSize = Math.min(88, Math.max(44, settings.petSize * 0.45));
      preview.style.width = `${previewSize}px`;
      preview.style.height = `${previewSize}px`;
      preview.style.opacity = String(settings.petOpacity / 100);
    }
    document.getElementById("paperpet-preview-size")!.textContent =
      `实际尺寸 ${settings.petSize}px · 透明度 ${settings.petOpacity}%`;
    for (const key of ["personalWordsPerMinute", "defaultExpectedSeconds"]) {
      const control = root.querySelector<HTMLInputElement>(
        `input[data-setting="${key}"]`,
      );
      if (control) {
        control.disabled = !settings.trackingEnabled;
        const number = document.getElementById(
          `${control.id}-number`,
        ) as HTMLInputElement | null;
        if (number) number.disabled = control.disabled;
      }
    }
  };

  const render = (settings: PaperPetSettings): void => {
    for (const input of root.querySelectorAll<HTMLInputElement>(
      "input[data-setting]",
    )) {
      const key = input.dataset.setting as keyof PaperPetSettings | undefined;
      if (!key) {
        continue;
      }
      if (input.type === "checkbox") {
        input.checked = Boolean(settings[key]);
      } else {
        input.value = String(settings[key]);
      }
      updateOutput(input);
    }
    updatePreview(settings);
  };

  const read = (): PaperPetSettings => {
    const settings = { ...api.getSettings() };
    for (const input of root.querySelectorAll<HTMLInputElement>(
      "input[data-setting]",
    )) {
      const key = input.dataset.setting as keyof PaperPetSettings | undefined;
      if (!key) {
        continue;
      }
      (settings as unknown as Record<string, number | boolean>)[key] =
        input.type === "checkbox"
          ? input.checked
          : Number.parseFloat(input.value);
    }
    return settings;
  };

  let saveQueue: Promise<unknown> = Promise.resolve();
  let saveRevision = 0;
  const commit = (): void => {
    const candidate = normalizePaperPetSettings(read());
    const revision = ++saveRevision;
    setStatus("正在保存…");
    saveQueue = saveQueue
      .catch(() => undefined)
      .then(() => api.saveSettings(candidate))
      .then((saved) => {
        if (revision !== saveRevision) return;
        render(saved);
        setStatus("已保存到本机");
      })
      .catch((error: unknown) => {
        setStatus("保存失败");
        Zotero.logError(
          error instanceof Error ? error : new Error(String(error)),
        );
      });
  };

  for (const input of root.querySelectorAll<HTMLInputElement>(
    "input[data-setting]",
  )) {
    if (input.type === "range") {
      const number = document.createElementNS(
        "http://www.w3.org/1999/xhtml",
        "input",
      ) as HTMLInputElement;
      number.type = "number";
      number.id = `${input.id}-number`;
      number.className = "paperpet-number";
      number.min = input.min;
      number.max = input.max;
      number.step = input.step;
      number.setAttribute(
        "aria-label",
        `${input.closest("label")?.querySelector("span")?.textContent ?? "数值"}（精确输入）`,
      );
      const output = document.getElementById(`${input.id}-value`);
      output?.before(number);
      number.addEventListener("input", () => {
        if (!number.validity.valid || number.value === "") return;
        input.value = number.value;
        updateOutput(input);
        api.previewSettings(read());
        updatePreview(read());
      });
      number.addEventListener("change", () => {
        if (!number.validity.valid || number.value === "") {
          number.reportValidity();
          number.value = input.value;
          return;
        }
        input.value = number.value;
        commit();
      });
    }
    input.addEventListener("input", () => {
      updateOutput(input);
      api.previewSettings(read());
      updatePreview(read());
    });
    input.addEventListener("change", commit);
  }

  document
    .getElementById("paperpet-preferences-reset")
    ?.addEventListener("click", () => {
      if (
        !document.defaultView?.confirm(
          "恢复全部默认设置？你的阅读记录和角色包不会被删除。",
        )
      )
        return;
      render({ ...DEFAULT_PAPERPET_SETTINGS });
      api.previewSettings(read());
      commit();
    });

  document
    .getElementById("paperpet-open-report")
    ?.addEventListener("click", () => {
      setStatus("正在打开阅读报告…");
      void api
        .openDashboard()
        .then(() => setStatus("阅读报告已打开"))
        .catch((error: unknown) => {
          setStatus("打开报告失败");
          Zotero.logError(
            error instanceof Error ? error : new Error(String(error)),
          );
        });
    });

  document
    .getElementById("paperpet-install-pack")
    ?.addEventListener("click", () => {
      setStatus("请选择要添加的 .zpet 角色包…");
      void api
        .installCharacterPack()
        .then((message) => {
          if (message) {
            setStatus(message);
            renderCharacterPackStatus(api);
            void renderCharacterPackManager(api, root, setStatus, () =>
              updatePreview(read()),
            );
            updatePreview(read());
          } else {
            setStatus("已取消安装");
          }
        })
        .catch((error: unknown) => {
          const detail = error instanceof Error ? error.message : String(error);
          setStatus(`角色包安装失败：${detail}`);
          renderCharacterPackStatus(api);
          void renderCharacterPackManager(api, root, setStatus, () =>
            updatePreview(read()),
          );
          Zotero.logError(
            error instanceof Error ? error : new Error(String(error)),
          );
        });
    });

  render(api.getSettings());
  renderCharacterPackStatus(api);
  renderDiagnostics(api);
  void renderCharacterPackManager(api, root, setStatus, () =>
    updatePreview(read()),
  );
  document
    .getElementById("paperpet-reset-position")
    ?.addEventListener("click", () => {
      api.resetPetPosition();
      setStatus("宠物已回到窗口右下角");
    });
  document
    .getElementById("paperpet-refresh-diagnostics")
    ?.addEventListener("click", () => {
      renderDiagnostics(api);
      setStatus("诊断信息已刷新");
    });
  const preferenceSections = Array.from(
    root.querySelectorAll(
      ".paperpet-preferences__grid > .paperpet-preferences__section",
    ),
  ) as HTMLElement[];
  for (const section of preferenceSections) {
    const reset = document.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "button",
    ) as HTMLButtonElement;
    reset.type = "button";
    reset.className = "paperpet-group-reset";
    reset.textContent = "恢复本组默认值";
    reset.addEventListener("click", () => {
      const settings = read();
      const controls = Array.from(
        section.querySelectorAll("input[data-setting]"),
      ) as HTMLInputElement[];
      for (const control of controls) {
        const key = control.dataset.setting as keyof PaperPetSettings;
        (settings as unknown as Record<string, number | boolean>)[key] =
          DEFAULT_PAPERPET_SETTINGS[key];
      }
      render(settings);
      api.previewSettings(settings);
      commit();
    });
    section.appendChild(reset);
  }
}

function updateOutput(input: HTMLInputElement): void {
  const output = document.getElementById(`${input.id}-value`);
  if (!output) {
    return;
  }
  const suffix: Record<string, string> = {
    "paperpet-pet-size": "px",
    "paperpet-pet-opacity": "%",
    "paperpet-drag-threshold": "px",
    "paperpet-double-click-delay": "ms",
    "paperpet-wpm": " 字/分",
    "paperpet-default-dwell": " 秒",
    "paperpet-sleep-delay": " 秒",
    "paperpet-retention": " 天",
  };
  output.textContent = `${input.value}${suffix[input.id] ?? ""}`;
  const number = document.getElementById(
    `${input.id}-number`,
  ) as HTMLInputElement | null;
  if (number && document.activeElement !== number) number.value = input.value;
}

document.addEventListener(
  "showing",
  (event: Event) => {
    const target = event.target as HTMLElement | null;
    if (target?.id === "paperpet-preferences") {
      if (target.dataset.initialized === "true") {
        const api = preferenceAPI();
        if (api) {
          renderCharacterPackStatus(api);
          renderDiagnostics(api);
          refreshPreviewSources(api);
        }
      }
      init();
    }
  },
  true,
);
init();
