/**
 * 唯一的網路出口。
 *
 * content script 的 fetch 走的是**它所在頁面**的 CSP，所以從 play.riftatlas.com
 * 直接連我們的網域會不會被擋，取決於他們 connect-src 怎麼寫——那是隨時可能改、
 * 而且改了我們也不會知道的東西。service worker 沒有頁面 CSP，只受 manifest 的
 * host_permissions 管，於是這條路由是我們自己說了算。
 *
 * 也因為只有這裡連得出去，「這個擴充到底把什麼送去哪裡」看這一個檔就答得完：
 * 兩支 GET，沒有 POST，沒有任何頁面內容離開瀏覽器。
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

async function getJson(path) {
    const response = await fetch(`${await siteOrigin()}${path}`, { credentials: "omit" });
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
        // 過期的表格仍然比沒有好：它唯一會過時的地方是「最新一彈算不算當前環境」,
        // 而拿不到表格的話連判都不能判。
        if (entry) return entry.data;
        throw error;
    }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const handler =
        message?.type === "rooms" ? () => getJson("/api/rooms") : message?.type === "cardSets" ? loadCardSets : null;

    if (!handler) return false;

    handler()
        .then((data) => sendResponse({ ok: true, data }))
        .catch((error) => sendResponse({ ok: false, error: String(error?.message ?? error) }));

    // 非同步回覆必須明確回 true，否則 channel 會在 sendResponse 之前就關掉。
    return true;
});
