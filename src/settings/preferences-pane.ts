import {
  DEFAULT_PAPERPET_SETTINGS,
  type PaperPetSettings,
} from "./paperpet-settings";
import type { CharacterPackStatus } from "../runtime";

declare const document: Document;

interface PaperPetPreferenceAPI {
  getSettings: () => PaperPetSettings;
  previewSettings: (settings: PaperPetSettings) => void;
  saveSettings: (settings: PaperPetSettings) => Promise<PaperPetSettings>;
  openDashboard: () => Promise<void>;
  installCharacterPack: () => Promise<string | undefined>;
  getCharacterPackStatus: () => CharacterPackStatus;
}

const API_UNAVAILABLE = "PaperPet 设置服务暂不可用，请重启 Zotero 后重试。";

function preferenceAPI(): PaperPetPreferenceAPI | undefined {
  return (Zotero as unknown as { PaperPet?: PaperPetPreferenceAPI }).PaperPet;
}

function renderCharacterPackStatus(api: PaperPetPreferenceAPI): void {
  const statusValue = document.getElementById(
    "paperpet-character-pack-status-value",
  );
  const pathValue = document.getElementById(
    "paperpet-character-pack-path-value",
  );
  const errorValue = document.getElementById(
    "paperpet-character-pack-error-value",
  );
  if (!statusValue || !pathValue || !errorValue) {
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
  errorValue.textContent = packStatus.error || "无";
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

  const commit = (): void => {
    setStatus("正在保存…");
    void api
      .saveSettings(read())
      .then((saved) => {
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
    input.addEventListener("input", () => {
      updateOutput(input);
      api.previewSettings(read());
    });
    input.addEventListener("change", commit);
  }

  document
    .getElementById("paperpet-preferences-reset")
    ?.addEventListener("click", () => {
      api.previewSettings({ ...DEFAULT_PAPERPET_SETTINGS });
      setStatus("正在保存…");
      void api
        .saveSettings({ ...DEFAULT_PAPERPET_SETTINGS })
        .then((saved) => {
          render(saved);
          setStatus("已恢复默认设置");
        })
        .catch((error: unknown) => {
          setStatus("保存失败");
          Zotero.logError(
            error instanceof Error ? error : new Error(String(error)),
          );
        });
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
      setStatus("请选择 .zpet 角色包…");
      void api
        .installCharacterPack()
        .then((message) => {
          if (message) {
            setStatus(message);
            renderCharacterPackStatus(api);
          } else {
            setStatus("已取消安装");
          }
        })
        .catch((error: unknown) => {
          const detail = error instanceof Error ? error.message : String(error);
          setStatus(`角色包安装失败：${detail}`);
          renderCharacterPackStatus(api);
          Zotero.logError(
            error instanceof Error ? error : new Error(String(error)),
          );
        });
    });

  render(api.getSettings());
  renderCharacterPackStatus(api);
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
        }
      }
      init();
    }
  },
  true,
);
init();
