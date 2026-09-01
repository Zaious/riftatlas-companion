# Rift Atlas 助手

[English](README.md)

[Rift Atlas](https://play.riftatlas.com/) 是《符文戰場》(Riftbound) 玩得最多人的線上模擬器。這個 Chrome 擴充在它的大廳上加一塊面板，補三件它沒有、玩家一直在手動繞過的事：

- **牌組是否符合當前環境** — 它的隨機配對挑不掉環境，你配到誰就打誰的牌。面板讀出牌組裡每張卡的卡號，標出超出當前環境的那幾張。
- **把房號掛到公開布告欄** — 原本得自己複製房號、切分頁、貼到某個群裡。
- **看見別人正在等的房間** — 原本得先約好朋友，或在你剛好有加的那個群裡喊。

布告欄在[符文戰場編年史](https://riftbound.chroniclecore.com/rooms)，不裝擴充也看得到、也能加入；擴充省掉的是複製貼上跟自己數牌。

## 安裝

還沒上架 Chrome 線上應用程式商店，目前用開發者模式載入：

1. 下載或 clone 這個資料夾。
2. 開 `chrome://extensions`，右上角打開「開發人員模式」。
3. 按「載入未封裝項目」，選這個資料夾。
4. 重新整理 `play.riftatlas.com`，右下角會出現一條「編年史助手」，點一下展開。

面板預設收合，因為它站在 Rift Atlas 的「加入／觀戰」按鈕旁邊，展開時會擋到。收合那條會顯示現在有幾個人在等。

## 開發

要讓擴充連本機的網站而不是正式站，不要改 `background.js` 的 `SITE`——那一行遲早會跟著 commit 出去，讓所有使用者的擴充去連他們自己電腦上的 3000 埠。改用設定：

1. `manifest.json` 的 `host_permissions` 加 `"http://localhost:3000/*"`，重新載入擴充。
2. 在 `chrome://extensions` 點這個擴充的 **service worker** 開主控台，執行：

```js
chrome.storage.local.set({ siteOverride: "http://localhost:3000" })
```

改回正式站就清掉它：

```js
chrome.storage.local.remove("siteOverride")
```

改完 `content.js` 要在 `chrome://extensions` 按重新載入，再重新整理 Rift Atlas 的分頁；只改 `background.js` 的話按重新載入就夠了。

## 它讀什麼、送什麼

會讀對戰網站的東西，所以這件事該講清楚，也是它開源的理由——你可以自己核對下面每一句。

**在 play.riftatlas.com 上讀兩樣東西**，都只在你的瀏覽器裡：

- `localStorage` 的 `riftbound_simulator_last_room`，也就是你目前的房號。
- 牌組面板上卡片圖片的網址，從裡面取出卡號（例如 `OGN-004`）。用卡號而不是卡名，因為介面是簡體中文，跟繁體卡名對不起來。

**只發出兩個 GET 請求**，都到 `riftbound.chroniclecore.com`，都不帶 cookie（`credentials: "omit"`）：

- `/api/rooms` — 目前掛在布告欄上的房間。
- `/api/card-sets` — 每個系列屬於第幾彈，以及台灣現在開賣到第幾彈。快取一天。這份資料在網站上而不是寫死在擴充裡，所以升彈時你不用更新擴充。

**沒有任何東西被送出去。** 沒有 POST，沒有回報，沒有分析追蹤。你的牌組、房號、對局內容都不會離開瀏覽器——按下「掛到布告欄」時，擴充做的是開一個帶著房號的分頁，送不送出由你在網站上自己按。所有對外連線都集中在 `background.js` 一個檔案裡，看那一個檔就查得完。

## 它不做什麼

- 不替你按任何 Rift Atlas 上的按鈕，不修改對局狀態，不自動化任何操作。
- 不判定規則、不裁決互動、不告訴你該怎麼打。
- 認不出的系列一律顯示「認不出系列」，不會說你違規——擴充可能比網站舊，最糟的情況該是說不出來，不是冤枉你。

## 授權與聲明

MIT。

**這是第三方的第三方。** 《符文戰場》是 Riot Games 的遊戲；Rift Atlas 是非官方的社群模擬器，不是 Riot 做的；這個擴充是 Rift Atlas 的非官方外掛，也不是他們做的——它只讀他們的公開頁面，在旁邊加一塊面板。三方各自獨立，彼此沒有任何隸屬關係。

講明白：與 Riot Games 無隸屬關係、未經其認可或贊助；與 Rift Atlas 同樣無隸屬關係、未經其認可或贊助。《符文戰場》相關智慧財產權歸 Riot Games 所有，本專案依 Riot Games 的 "Legal Jibber Jabber" 政策使用。這個擴充出的問題是我們的問題，請回報到這裡，不要去找 Rift Atlas。

由[符文戰場編年史](https://riftbound.chroniclecore.com)製作。
