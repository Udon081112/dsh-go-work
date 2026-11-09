# dsh-go-work

給 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的瀏覽器插件。

讓 AI 自己開網頁、讀頁面、點東西——該擋的地方真的擋，不是靠提示詞自律。

> **狀態：0.2，能用。** 五個工具都通了，真 Chrome、真點擊。
> 還沒做：借用你現有 Chrome 的登入態、定時自動截圖、設定頁那個齒輪圖標。

## 為什麼要多一個

DSH 已經有 `@playwright/mcp`，AI 本來就能開瀏覽器。但那個路線有三個洞：

1. **規矩是提示詞。** 「不要填密碼」寫在提示裡，模型會漂。這裡是程式的 `if`。
2. **看不到它在做什麼。** 它開的 Chrome 走 debug pipe，外面連不上、也看不見。
3. **成本不可控。** 一張截圖一千多 token，連拍二十張就是兩萬。

這個插件自己開 Chrome（你看得到視窗），把「給人看的」「給 AI 看的」「不准碰的」分開管。

## 它怎麼被用

```
你：幫我把 kahoot 那題做掉，代碼 123456
AI：（gw_goto kahoot.it）→（gw_read）→ 看到題目和四個選項
   （gw_act click e3）→ 下一題 → 全部做完 →
   （gw_done）→ 跟你說錯了幾題
```

中途需要帳號密碼、或要按到「付款」「發佈」時，工具會回一句「被擋了，原因是 X」，AI 就回頭問你。**不做彈窗。**

## 設定

裝好之後，DSH 設定裡會多一頁 **AI瀏覽器**。

| 設定 | 說明 |
| --- | --- |
| 啟用 | 總開關 |
| Chrome | 乾淨 profile（目前只支援這個）；「用現在這個」需要先把你正在跑的 Chrome 關掉，還沒做 |
| 網域政策 | 不限制 / 黑名單 / 白名單（含子網域） |
| 敏感操作 | 密碼欄位、付款字眼、發佈字眼，三個獨立開關 |
| 預算 | 最多點幾次、最長幾分鐘（超過就自己關掉） |
| 截圖 | on-demand（工具要才給）；`interval` 定時截圖還沒做 |
| 截圖路徑 | 預設 `~/.dsh/im/screenshot`，留空＝只回大小不落檔 |
| 工具 | 五個工具各自開關 |

設定存在 `~/.dsh/go-work.config.json`。

## 給 AI 的工具

| 工具 | 做什麼 |
| --- | --- |
| `gw_goto` | 開網址（過網域政策） |
| `gw_read` | 讀頁面：正文（裁短）+ 可互動元素清單，每個帶 ref |
| `gw_act` | 用 ref `click` / `type` / `press` / `scroll` |
| `gw_shot` | 截圖，回檔案路徑 |
| `gw_done` | 關 Chrome，回點擊次數與耗時 |

`gw_read` 是關鍵：它回元素清單，不回整頁 HTML。AI 用 `ref` 指定目標，不用猜 CSS selector——省 token，而且不會點錯。

純文字能解決就不要截圖。kahoot 這種題目、選項、倒數全是 DOM 文字，`gw_read` 一次約 100 token；截圖要 1000 以上，一題只有二十秒，截圖根本來不及。

## 開發

不用 TypeScript，不用打包工具。

```
package.json          dsh 欄位宣告 bundle 與 client
cordis.patch.yml      插入點
lib/index.js          宿主：設定讀寫 + HTTP 路由 + 工具註冊
lib/tools.js          五個工具的定義（registry 認得的裸物件，零依賴）
lib/browser.js        Chrome 生命週期、ref 表、政策檢查
lib/client.js         客戶端：設定頁（手寫 React）
```

Playwright 從外面的 `@playwright/mcp` 借，不裝依賴。找不到會回報它找過哪些路徑；也可以用 `DSH_GO_WORK_PLAYWRIGHT` 指過去。Chrome 同理，`DSH_GO_WORK_CHROME`。

```bash
node --check lib/index.js
node test/smoke.mjs     # 10 組，不碰瀏覽器
node test/live.mjs      # 真的開一次 Chrome（會彈視窗，約 4 秒）
```

## 授權

MIT
