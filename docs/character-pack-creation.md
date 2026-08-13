# 创建 PaperPet 角色包

PaperPet 的角色包是一个扩展名为 `.zpet` 的 ZIP 文件。一个角色包由动作图片和根目录下的 `manifest.json` 组成，不需要编写插件代码。

## 先准备文件夹

先创建这样的目录结构。

```text
my-paperpet/
├── manifest.json
└── assets/
    ├── idle.png
    ├── reading.png
    ├── thinking.png
    └── sleeping.png
```

`idle`、`reading`、`thinking` 和 `sleeping` 是必须提供的四个动作。你还可以加入 `annotating`、`away`、`skimming`、`searching`、`clicked`、`dragged` 和 `uncertain`。动作名使用小写字母开头，只能包含小写字母、数字、下划线和短横线。

当前版本最适合使用一张图片对应一个动作。图片可以是 PNG、APNG 或 WebP，建议使用透明背景，单张图片的宽度和高度不要超过 4096 像素。宠物在 Zotero 中的显示大小由 PaperPet 设置页控制。

## 编写 manifest.json

把下面的内容保存为 `manifest.json`，再按自己的角色修改名称、作者、许可证和图片文件名。

```json
{
  "schemaVersion": 1,
  "id": "org.example.paperpet.my-companion",
  "name": "My PaperPet Companion",
  "version": "0.1.0",
  "author": "Your Name",
  "license": "CC BY-NC 4.0",
  "renderer": "static-image",
  "actions": {
    "idle": { "asset": "assets/idle.png" },
    "reading": { "asset": "assets/reading.png" },
    "thinking": { "asset": "assets/thinking.png" },
    "sleeping": { "asset": "assets/sleeping.png" },
    "annotating": { "asset": "assets/annotating.png" },
    "away": { "asset": "assets/away.png" }
  }
}
```

几个字段需要注意。

| 字段 | 用途 |
| --- | --- |
| `schemaVersion` | 当前固定填写 `1` |
| `id` | 角色包的稳定标识，建议使用自己的反向域名或唯一前缀 |
| `name` | 在安装提示中显示的角色名 |
| `version` | 角色包版本，更新图片后建议递增 |
| `author` | 制作者或素材来源 |
| `license` | 图片和角色的授权说明 |
| `renderer` | 当前建议填写 `static-image` |
| `actions` | 动作名到图片路径的映射 |

`id` 只能包含字母、数字、点、下划线和短横线，且不能以点或短横线开头。`asset` 必须是角色包内部的相对路径，不能写电脑上的绝对路径，也不能使用 `..` 跳出角色包目录。

## 图片和动作的对应关系

PaperPet 会根据阅读状态寻找同名动作。没有提供专用动作时，会按下面的方式回退到相近动作。

| 阅读状态 | 首选动作 | 找不到时的回退 |
| --- | --- | --- |
| 等待阅读 | `idle` | `idle` |
| 正在阅读 | `reading` | `idle` |
| 思考 | `thinking` | `idle` |
| 快速浏览 | `skimming` | `reading`，再回退到 `idle` |
| 批注 | `annotating` | `reading`，再回退到 `idle` |
| 暂离 | `away` | `idle` |
| 睡眠 | `sleeping` | `idle` |

因此，只有四个必需动作也能工作。加入更多状态图片后，角色在阅读过程中的变化会更丰富。

## 打包成 .zpet

打包时要让 `manifest.json` 和 `assets` 位于压缩包根目录。不要把最外层的 `my-paperpet` 文件夹再套一层。

在 macOS 或 Linux 的终端中进入角色包目录后执行。

```bash
cd my-paperpet
zip -r ../my-paperpet.zpet manifest.json assets
```

Windows 可以在角色包目录中使用 PowerShell。

```powershell
Compress-Archive -Path manifest.json,assets -DestinationPath ..\my-paperpet.zpet
```

压缩包中不要放入 `.DS_Store`、`__MACOSX`、脚本、可执行文件或与角色无关的个人文件。PaperPet 会拒绝包含可执行内容、路径穿越、符号链接或重复路径的包。压缩后文件不能超过 50 MB，解压后不能超过 200 MB，文件总数不能超过 1000 个。

## 安装和测试

1. 打开 Zotero 设置中的 PaperPet 页面。
2. 点击“安装角色包”，选择刚刚生成的 `.zpet` 文件。
3. 打开一篇 PDF，滚动、翻页、选区或批注，观察动作是否切换。
4. 回到 PaperPet 设置页调整宠物大小，确认图片在不同尺寸下仍然清晰。

重新安装相同 `id` 和 `version` 的角色包时，PaperPet 会替换已有版本。准备公开分享时，建议先把 `version` 改成新版本，并在说明中写清楚图片来源和授权范围。

## 版权和授权

请只使用自己绘制的图片、明确允许再分发的素材，或已经取得授权的角色。`manifest.json` 中的 `license` 字段只是对素材授权的说明，填写它不会自动获得第三方角色的使用权。公开发布前，也请确认图片、角色名称和音频没有超出授权范围。

完整示例可以参考 [Chiikawa Study Companion](../examples/character-packs/README.md)，机器可读的字段约束见 [角色包 Schema](character-pack.schema.json)。
