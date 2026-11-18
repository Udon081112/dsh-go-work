# dsh-go-work

[![version](https://img.shields.io/badge/version-0.4.0-blue)](package.json)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)

**繁體中文** | [简体中文](README.zh-CN.md) | [English](README.en.md)

供 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 使用的瀏覽器自動化外掛。讓 AI 開啟真實的 Chrome 視窗、讀取頁面、點擊元素，並把「不准做什麼」寫成程式判斷，而不是提示詞。

DSH 內建的 `@playwright/mcp` 已經具備瀏覽器能力，本外掛補上三件事：

1. **規則由程式執行。** 網域政策、密碼欄位、付款字樣、點擊次數與時間上限皆為程式判斷，不受模型狀態影響。
2. **操作過程可見。** 外掛自行啟動 Chrome，使用者能看見它正在做什麼，不必經由除錯管線連線。
3. **成本可控。** `gw_read` 回傳精簡的元素清單，不傾倒整頁 HTML；截圖只在需要時產生。

## 目錄

- [功能](#功能)
- [安裝](#安裝)
- [使用方式](#使用方式)
- [設定](#設定)
- [工具](#工具)
- [安全機制](#安全機制)
- [限制](#限制)
- [開發](#開發)
- [授權](#授權)

## 功能

- **六個工具，涵蓋一次完整操作**：開頁、讀頁、操作、截圖、取圖、收工。
- **網域政策逐步複查**：不只進入網站時檢查，每一個動作落地後都重新比對，包含重新導向與新開分頁。
- **憑證與付款保護**：`type=password` 欄位與付款、購買、下單字樣一律攔截；提交、送出、發佈、留言則放行。
- **預算控制**：點擊次數與工作階段時間皆有上限，時間到會自動關閉 Chrome。
- **精簡讀取**：回傳互動元素清單與 `ref`，模型以 `ref` 指定目標，不必猜測 CSS 選擇器。
- **可讀取原圖**：頁面上的圖片與 CSS 背景圖會列在 `images` 欄位，`gw_image` 可下載原始檔，比截圖更清楚也更便宜。
- **生命週期管理**：Chrome 被手動關閉時會自動重建；`gw_done` 或逾時都會確實釋放資源。

## 安裝

目前僅在 Windows 上驗證，需要可用的 Chrome 與 DSH 桌面版。

1. 取得原始碼，放在工作區的 `dsh-go-work` 目錄：

   ```powershell
   git clone https://github.com/Udon081112/dsh-go-work.git
   ```

   也可以直接在 GitHub 頁面選擇 **Code → Download ZIP**，解壓後使用。

2. 以目錄連結把外掛掛入 DSH profile（`<工作區>` 換成實際路徑）：

   ```powershell
   cmd /c mklink /J "C:\Users\<使用者>\.dsh\profiles\desktop\node_modules\dsh-go-work" "<工作區>\dsh-go-work"
   ```

3. 在 `~/.dsh/profiles/desktop/cordis.patch.yml` 加入插入點：

   ```yaml
   - id: go-work
     name: dsh-go-work
     disabled: false
   ```

4. 重新啟動 DSH。宿主端只在啟動時載入模組，修改 `lib/` 之後必須重啟；設定頁屬於客戶端，重新整理頁面即可。

5. 確認載入狀態：`~/.dsh/go-work.diag.json` 的 `phase` 應為 `ready`，`toolErrors` 應為空。也可以呼叫 `GET /dsh-go-work/api/ping`，回傳同一份診斷資訊。

## 使用方式

模型依任務自行選擇工具。一次典型的操作流程如下：

```
使用者：幫我完成 Kahoot 這一題，代碼 123456
模型：（gw_goto kahoot.it）→（gw_read）取得題目與選項
     （gw_act click e3）→ 下一題
     （gw_act steps:[…]）連續完成數步
     （gw_done）回報結果
```

當模型需要自行決定前往何處時，會先搜尋一次，再把候選交給使用者選擇：

```
模型：（gw_goto q="井字棋 線上玩"）
       → 回傳前 3 條結果，並顯示「開哪一個？」決策卡
使用者：選擇第 2 條
模型：（gw_goto url=…）→（gw_read）→（gw_act click e5）…
```

同一個關鍵字選擇過一次之後會記錄在 `~/.dsh/go-work.memory.json`（保留 30 天、最多 200 筆），下次直接開啟，不再搜尋也不再詢問。

遇到密碼欄位，或需要按下付款、購買、下單時，工具會回傳攔截原因，模型再回頭詢問使用者。外掛不會跳出對話框，也不會攔截提交、送出、發佈、留言——測驗網站每一題都需要提交，攔截後將無法作答。

## 設定

安裝完成後，DSH 設定頁會多出一個「AI 瀏覽器」區塊；設定存放在 `~/.dsh/go-work.config.json`。

| 設定 | 說明 | 預設值 |
| --- | --- | --- |
| 啟用瀏覽器工具 | 總開關。關閉後六個工具仍然存在，但每個都會回傳「已停用」 | 開啟 |
| 使用哪個 Chrome | 僅支援乾淨設定檔：每次另開一個，不帶入本機登入狀態 | `clean` |
| 網域政策 | 不限制、黑名單、白名單（含子網域） | `off` |
| 網域清單 | 一行一個網域，例如 `bilibili.com`；白名單留空表示全部禁止 | 空 |
| 不准填密碼 | 攔截 `type=password` 欄位，座標點擊與逐字按鍵同樣攔截 | 開啟 |
| 不准碰付款 | 攔截付款、購買、下單類字樣；提交、發佈、留言一律放行 | 開啟 |
| 最多點幾次 | 單一工作階段的點擊次數上限 | `200` |
| 最長幾分鐘 | 時間到會自動關閉 Chrome，不必等下一次呼叫 | `30` |
| 截圖 | 「需要時才截」或「關閉」；關閉後 `gw_shot` 直接拒絕，`gw_image` 不受影響 | `onDemand` |
| 儲存位置 | 截圖與圖片的存放資料夾，預設 `~/.dsh/im/screenshot`；留空則不存檔，只回傳檔案大小 | `~/.dsh/im/screenshot` |

設定頁只能投影 `id`、`order`、`label`，沒有放置圖示的位置，因此 `icon.svg` 僅供其他宿主使用。

## 工具

| 工具 | 用途 |
| --- | --- |
| `gw_goto` | 以 `url` 開啟網址（會檢查網域政策）；以 `q` 搜尋，只回傳 3 條候選並顯示決策卡 |
| `gw_read` | 讀取頁面：正文前 1500 字、前 12 個互動元素（附 `ref`）、頁面圖片清單 |
| `gw_act` | 執行 `click`、`type`、`select`、`press`、`scroll`、`drag`，可用 `steps` 一次完成連續動作 |
| `gw_shot` | 截圖並回傳檔案路徑（最後手段） |
| `gw_image` | 下載頁面圖片的原始檔，之後以 `read_image` 檢視 |
| `gw_done` | 關閉 Chrome，回報點擊次數與耗時 |

`gw_read` 只回傳元素清單，不回傳整頁 HTML。模型以 `ref` 指定目標，節省 token 也避免點錯位置。預設值刻意設得較小（12 個元素、1500 字），需要更多時由呼叫端自行指定。

### `gw_act` 的呼叫形式

| 形式 | 用途 |
| --- | --- |
| `{ action:'click', ref:'e3' }` | 一般點擊 |
| `{ action:'click', x:420, y:300 }` | canvas 或 iframe 遊戲沒有 `ref`，改用截圖像素座標（viewport 1:1） |
| `{ action:'type', ref:'e5', text:'123456' }` | 填寫文字 |
| `{ action:'select', ref:'e7', text:'台灣' }` | `<select>` 下拉選單；找不到顯示文字時改用 `value` |
| `{ action:'press', key:'Enter' }` | 在目前取得焦點的元素上按鍵 |
| `{ action:'drag', x:100, y:200, x2:400, y2:200 }` | 排序題、拖放 |
| `{ action:'scroll', dy:600 }` | 捲動頁面 |
| `{ steps:[{action:'click',ref:'e1'},{action:'click',ref:'e2',waitMs:500}] }` | 連續動作，最多 30 步 |

密碼欄位的保護不分入口：以 `ref` 填字、以座標點擊、以及先點進密碼欄再逐字按鍵，都會被攔截。

純文字能解決的情況不需要截圖。Kahoot 的題目、選項與倒數都是 DOM 文字，`gw_read` 一次約 100 token；截圖需要 1000 token 以上，一題只有二十秒，通常來不及。

### 預算與提示

- 同一頁連續 `gw_read` 三次仍未操作，回應會帶 `stuck: true`，要求模型立即操作或回報卡住的位置。
- 一次導航之內最多搜尋 2 輪；關閉瀏覽器時預算一併歸零，不會殘留到下一個任務。

## 安全機制

網域政策有三種模式：`off`（不限制）、`blocklist`（黑名單）、`allowlist`（白名單，含子網域）。

自 0.4.0 起，每個動作之後都會複查落地網址：點擊、填字、按鍵、拖曳、下拉、重新導向與新開分頁皆涵蓋在內；命中政策即退回原頁並回報原因。

唯一的例外是搜尋引擎本身。白名單模式下列出的網域不會包含 Bing、DuckDuckGo、Google，若不放行搜尋引擎，`gw_goto { q }` 將完全無法使用；使用者最後選擇的那條網址仍會經過網域政策檢查。

需要明確理解以下兩點：

- 這是**流程層**的攔截，不是沙箱。它約束外掛自己發出的操作，不會限制被開啟的網站本身能做什麼。
- 只攔截付款、購買、下單與密碼欄位；其他敏感操作（例如刪除帳號）不在攔截範圍內。

## 限制

- **iframe 內的 DOM 無法讀取。** `gw_read` 只讀主頁面；遇到 iframe（例如 Poki 這類遊戲）會在回應中標示 `frames`，並提示改用截圖加座標操作。
- **沒有定時截圖。** 只有模型主動要求時才截圖。
- **一次只有一個瀏覽器實例。** 多個任務同時需要瀏覽器時會共用同一個視窗，彼此干擾。
- **新分頁只能被動接管。** 不會主動關閉多餘分頁，但最新開啟的那一頁會被視為目前頁面，且同樣通過網域政策。
- **不支援既有 Chrome 的登入狀態。** 每次都是乾淨設定檔。

## 開發

不使用 TypeScript，也沒有打包流程。

```
package.json          宣告 bundle 與 client 的 dsh 欄位
cordis.patch.yml      外掛插入點
LICENSE               MIT
lib/index.js          宿主端：設定讀寫、HTTP 路由、工具註冊、診斷檔
lib/tools.js          六個工具的定義（零依賴）
lib/browser.js        Chrome 生命週期、ref 表、政策檢查、各種動作
lib/client.js         客戶端：設定頁（手寫 React）
test/smoke.mjs        不啟動瀏覽器的結構測試
test/live.mjs         實際開啟 Chrome 的端到端測試
```

外掛本身沒有相依套件，Playwright 是借用既有的安裝：

- 在插件目錄執行 `npm i playwright`，會裝進本地 `node_modules`（最乾淨的做法）；
- 或使用 DSH 實驗性瀏覽器外掛所安裝的 `@playwright/mcp`（`~/.dsh/mcp/browser/node_modules/playwright`）；
- 或使用 npm 全域安裝的版本；
- 或直接以 `DSH_GO_WORK_PLAYWRIGHT` 指定 playwright 資料夾。

`@playwright/mcp` 是微軟的官方套件（Apache-2.0），既不是本外掛的一部分，也不隨 DSH 核心發布；它之所以出現在本機，是因為 DSH 的實驗性外掛 `@deepseek-ai/dsh-experimental-browser-use-playwright-mcp` 使用它，並在首次執行時安裝到 `~/.dsh/mcp/browser`。找不到時，工具會列出搜尋過的路徑。Chrome 同理，可用 `DSH_GO_WORK_CHROME` 指定。

```bash
npm run check        # 四個檔案的語法檢查
npm test             # smoke：12 組，不啟動瀏覽器
npm run test:live    # 實際開啟一次 Chrome（會彈出視窗，約 5 秒）
```

排查問題時先看 `~/.dsh/go-work.diag.json`：`phase` 停在哪一段，就是哪裡出錯。`GET /dsh-go-work/api/ping` 會回傳同一份診斷資訊。

> `test/live.mjs` 需要啟動 Chrome 子行程（Playwright 使用 remote-debugging-pipe）。在受限沙箱中會得到 `spawn EPERM`，那是環境限制，不是外掛的問題；在正常的 DSH 宿主行程中執行即可。

## 授權

MIT，詳見 [LICENSE](LICENSE)。
