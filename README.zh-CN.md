# dsh-go-work

[![version](https://img.shields.io/badge/version-0.4.0-blue)](package.json)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)

[繁體中文](README.md) | **简体中文** | [English](README.en.md)

供 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 使用的浏览器自动化插件。让 AI 打开真实的 Chrome 窗口、读取页面、点击元素，并把「不准做什么」写成程序判断，而不是提示词。

DSH 内置的 `@playwright/mcp` 已经具备浏览器能力，本插件补上三件事：

1. **规则由程序执行。** 域名策略、密码字段、付款字样、点击次数与时间上限全部由程序判断，不受模型状态影响。
2. **操作过程可见。** 插件自行启动 Chrome，用户能看见它正在做什么，不必经由调试管道连接。
3. **成本可控。** `gw_read` 返回精简的元素列表，不倾倒整页 HTML；截图只在需要时产生。

## 目录

- [功能](#功能)
- [安装](#安装)
- [使用方式](#使用方式)
- [设置](#设置)
- [工具](#工具)
- [安全机制](#安全机制)
- [限制](#限制)
- [开发](#开发)
- [授权](#授权)

## 功能

- **六个工具，覆盖一次完整操作**：开页、读页、操作、截图、取图、收工。
- **域名策略逐步复查**：不只在进入网站时检查，每一个动作落地后都重新比对，包含重定向与新开标签页。
- **凭据与付款保护**：`type=password` 字段与付款、购买、下单字样一律拦截；提交、发送、发布、留言则放行。
- **预算控制**：点击次数与会话时长都有上限，时间到会自动关闭 Chrome。
- **精简读取**：返回互动元素列表与 `ref`，模型用 `ref` 指定目标，不必猜测 CSS 选择器。
- **可读取原图**：页面上的图片与 CSS 背景图会列在 `images` 字段，`gw_image` 可下载原始文件，比截图更清楚也更便宜。
- **生命周期管理**：Chrome 被手动关闭时会自动重建；`gw_done` 或超时都会确实释放资源。

## 安装

目前仅在 Windows 上验证，需要可用的 Chrome 与 DSH 桌面版。

1. 取得源码，放在工作区的 `dsh-go-work` 目录：

   ```powershell
   git clone https://github.com/Udon081112/dsh-go-work.git
   ```

   也可以直接在 GitHub 页面选择 **Code → Download ZIP**，解压后使用。

2. 用目录链接把插件挂进 DSH profile（`<工作区>` 换成实际路径）：

   ```powershell
   cmd /c mklink /J "C:\Users\<用户>\.dsh\profiles\desktop\node_modules\dsh-go-work" "<工作区>\dsh-go-work"
   ```

3. 在 `~/.dsh/profiles/desktop/cordis.patch.yml` 加入插入点：

   ```yaml
   - id: go-work
     name: dsh-go-work
     disabled: false
   ```

4. 重新启动 DSH。宿主端只在启动时加载模块，修改 `lib/` 之后必须重启；设置页属于客户端，刷新页面即可。

5. 确认加载状态：`~/.dsh/go-work.diag.json` 的 `phase` 应为 `ready`，`toolErrors` 应为空。也可以调用 `GET /dsh-go-work/api/ping`，返回同一份诊断信息。

## 使用方式

模型依任务自行选择工具。一次典型的操作流程如下：

```
用户：帮我完成 Kahoot 这一题，代码 123456
模型：（gw_goto kahoot.it）→（gw_read）取得题目与选项
     （gw_act click e3）→ 下一题
     （gw_act steps:[…]）连续完成数步
     （gw_done）回报结果
```

当模型需要自行决定前往何处时，会先搜索一次，再把候选交给用户选择：

```
模型：（gw_goto q="井字棋 在线玩"）
      → 返回前 3 条结果，并显示「打开哪一个？」决策卡
用户：选择第 2 条
模型：（gw_goto url=…）→（gw_read）→（gw_act click e5）…
```

同一个关键词选择过一次之后会记录在 `~/.dsh/go-work.memory.json`（保留 30 天、最多 200 条），下次直接打开，不再搜索也不再询问。

遇到密码字段，或需要按下付款、购买、下单时，工具会返回拦截原因，模型再回头询问用户。插件不会弹出对话框，也不会拦截提交、发送、发布、留言——测验网站每一题都需要提交，拦截后将无法作答。

## 设置

安装完成后，DSH 设置页会多出一个「AI 浏览器」区块；设置存放在 `~/.dsh/go-work.config.json`。

| 设置 | 说明 | 默认值 |
| --- | --- | --- |
| 启用浏览器工具 | 总开关。关闭后六个工具仍然存在，但每个都会返回「已停用」 | 开启 |
| 使用哪个 Chrome | 仅支持干净配置文件：每次另开一个，不带入本机登录状态 | `clean` |
| 域名策略 | 不限制、黑名单、白名单（含子域名） | `off` |
| 域名列表 | 一行一个域名，例如 `bilibili.com`；白名单留空表示全部禁止 | 空 |
| 不准填密码 | 拦截 `type=password` 字段，坐标点击与逐字按键同样拦截 | 开启 |
| 不准碰付款 | 拦截付款、购买、下单类字样；提交、发布、留言一律放行 | 开启 |
| 最多点几次 | 单一会话的点击次数上限 | `200` |
| 最长几分钟 | 时间到会自动关闭 Chrome，不必等下一次调用 | `30` |
| 截图 | 「需要时才截」或「关闭」；关闭后 `gw_shot` 直接拒绝，`gw_image` 不受影响 | `onDemand` |
| 保存位置 | 截图与图片的存放文件夹，默认 `~/.dsh/im/screenshot`；留空则不保存，只返回文件大小 | `~/.dsh/im/screenshot` |

设置页只能投影 `id`、`order`、`label`，没有放置图标的位置，因此 `icon.svg` 仅供其他宿主使用。

## 工具

| 工具 | 用途 |
| --- | --- |
| `gw_goto` | 用 `url` 打开网址（会检查域名策略）；用 `q` 搜索，只返回 3 条候选并显示决策卡 |
| `gw_read` | 读取页面：正文前 1500 字、前 12 个互动元素（附 `ref`）、页面图片列表 |
| `gw_act` | 执行 `click`、`type`、`select`、`press`、`scroll`、`drag`，可用 `steps` 一次完成连续动作 |
| `gw_shot` | 截图并返回文件路径（最后手段） |
| `gw_image` | 下载页面图片的原始文件，之后用 `read_image` 查看 |
| `gw_done` | 关闭 Chrome，回报点击次数与耗时 |

`gw_read` 只返回元素列表，不返回整页 HTML。模型用 `ref` 指定目标，节省 token 也避免点错位置。默认值刻意设得较小（12 个元素、1500 字），需要更多时由调用方自行指定。

### `gw_act` 的调用形式

| 形式 | 用途 |
| --- | --- |
| `{ action:'click', ref:'e3' }` | 一般点击 |
| `{ action:'click', x:420, y:300 }` | canvas 或 iframe 游戏没有 `ref`，改用截图像素坐标（viewport 1:1） |
| `{ action:'type', ref:'e5', text:'123456' }` | 填写文字 |
| `{ action:'select', ref:'e7', text:'台湾' }` | `<select>` 下拉菜单；找不到显示文字时改用 `value` |
| `{ action:'press', key:'Enter' }` | 在目前取得焦点的元素上按键 |
| `{ action:'drag', x:100, y:200, x2:400, y2:200 }` | 排序题、拖放 |
| `{ action:'scroll', dy:600 }` | 滚动页面 |
| `{ steps:[{action:'click',ref:'e1'},{action:'click',ref:'e2',waitMs:500}] }` | 连续动作，最多 30 步 |

密码字段的保护不分入口：用 `ref` 填字、用坐标点击、以及先点进密码字段再逐字按键，都会被拦截。

纯文字能解决的情况不需要截图。Kahoot 的题目、选项与倒计时都是 DOM 文字，`gw_read` 一次约 100 token；截图需要 1000 token 以上，一题只有二十秒，通常来不及。

### 预算与提示

- 同一页面连续 `gw_read` 三次仍未操作，响应会带 `stuck: true`，要求模型立即操作或回报卡住的位置。
- 一次导航之内最多搜索 2 轮；关闭浏览器时预算一并归零，不会残留到下一个任务。

## 安全机制

域名策略有三种模式：`off`（不限制）、`blocklist`（黑名单）、`allowlist`（白名单，含子域名）。

自 0.4.0 起，每个动作之后都会复查落地网址：点击、填字、按键、拖拽、下拉、重定向与新开标签页皆涵盖在内；命中策略即退回原页并回报原因。

唯一的例外是搜索引擎本身。白名单模式下列出的域名不会包含 Bing、DuckDuckGo、Google，若不放行搜索引擎，`gw_goto { q }` 将完全无法使用；用户最后选择的那条网址仍会经过域名策略检查。

需要明确理解以下两点：

- 这是**流程层**的拦截，不是沙箱。它约束插件自己发出的操作，不会限制被打开的网站本身能做什么。
- 只拦截付款、购买、下单与密码字段；其他敏感操作（例如删除账号）不在拦截范围内。

## 限制

- **iframe 内的 DOM 无法读取。** `gw_read` 只读主页面；遇到 iframe（例如 Poki 这类游戏）会在响应中标示 `frames`，并提示改用截图加坐标操作。
- **没有定时截图。** 只有模型主动要求时才截图。
- **一次只有一个浏览器实例。** 多个任务同时需要浏览器时会共用同一个窗口，彼此干扰。
- **新标签页只能被动接管。** 不会主动关闭多余标签页，但最新打开的那一页会被视为当前页面，且同样通过域名策略。
- **不支持既有 Chrome 的登录状态。** 每次都是干净配置文件。

## 开发

不使用 TypeScript，也没有打包流程。

```
package.json          声明 bundle 与 client 的 dsh 字段
cordis.patch.yml      插件插入点
LICENSE               MIT
lib/index.js          宿主端：设置读写、HTTP 路由、工具注册、诊断文件
lib/tools.js          六个工具的定义（零依赖）
lib/browser.js        Chrome 生命周期、ref 表、策略检查、各种动作
lib/client.js         客户端：设置页（手写 React）
test/smoke.mjs        不启动浏览器的结构测试
test/live.mjs         实际打开 Chrome 的端到端测试
```

插件本身没有依赖包，Playwright 是借用既有的安装：

- 在插件目录执行 `npm i playwright`，会装进本地 `node_modules`（最干净的做法）；
- 或使用 DSH 实验性浏览器插件所安装的 `@playwright/mcp`（`~/.dsh/mcp/browser/node_modules/playwright`）；
- 或使用 npm 全局安装的版本；
- 或直接用 `DSH_GO_WORK_PLAYWRIGHT` 指定 playwright 文件夹。

`@playwright/mcp` 是微软的官方包（Apache-2.0），既不是本插件的一部分，也不随 DSH 核心发布；它之所以出现在本机，是因为 DSH 的实验性插件 `@deepseek-ai/dsh-experimental-browser-use-playwright-mcp` 使用它，并在首次执行时安装到 `~/.dsh/mcp/browser`。找不到时，工具会列出搜索过的路径。Chrome 同理，可用 `DSH_GO_WORK_CHROME` 指定。

```bash
npm run check        # 四个文件的语法检查
npm test             # smoke：12 组，不启动浏览器
npm run test:live    # 实际打开一次 Chrome（会弹出窗口，约 5 秒）
```

排查问题时先看 `~/.dsh/go-work.diag.json`：`phase` 停在哪一段，就是哪里出错。`GET /dsh-go-work/api/ping` 会返回同一份诊断信息。

> `test/live.mjs` 需要启动 Chrome 子进程（Playwright 使用 remote-debugging-pipe）。在受限沙箱中会得到 `spawn EPERM`，那是环境限制，不是插件的问题；在正常的 DSH 宿主进程中执行即可。

## 授权

MIT，详见 [LICENSE](LICENSE)。
