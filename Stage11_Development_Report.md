# Translator-plugin Stage11 Development Report

生成日期：2026-07-14

## 1. 本阶段目标

Stage11 的目标是在 Stage10 固定视口浮窗基础上增加用户手动调整浮窗大小的能力。用户划词后，浮窗仍固定在浏览器视口中，但可以通过右下角原生 resize 控制宽度和高度，以便阅读较长的 AI Detail 解释。

本阶段只优化浮窗交互体验，不修改 AI Skill、Provider 协议、Gemini/DeepSeek/百度请求逻辑、`vocabularyEntries` 数据结构、popup 功能或生词本保存逻辑。

## 2. 修改文件

- `content.js`
  - 为浮窗外层增加原生 `resize: both`、尺寸上下限和稳定初始宽度。
  - 将定位时的临时显示方式从 `block` 修正为 `flex`，保证内部弹性布局生效。
  - 增加 `ResizeObserver`，浮窗尺寸变化后自动执行视口边界修正。
  - 增加浮窗内部 `mouseup` 事件隔离，避免 resize 或内部按钮操作被 document 级选词监听误判。
  - 关闭浮窗时断开 resize observer，避免残留监听器。
- `tests/stage11-floating-panel-resize.test.js`
  - 新增 Stage11 静态测试，覆盖 resize CSS、边界修正、事件隔离和请求生命周期保护。
- `tests/stage10-floating-panel-interaction.test.js`
  - 更新 Stage10 对内部滚动区域的静态断言，使其兼容 Stage11 的可调尺寸布局。
- `Stage11_Development_Report.md`
  - 新增本开发报告。

## 3. 技术方案

浮窗继续使用 `position: fixed`，首次出现时仍由选区矩形定位。Stage11 不引入自定义拖拽系统，而是使用浏览器原生 CSS：

```css
resize: both;
min-width: 320px;
min-height: 220px;
max-width: calc(100vw - 24px);
max-height: calc(100vh - 24px);
```

浮窗外层保持 `display: flex; flex-direction: column`。翻译和 AI 分析内容区使用 `flex: 1 1 auto; min-height: 0; overflow: auto`，让用户扩大浮窗后 Detail 内容获得更多可阅读空间。

尺寸变化通过 `ResizeObserver` 观察。观察到尺寸变化后，只调用现有 `keepSelectionPanelInViewport()`，将浮窗夹回视口范围内；不会重读选区、不会重建浮窗、不会取消语言请求。

事件隔离继续复用 `isEventInsideSelectionPanel()` 和 `panelPointerDown`。浮窗内部的 `mousedown`、`mouseup`、`click` 会阻止冒泡，避免原生 resize 产生的鼠标事件进入 document 级 `mouseup` 逻辑并触发 `showPanelForCurrentSelection()`。

## 4. 实现结果

- 划词浮窗支持通过右下角拖拽调整大小。
- 调整大小不会关闭浮窗。
- 调整大小不会创建新的 selection id。
- 调整大小不会发送新的 `TRANSLATE_TEXT`。
- 调整大小不会发送 `CANCEL_LANGUAGE_REQUEST`。
- Detail 请求运行期间调整大小，返回后仍由 Stage9.2/Stage10 的双 ID 生命周期检查决定是否渲染。
- 浮窗扩大后，主要内容区会获得更多阅读空间。
- 浮窗扩大到靠近视口边缘时，会通过现有边界修正逻辑向左或向上回到可见区域。

## 5. 测试结果

已执行并通过：

- `manifest.json` 使用 Node UTF-8 读取并通过 `JSON.parse()`。
- 顶层 JavaScript 文件执行 `node --check`。
- `tests/stage6-interactions-bugfix.test.js`
- `tests/stage7-deepseek-provider-framework.test.js`
- `tests/stage8-skill2-optimization.test.js`
- `tests/stage9-ai-skill-upgrade.test.js`
- `tests/stage9.2-detail-lifecycle.test.js`
- `tests/stage10-floating-panel-interaction.test.js`
- `tests/stage11-floating-panel-resize.test.js`

未执行：

- 真实 Chrome 页面中的人工交互验证。
- LibreOffice 转换、PDF 生成、PNG 渲染、页面视觉检查、表格排版检查、字体检查和 Word 无障碍审计。本阶段按规范不生成 DOCX 报告。

## 6. 架构影响

Stage11 的影响范围仅限 content script 中的浮窗 UI 和事件处理。Provider Framework、AI Skill、Gemini/DeepSeek/百度 API 调用、storage key、词条字段和 popup 行为保持不变。

新增的 `ResizeObserver` 是页面内浮窗实例级资源，会在浮窗关闭时断开，不改变后台 service worker 生命周期。

## 7. 已知限制

- 当前只使用浏览器原生 resize，不实现自定义拖拽手柄。
- 用户调整后的浮窗尺寸不持久化，关闭后下次划词恢复默认尺寸。
- 浮窗位置仍不是自由拖动窗口，只会在选区附近首次定位并在视口内修正。
- 不提供最大化、还原或一键重置尺寸按钮。
- 原生 resize 手柄的视觉表现由浏览器决定，不同系统可能略有差异。

## 8. Chrome 人工验证项

需要在真实 Chrome 中手动验证：

1. 打开普通英文网页，划词后浮窗出现。
2. 拖动浮窗右下角扩大，浮窗不关闭。
3. 拖动浮窗右下角缩小，内容仍可阅读或滚动。
4. 页面滚动后浮窗保持在视口固定位置。
5. 点击“详细解释”，在 Detail 加载过程中调整大小。
6. Detail 返回后正常显示，不出现 `REQUEST_CANCELLED`、`REQUEST_SUPERSEDED` 或 `panel_closed`。
7. 点击浮窗内部按钮不会触发重新划词。
8. 点击浮窗外部仍能关闭。
9. 按 Escape 仍能关闭。
10. 重新划选正文中的其它文本时，旧浮窗被替换，新浮窗正常显示。
