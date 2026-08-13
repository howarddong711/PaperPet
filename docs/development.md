# PaperPet 开发指南

## 技术基线

- Zotero 9
- WebExtension 风格 `manifest.json`
- Bootstrapped plugin 生命周期
- TypeScript
- `zotero-plugin-scaffold`
- `zotero-types`

首个原型没有引入 UI 框架和 Zotero Plugin Toolkit。当前覆盖层只需要少量 DOM 生命周期代码，保持依赖最小更容易验证 Zotero 9 兼容性；当数据页和复杂 Zotero 控件开始实现时，再根据实际 API 需求评估工具包。

## 环境要求

- Node.js 22.12 或更高版本
- Zotero 9
- 独立的 Zotero 开发配置目录

不要使用日常 Zotero 配置目录运行开发服务器，避免测试插件影响真实文献库。

## 安装依赖

```bash
npm install
```

## 构建

```bash
npm run build
```

构建过程会：

1. 复制 `addon` 静态文件。
2. 把 `src/index.ts` 打包为 Zotero 沙箱脚本。
3. 生成 `.scaffold/build/paperpet.xpi`。
4. 执行 TypeScript 类型检查。

## 开发服务器

复制环境变量示例：

```bash
cp .env.example .env
```

填写 Zotero 可执行文件和开发配置目录后运行：

```bash
npm start
```

## 当前原型

插件启动后会在 Zotero 窗口右下角添加一个纸页形测试伙伴：

- 可以拖动
- 根据阅读、思考、快速浏览、批注、暂离和睡眠状态改变姿态
- 单击显示当前状态和本次估计有效阅读时间
- 设置页中的“打开阅读报告”进入阅读记录页，宠物本身不提供右键菜单
- 支持浅色、深色和减少动态效果
- 禁用或卸载插件时会删除 DOM、样式和事件监听器

阅读模型采用 1 Hz 主循环、前台硬门控、强弱信号分层和视口文本量自适应衰减。鼠标移动只能轻微维持已经存在的置信度，不能单独创建阅读时间。PDF 文本仅在强交互后按需采样，不缓存整篇文档。

PaperPet 数据保存在 Zotero 数据目录下的 `paperpet/paperpet.sqlite`。数据库使用 WAL、外键和版本化迁移；会话及每日/论文聚合长期保留，合并后的语义事件默认保留 90 天。开发和测试时必须使用隔离数据目录。

声明式角色包的运行时校验器、JSON Schema、`.zpet` 安装器和测试角色资源已加入项目，包含四个必需动作、标准降级链、路径穿越与可执行文件拦截，以及包体、解压体积、文件数、图片尺寸和帧率预算。正式角色美术仍未设计，用户可以在框架上继续扩展资源包。

阅读记录页提供最近七天的有效/前台阅读图表、当前会话、阅读动作、单篇论文详情和轻量陪伴成长摘要。数据页可导出或导入版本化 JSON 备份、清空 PaperPet 记录，并对单次会话执行排除/恢复；这些操作不会删除 Zotero 文献、PDF 或 Zotero 批注。

Zotero 的“设置”窗口左侧会显示独立的 PaperPet 页面；角色包安装、阅读报告和设置都从这里进入。外观设置包括尺寸、透明度和减少动态效果；交互设置包括拖动阈值与双击等待时间；阅读设置包括是否记录、估计阅读速度、无文本页面默认停留和睡眠延迟；详细语义事件保留天数也可调整。设置保存在同一套本地 SQLite `settings` 表中，并实时同步到全部 Zotero 窗口。

宠物手势统一使用 Pointer Events 和 pointer capture。短按延迟到双击窗口结束后才触发单击反馈；移动距离达到设置阈值后，本次手势只视为拖动，不再触发点击。右键不再打开菜单。

## 质量检查

```bash
npm run lint
npm test
npm run typecheck
npm run build
npm audit --audit-level=high
```

这不是最终角色设计，也不会进入正式角色包。它只用于验证全窗口覆盖层和插件生命周期。

## 发布身份

公开插件 ID 固定为 `paperpet@howarddong711.github.io`，更新清单由仓库根目录的 `update.json` 提供。插件 ID 已用于公开发布，后续版本不得更改。

## 参考

- Zotero 插件开发文档  
  https://www.zotero.org/support/dev/client_coding/plugin_development
- Zotero bootstrapped 插件迁移说明  
  https://www.zotero.org/support/dev/zotero_7_for_developers
- Zotero 官方示例插件  
  https://github.com/zotero/make-it-red
- Zotero Plugin Scaffold  
  https://github.com/zotero-plugin-dev/zotero-plugin-scaffold
