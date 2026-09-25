# ClaudeTW v2：離線預載繁中

macOS Claude 桌面版（含 Code 分頁）的非官方本機翻譯層；不是終端機 Claude Code，也不涵蓋 iOS 原生 App。

## 這次改什麼

- 在主視圖的隔離預載環境取得本機字典，不等 `dom-ready`、HTTP 或 Google 翻譯。
- 既有字典持久儲存於 `overrides.json` → `snapshot.json`；預先載入全部字典，畫面建立時只查表。
- 新增／更新的 DOM 區塊在 MutationObserver 回呼套用，沒有 150ms 延遲、全頁輪詢、遮住整頁或逐句遠端翻譯。
- 僅處理已知介面文字；不保存聊天、草稿、檔案路徑或整塊畫面。未知文字只在記憶體去重，磁碟回報只有數量。
- 選單列只保留「翻譯檢索」「更新」「GitHub」三項。開 Claude 後既有喚醒服務會啟動小工具（通常數秒；依系統排程）；字典預載不等小工具。
- Tiptap 輸入框提示用 head 中的 CSS 翻譯，不改可編輯區的文字或 data-placeholder。
- 關閉翻譯能還原仍由本工具持有的文字；React 已更新的節點不還原成過期內容。

## 改版邊界

以已核准的 App 版本與 ASAR SHA256 比對；不符則停止套用、提示需檢查。遠端網頁更新但 App 版本沒變時，僅繼續套用符合文字與 UI 範圍的條目，未知字保留原文。這不是任意改版都自動相容的保證。

「重新整合」會重新驗證並編譯本機字典，**不會自行產生未知英文的翻譯，也不會把舊補丁套到未知 App**。新增字串需補進字典後重新整合。沒有全文快取、外送翻譯或公開 HTTP 服務。

## 尚未完成

- 「更新」目前只支援檢查、下載驗證及暫存，**尚未提供安裝新版本**；缺少可信本機設定或公開 Release 時會明確停止。
- 全頁實機翻譯驗收尚未完成；示範影片內嵌的英文也不會由 DOM 字典翻譯。
- 修改官方 App 後的本機重簽不保留官方簽章身分。現場已遇到 Claude 官方更新的簽章驗證失敗，**尚未修復，沒有關閉安全驗證**。`codesign --verify` 通過不代表仍是官方簽章。
- 既有完整封存基準已含舊版 TW 注入，不能作為乾淨官方安裝來源。macOS 鑰匙圈重新授權必須由使用者自行處理；合成測試的 mock keychain 不能用於正式 App。

## 驗證

```sh
npm ci --ignore-scripts
node --test tests/*.test.mjs
node tests/browser.mjs   # 隔離 Chromium profile，含第一繪製影格驗證
node tests/electron.mjs  # 單一暫存 App／合成畫面，不用真實登入資料
```

`tests/electron.mjs` 僅在合成測試把允許來源換成 data URL；產品限定兩個正式 HTTPS origin。測試產物與來源／App 證據不進 Git。

## 本機安裝流程

舊版 `install.sh` 的強制停止、直接覆寫與擴大權限流程已停用。此工作分支只支援已審查的既有 ClaudeTW 基準，不是通用公開安裝器。

1. `scripts/patch-asar.mjs INPUT_ASAR NEW_OUTPUT_ASAR` 建置候選，保留未封裝檔案、連結與完整性資訊。輸入 hash 或主視圖邊界不符即拒絕。
2. `scripts/local-candidate.py` 建立一份候選、僅重簽外層，核對原有權限、原生框架及未改檔案。
3. 原始碼／測試／候選由另一引擎複審，執行 `bash scripts/build-helper.sh` 編譯小工具後，正常關閉 Claude 與 ClaudeTW。
4. `scripts/local-install.py --install-reviewed` 驗證收據、備份 runtime／小工具、交換完整 App，建置字典。程式不關閉或強制停止任何 App。
5. 重新開啟後親自檢查實際畫面。`bash scripts/diag.sh` 是唯讀診斷。

現用 App 原本即為舊版本機重簽安裝；本次不新增 Cowork 權限檢查繞過、不改登入或 Keychain、不改安全熔絲、不修改原生 framework。重簽後若 macOS 詢問鑰匙圈，必須由使用者本人處理。

還原使用安裝封存的 `RESTORE.md`、完整 App 備份和 runtime 壓縮包；不再使用舊的局部 ASAR 還原腳本。

未推 GitHub、未發布，私有執行資料與官方 App 不入庫。
