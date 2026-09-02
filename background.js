/**
 * 唯一的網路出口。
 *
 * content script 的 fetch 走的是**它所在頁面**的 CSP，所以從 play.riftatlas.com
 * 直接連我們的網域會不會被擋，取決於他們 connect-src 怎麼寫——那是隨時可能改、
 * 而且改了我們也不會知道的東西。service worker 沒有頁面 CSP，只受 manifest 的
 * host_permissions 管，於是這條路由是我們自己說了算。
 *
 * 也因為只有這裡連得出去，「這個擴充到底把什麼送去哪裡」看這一個檔就答得完。
 */

const SITE = "https://riftbound.chroniclecore.com";

/**
 * 開發時把來源指到本機，不必改這個檔案。
 *
 * 在 chrome://extensions 找到這個擴充的 service worker，在它的主控台跑：
 *   chrome.storage.local.set({ siteOverride: "http://localhost:3000" })
 * 清掉就回正式站：
 *   chrome.storage.local.remove("siteOverride")
 *
 * 做成設定而不是改常數，是因為改常數的那一行遲早會跟著 commit 出去——而它一旦
 * 出去，所有使用者的擴充都會去連他們自己電腦上的 3000 埠。
 *
 * 覆寫值也要進 manifest 的 host_permissions 才連得出去；README 有那一步。
 */
async function siteOrigin() {
    try {
        const { siteOverride } = await chrome.storage.local.get("siteOverride");
        return typeof siteOverride === "string" && siteOverride ? siteOverride : SITE;
    } catch {
        return SITE;
    }
}

/** 系列表一年只動幾次，存起來省得每次開頁都問。 */
const SETS_CACHE_KEY = "cardSetsCache";
const SETS_CACHE_MS = 24 * 60 * 60 * 1000;
const OWNER_KEY = "ownerKey";

/**
 * 這個擴充現在有沒有連我們網域的權限。
 *
 * Chrome 讓使用者逐站控制擴充的存取（「在點選時」／「在特定網站上」），而被關掉
 * 之後 background 的 fetch 會直接拋 TypeError——跟斷網長得一模一樣。實測有使用
 * 者就是踩到這個，自己去把「網站存取權」打開才好。那不該由使用者猜。
 */
async function hasSiteAccess() {
    try {
        return await chrome.permissions.contains({ origins: [`${await siteOrigin()}/*`] });
    } catch {
        // 查不出來就別擋路：讓請求照送，失敗時退回一般的網路錯誤訊息。
        return true;
    }
}

/**
 * fetch 在連不上時拋的是 TypeError("Failed to fetch")——那句話對使用者毫無意義，
 * 而它跟「伺服器回了錯誤」是完全不同的兩件事：前者是他那端連不出去（DNS、防火
 * 牆、VPN、離線），後者我們會回一句中文說明。翻成看得懂的話，順便讓回報的人講
 * 得出哪一種。
 */
async function fetchOrExplain(url, init) {
    try {
        return await fetch(url, init);
    } catch {
        // 先分辨是哪一種失敗：權限被關掉跟連不上網路，症狀相同但解法完全不同。
        const error = new Error(
            (await hasSiteAccess())
                ? chrome.i18n.getMessage("errNetwork") || "連不上編年史，檢查一下網路再試"
                : chrome.i18n.getMessage("errNoAccess") || "這個擴充還沒有存取編年史的權限",
        );
        error.needsAccess = !(await hasSiteAccess());
        throw error;
    }
}

async function getJson(path) {
    const response = await fetchOrExplain(`${await siteOrigin()}${path}`, { credentials: "omit" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
}

async function loadCardSets() {
    const cached = await chrome.storage.local.get(SETS_CACHE_KEY);
    const entry = cached[SETS_CACHE_KEY];
    if (entry && Date.now() - entry.at < SETS_CACHE_MS) return entry.data;

    try {
        const data = await getJson("/api/card-sets");
        await chrome.storage.local.set({ [SETS_CACHE_KEY]: { at: Date.now(), data } });
        return data;
    } catch (error) {
        // 過期的表格仍然比沒有好：它唯一會過時的地方是「最新一彈算不算當前環境」，
        // 而拿不到表格的話連判都不能判。
        if (entry) return entry.data;
        throw error;
    }
}

/**
 * 這台瀏覽器掛房間用的憑證，第一次要用的時候才產生。
 *
 * 取代的是一整套登入：帶著同一把 key 才改得動同一間房，而使用者不必註冊、不必
 * 登入、不必記任何東西。32 bytes 的密碼學亂數，要的就是「別人猜不到」。
 *
 * 伺服器只存它的 SHA-256，所以就算那張表被讀光，也還原不出任何一把 key。
 *
 * 換瀏覽器或清掉擴充資料就是另一把，舊的那間房於是改不動了——但它 20 分鐘後本來
 * 就自己消失，實際上沒有代價。
 */
async function ownerKey() {
    const stored = await chrome.storage.local.get(OWNER_KEY);
    if (typeof stored[OWNER_KEY] === "string" && stored[OWNER_KEY].length >= 20) return stored[OWNER_KEY];

    const bytes = crypto.getRandomValues(new Uint8Array(32));
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    const key = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    await chrome.storage.local.set({ [OWNER_KEY]: key });
    return key;
}

/** 掛出／收掉。兩者都帶同一把憑證，伺服器據此決定動得了哪一列。 */
async function writeRoom(method, room) {
    const response = await fetchOrExplain(`${await siteOrigin()}/api/rooms`, {
        method,
        credentials: "omit",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...(room ?? {}), ownerKey: await ownerKey() }),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const handler =
        message?.type === "rooms"
            ? () => getJson("/api/rooms")
            : message?.type === "cardSets"
              ? loadCardSets
              : message?.type === "publish"
                ? () => writeRoom("POST", message.room)
                : message?.type === "takeDown"
                  ? () => writeRoom("DELETE", null)
                  : message?.type === "openPermissions"
                    ? async () => {
                          // chrome:// 開不了 content script，但 background 可以。
                          await chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });
                          return { opened: true };
                      }
                    : null;

    if (!handler) return false;

    handler()
        .then((data) => sendResponse({ ok: true, data }))
        .catch((error) => sendResponse({ ok: false, error: String(error?.message ?? error), needsAccess: Boolean(error?.needsAccess) }));

    // 非同步回覆必須明確回 true，否則 channel 會在 sendResponse 之前就關掉。
    return true;
});
