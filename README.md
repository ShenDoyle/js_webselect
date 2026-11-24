# 网页元素选择器（Agent Element Inspector）

面向浏览器 Agent 的网页元素侦察工具。人工精准选中元素 → 采集完整 DOM 事实 → 在页面内真实验证多框架定位表达式 → 输出 Agent 可直接使用的信息包。

- 版本：0.0.1
- 作者：左³
- 形态：Tampermonkey 用户脚本 / 书签版

## 特性

- **uBlock Origin 风格取色**：整页压暗 + 目标镂空高亮，单击锁定
- **目标吸附**：单击按钮内的 `<span>/<svg>` 自动吸附到可交互祖先，`Alt` 取最内层并穿透遮挡
- **多框架定位器**：CSS、XPath（相对/绝对/文本）、Playwright（getByRole/getByTestId/getByText）、Selenium，全部在页面内真实验证命中数与目标匹配
- **完整 DOM 事实**：可访问名、角色、状态、样式、几何、滚动、遮挡检测、Shadow DOM 链、iframe 链、相似元素对比
- **语义与视觉摘要**：`inside`（表格列头 / list item / field / dialog）与 `visual`（badge / pill / border / bg）
- **框架组件链**：React / Vue 组件路径与外层源码位置，便于代码型 Agent 定位文件
- **多选与批量**：`Shift+单击` 加入采集列表，按住拖拽框选，逐元素填写指令
- **LLM 提示词**：token 经济的 `Page / selector / locator / inside / react / text / instruction` 格式，一键复制
- **区域截图**：截取选中元素区域并写入剪贴板（Chromium + 安全上下文）
- **撤销与偏好持久化**：`Ctrl/Cmd+Z` 撤销，面板位置、折叠态、分页记忆到 localStorage

## 安装

1. 安装 [Tampermonkey](https://www.tampermonkey.net/)；
2. 新建脚本，粘贴 `agent-element-inspector.user.js` 全部内容并保存；
3. 打开任意网页，`Alt+Shift+E` 显示面板。

书签版：打开 `dist/aei-bookmarklet.html`，把按钮拖到书签栏。

## 使用

| 操作 | 说明 |
| --- | --- |
| `Alt+Shift+E` | 显示 / 隐藏面板 |
| `Alt+Shift+S` | 开始选择 |
| 单击 | 锁定元素 |
| `Shift+单击` | 加入采集列表 |
| 按住拖拽 | 框选批量加入 |
| `Alt` | 穿透遮挡，取最内层元素 |
| `↑ ↓ ← →` | 父级 / 子级 / 兄弟元素 |
| `Esc` | 退出选择模式 |
| `Ctrl/Cmd+C` | 复制 Agent 提示词（面板聚焦或选择模式内） |
| `Ctrl/Cmd+Z` | 撤销 |

面板分页：`Agent 输出`（第一页，含提示词与采集列表）、`元素`、`定位器`、`DOM`、`相似元素`。

## 输出格式

提示词示例：

```
Page: https://example.com/login

1. SubmitButton "登录" <button>
   selector: [data-testid="login-submit"]
   locator: button "登录"
   inside: form
   react: LoginForm › SubmitButton
   source: src/components/SubmitButton.tsx:42
   text: "登录"
   data-testid: login-submit
   visual: rounded, bg rgb(31, 111, 235)
   grade: A
   instruction: 改成主色描边按钮
```

## 已知限制

- 跨域 iframe、封闭 Shadow DOM 受浏览器安全限制无法访问；
- 浏览器不允许在 Shadow DOM 内部求值 XPath，工具会给出说明而非伪造结果；
- Playwright / Selenium 定位结果为页面内语义模拟校验，非真实驱动执行；
- 区域截图需 Chromium 内核与安全上下文，且每次需用户授权共享屏幕。

## 开发

```bash
# 语法检查
node --check agent-element-inspector.user.js

# 构建书签版（输出 dist/aei-bookmarklet.html）
python build_bookmarklet.py
```

验收页：`demo/aei-demo.html`，加载后自动运行 91 项断言，结果写入页面标题与 `#tests`，全通过时标题为 `RESULT-ALL-PASS`。

## 目录

```
agent-element-inspector.user.js   用户脚本主文件
build_bookmarklet.py              书签版构建脚本
demo/aei-demo.html                验收演示页（91 项自检）
dist/aei-bookmarklet.html         书签版产物
```

## License

All Rights Reserved.
