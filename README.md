# dsh-go-work

給 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的瀏覽器插件。

讓 AI 自己開網頁、讀頁面、點東西——該擋的地方真的擋，不是靠提示詞自律。

> **狀態：第一階段（骨架）。** 設定頁已能讀寫；瀏覽器工具還沒長出來。
> 現階段它只是「一個出現在設定裡的空殼」。第二階段才接 Playwright。

## 為什麼要多一個

DSH 已經有 `@playwright/mcp`，AI 本來就能開瀏覽器。但那個路線有三個洞：

1. **規矩是提示詞。** 「不要填密碼」寫在提示裡，模型會漂。這裡是程式的 `if`。
2. **看不到它在做什麼。** 截圖存成檔案，你要自己去找。
3. **成本不可控。** 一張截圖一千多 token，連拍二十張就是兩萬。

這個插件把「給人看的」「給 AI 看的」「不准碰的」分開管。

## 設定

裝好之後，DSH 設定裡會多一頁 **瀏覽器**。

| 設定 | 說明 |
| --- | --- |
| 啟用 | 總開關 |
| Chrome | 乾淨 profile（預設）或借用本機登入態 |
| 網域政策 | 不限制 / 黑名單 / 白名單 |
| 敏感操作 | 密碼欄位、付款、發佈，三個獨立開關 |
| 預算 | 最多點幾次、最長幾分鐘 |
| 截圖 | AI 自己要 / 每 N 秒 / 關閉 |
| 截圖路徑 | 預設留空（只回給 AI，不落檔） |
| 工具 | 五個工具各自開關 |

設定存在 `~/.dsh/go-work.config.json`。

## 給 AI 的工具

| 工具 | 做什麼 |
| --- | --- |
| `goto` | 開網址 |
| `read` | 讀頁面，回傳可互動元素清單（每個帶短 ref） |
| `act` | 用 ref 點擊或輸入 |
| `shot` | 截一張圖給它看 |
| `done` | 宣告任務結束 |

`read` 是關鍵：它回元素清單，不回整頁 HTML。AI 用 ref 指定目標，不用猜 CSS selector——省 token，而且不會點錯。

被政策擋下時，工具回一句「被擋了，原因是 X」，模型會自己回頭問你。不做彈窗。

## 開發

不用 TypeScript，不用打包工具。三個檔：

```
package.json          dsh 欄位宣告 bundle 與 client
cordis.patch.yml      插入點
lib/index.js          宿主：設定讀寫 + HTTP 路由
lib/client.js         客戶端：設定頁（手寫 React）
```

```bash
node --check lib/index.js
node --check lib/client.js
node test/smoke.mjs
```

## 授權

MIT
