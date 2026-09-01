/**
 * Rift Atlas 助手 — 注入大廳的一塊面板。
 *
 * 三件事，都是 Rift Atlas 沒有而玩家一直在手動繞過的：
 *   1. 這副牌是不是只用了現在買得到的卡（它的隨機配對挑不掉環境）
 *   2. 把房號掛到公開布告欄（原本得自己複製、切分頁、貼上）
 *   3. 看見別人正在等的房間（原本得先約好朋友，或在某個群裡喊）
 *
 * 只讀不寫：面板不碰 Rift Atlas 的任何狀態，不送出任何對局資料，也不替使用者
 * 按下他們自己沒按的東西。掛房號是開一個帶著房號的分頁，由他在我們站上按送出。
 *
 * 對它 DOM 的依賴壓到最低——房間狀態讀的是 localStorage（結構穩定得多），只有
 * 牌組卡片是從圖片網址解析的，因為那是唯一拿得到卡號的地方。任何一項失敗都只是
 * 那一塊不顯示，不影響頁面本身。
 */

(() => {
    "use strict";

    const SITE = "https://riftbound.chroniclecore.com";
    const HOST_ID = "rbc-riftatlas-companion";
    const COLLAPSE_KEY = "rbc_panel_collapsed";

    /** 讀本地狀態的節奏。localStorage 在同一個分頁裡改動不會發事件，只能自己看。 */
    const LOCAL_POLL_MS = 2000;
    /** 問布告欄的節奏。板上的房間以分鐘計，半分鐘一次綽綽有餘。 */
    const BOARD_POLL_MS = 30000;

    const ROOM_KEY = "riftbound_simulator_last_room";
    /** 實測的卡圖路徑：riftbound/cards/zh-CN/original/OGN-004.webp */
    const CARD_IMG_RE = /\/cards\/[^/]+\/original\/([A-Za-z0-9]+(?:-[A-Za-z0-9]+)+)\.webp/;

    // ---------- 從 Rift Atlas 讀狀態（只讀） ----------

    function readSession() {
        try {
            const raw = localStorage.getItem(ROOM_KEY);
            if (!raw) return null;
            return JSON.parse(raw)?.session ?? null;
        } catch {
            return null;
        }
    }

    /**
     * 牌組面板上每一張卡的卡號與顯示名。
     *
     * 卡號來自圖片網址而不是卡名：介面是簡體中文，跟我們的繁體卡名對不起來，而且
     * 同名異卡會對錯。名字只拿來讓「哪幾張超出」看得懂，對不到就退回卡號。
     */
    function readDeckCards() {
        const cards = new Map();
        for (const img of document.images) {
            const match = img.src.match(CARD_IMG_RE);
            if (!match) continue;
            const id = match[1];
            if (cards.has(id)) continue;
            const row = img.closest("li, div");
            const label = (row?.textContent || "").trim().replace(/^\d+x\s*/, "");
            cards.set(id, label && label.length <= 24 ? label : id);
        }
        return cards;
    }

    // ---------- 合法性 ----------

    /**
     * 一張卡屬於第幾彈，判不出來時回 null。
     *
     * 特典池（wave 0）本身沒有彈數，它的每一張都是某張卡的再刷，而 id 帶著母系列
     * ——OPP-OGN-007b 是一彈的賽事卡。看得出母系列就用它的彈數，看不出來就不判。
     *
     * 不認得的系列前綴一律回 null，而不是當成違規：這個擴充可能比網站舊，新系列
     * 上市時最糟的情況該是「說不出來」，不是「說你違規」。
     */
    function waveOfCard(cardId, setsByCode) {
        const parts = cardId.split("-");
        const set = setsByCode.get(parts[0]);
        if (!set) return null;
        if (set.wave > 0) return set.wave;
        if (parts.length > 2) {
            const parent = setsByCode.get(parts[1]);
            if (parent && parent.wave > 0) return parent.wave;
        }
        return null;
    }

    function checkLegality(cards, setsByCode, currentWave) {
        const over = [];
        let unknown = 0;
        for (const [id, label] of cards) {
            const wave = waveOfCard(id, setsByCode);
            if (wave === null) unknown += 1;
            else if (wave > currentWave) over.push({ id, label });
        }
        return { total: cards.size, over, unknown };
    }

    // ---------- 跟網站說話 ----------

    function ask(type) {
        return new Promise((resolve) => {
            try {
                chrome.runtime.sendMessage({ type }, (reply) => {
                    // 擴充被更新或停用時 sendMessage 會留下 lastError；讀掉它，否則
                    // Chrome 會把它當成未處理的錯誤印在主控台。
                    if (chrome.runtime.lastError || !reply?.ok) return resolve(null);
                    resolve(reply.data);
                });
            } catch {
                resolve(null);
            }
        });
    }

    // ---------- 面板 ----------

    const CSS = `
    :host { all: initial; }
    .panel {
        position: fixed; right: 16px; bottom: 16px; z-index: 2147483000;
        width: 288px; max-width: calc(100vw - 32px); max-height: 70vh;
        display: flex; flex-direction: column;
        font-family: system-ui, -apple-system, "Noto Sans TC", sans-serif;
        color: #edf4ff; background: #0b0f1a; border: 1px solid #2a3350;
        box-shadow: 0 8px 32px rgba(0,0,0,.55); font-size: 13px;
    }
    .head {
        display: flex; align-items: center; gap: 8px; padding: 9px 11px;
        border-bottom: 1px solid #2a3350; cursor: pointer; user-select: none;
    }
    .head b { font-size: 12px; letter-spacing: .04em; color: #d8b978; font-weight: 700; }
    .head .badge { border: 1px solid #4a7fd6; color: #7fa8ea; padding: 1px 5px; font-size: 10px; }
    .head .sp { margin-left: auto; color: #7d89a8; font-size: 15px; line-height: 1; }
    .body { overflow-y: auto; padding: 11px; display: flex; flex-direction: column; gap: 12px; }
    /* 收起來時只佔標題文字的寬度。288px 的空條會壓到 Rift Atlas 的「加入／觀戰」
       按鈕右緣——收合的意義就是不擋路，那條空白不該還在那裡擋。 */
    .panel.collapsed { width: auto; }
    .panel.collapsed .head { border-bottom: 0; }
    .panel.collapsed .head .sp { margin-left: 4px; }
    .panel.collapsed .body { display: none; }
    .sec > h4 {
        margin: 0 0 6px; font-size: 10px; font-weight: 700; letter-spacing: .14em;
        text-transform: uppercase; color: #7d89a8;
    }
    .muted { color: #7d89a8; }
    .ok { color: #7fd6a2; }
    .warn { color: #f0b866; }
    .row {
        display: flex; align-items: center; gap: 7px; padding: 7px 0;
        border-top: 1px solid #1c2540;
    }
    .row:first-of-type { border-top: 0; }
    .row .name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .tag { border: 1px solid #2a3350; padding: 1px 5px; font-size: 10px; color: #9fb0d0; white-space: nowrap; }
    .tag.cur { border-color: #4a7fd6; color: #7fa8ea; }
    .push { margin-left: auto; }
    button {
        font: inherit; font-size: 11px; cursor: pointer; background: transparent;
        border: 1px solid #d8b978; color: #d8b978; padding: 5px 10px; white-space: nowrap;
    }
    button:hover { background: #d8b978; color: #0b0f1a; }
    button.block { width: 100%; padding: 7px; font-weight: 700; }
    button.ghost { border-color: #2a3350; color: #9fb0d0; }
    button.ghost:hover { background: #1c2540; color: #edf4ff; }
    code { font-family: ui-monospace, SFMono-Regular, monospace; letter-spacing: .08em; }
    ul { margin: 4px 0 0; padding-left: 16px; }
    li { margin: 2px 0; }
    `;

    let root = null;

    /**
     * 預設收合。
     *
     * 這塊面板貼在別人的頁面右下角，而 Rift Atlas 的右下角正是「加入／觀戰」那一
     * 區——展開的面板會蓋住玩家本來就要按的東西。外掛在別人網站上的第一原則是不
     * 擋路，所以預設只留一條標題列，展開與否由使用者決定並記住。
     *
     * 代價是「有幾個人在等」看不到，而那是這個面板最有價值的一句話——所以它移到
     * 標題列上，收合時照樣看得見。
     */
    let collapsed = true;
    try {
        collapsed = localStorage.getItem(COLLAPSE_KEY) !== "0";
    } catch {
        /* 讀不到就照預設收合 */
    }

    function mount() {
        if (document.getElementById(HOST_ID)) return;
        const host = document.createElement("div");
        host.id = HOST_ID;
        // Shadow DOM:對方是 Tailwind,全域 reset 會把面板洗掉;反過來我們的樣式
        // 也不該漏出去改到他們的頁面。
        root = host.attachShadow({ mode: "open" });
        const style = document.createElement("style");
        style.textContent = CSS;
        root.append(style, document.createElement("div"));
        document.body.appendChild(host);
    }

    function h(html) {
        const wrap = document.createElement("div");
        wrap.innerHTML = html;
        return wrap;
    }

    function escapeHtml(text) {
        return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
    }

    // ---------- 各區塊 ----------

    function renderLegality(state) {
        if (!state.cards || state.cards.size === 0) return "";
        if (!state.sets) return `<div class="sec"><h4>牌組檢查</h4><p class="muted">環境資料讀不到，暫時無法判定。</p></div>`;

        const { total, over, unknown } = checkLegality(state.cards, state.sets.byCode, state.sets.currentWave);
        const label = state.sets.currentWaveLabel;

        const verdict =
            over.length === 0
                ? `<p class="ok">✓ ${total} 張卡都在${escapeHtml(label)}以內</p>`
                : `<p class="warn">✗ ${over.length} 張超出${escapeHtml(label)}</p><ul>${over
                      .slice(0, 6)
                      .map((card) => `<li>${escapeHtml(card.label)} <span class="muted">${escapeHtml(card.id)}</span></li>`)
                      .join("")}${over.length > 6 ? `<li class="muted">⋯還有 ${over.length - 6} 張</li>` : ""}</ul>`;

        const caveat = unknown > 0 ? `<p class="muted">另有 ${unknown} 張認不出系列，沒有計入。</p>` : "";
        return `<div class="sec"><h4>牌組檢查</h4>${verdict}${caveat}</div>`;
    }

    function renderMyRoom(state) {
        const code = state.session?.roomCode;
        if (!code) {
            return `<div class="sec"><h4>我的房間</h4><p class="muted">建立房間之後，這裡會出現把房號掛上布告欄的按鈕。</p></div>`;
        }
        const listed = state.rooms?.some((room) => room.roomCode === code);
        return `<div class="sec"><h4>我的房間</h4>
            <div class="row"><span class="name"><code>${escapeHtml(code)}</code></span>
            ${listed ? `<span class="tag push ok">已在板上</span>` : ""}</div>
            <button class="block" data-act="publish">${listed ? "更新布告欄上的資料" : "掛到布告欄等對手"}</button>
        </div>`;
    }

    function renderBoard(state) {
        if (!state.rooms) {
            return `<div class="sec"><h4>正在等對手</h4><p class="muted">讀不到布告欄。</p></div>`;
        }
        const others = state.rooms.filter((room) => room.roomCode !== state.session?.roomCode);
        if (others.length === 0) {
            return `<div class="sec"><h4>正在等對手</h4><p class="muted">現在沒有人在等。</p></div>`;
        }
        const rows = others
            .slice(0, 8)
            .map(
                (room) => `<div class="row">
                    <span class="name">${escapeHtml(room.nickname)}</span>
                    <span class="tag${room.format === "current" ? " cur" : ""}">${room.format === "current" ? escapeHtml(state.rooms_label || "當前環境") : "不限"}</span>
                    <span class="tag">${escapeHtml(room.matchMode.toUpperCase())}</span>
                    <button class="push" data-join="${escapeHtml(room.roomCode)}">加入</button>
                </div>`,
            )
            .join("");
        return `<div class="sec"><h4>正在等對手（${others.length}）</h4>${rows}</div>`;
    }

    function render(state) {
        if (!root) return;
        const container = root.lastElementChild;
        // 等的人數放標題列，收合時也看得見——那是這塊面板唯一一句「現在值得展開」。
        const waiting = state.rooms ? state.rooms.filter((room) => room.roomCode !== state.session?.roomCode).length : 0;
        const badge = waiting > 0 ? `<span class="badge">${waiting} 人在等</span>` : "";
        const panel = h(`<div class="panel${collapsed ? " collapsed" : ""}">
            <div class="head"><b>編年史助手</b>${badge}<span class="sp">${collapsed ? "▴" : "▾"}</span></div>
            <div class="body">
                ${renderMyRoom(state)}
                ${renderLegality(state)}
                ${renderBoard(state)}
            </div>
        </div>`).firstElementChild;

        panel.querySelector(".head").addEventListener("click", () => {
            collapsed = !collapsed;
            try {
                localStorage.setItem(COLLAPSE_KEY, collapsed ? "1" : "0");
            } catch {
                /* 記不住收合狀態不影響使用 */
            }
            render(state);
        });

        const publish = panel.querySelector('[data-act="publish"]');
        if (publish) {
            publish.addEventListener("click", () => {
                window.open(`${SITE}/rooms?code=${encodeURIComponent(state.session.roomCode)}`, "_blank", "noopener");
            });
        }

        for (const button of panel.querySelectorAll("[data-join]")) {
            button.addEventListener("click", () => {
                const target = `/zh-CN?room=${encodeURIComponent(button.dataset.join)}`;
                // 已經坐在一間房裡就開新分頁——直接跳走會把他從自己的對局裡拉出來。
                if (state.session?.roomCode) window.open(target, "_blank", "noopener");
                else window.location.href = target;
            });
        }

        container.replaceChildren(panel);
    }

    // ---------- 迴圈 ----------

    const state = { session: null, cards: new Map(), sets: null, rooms: null, rooms_label: null };
    let lastFingerprint = "";

    function fingerprint() {
        return JSON.stringify([
            state.session?.roomCode ?? null,
            [...state.cards.keys()],
            state.rooms?.map((room) => room.roomCode) ?? null,
            Boolean(state.sets),
        ]);
    }

    function refreshLocal() {
        state.session = readSession();
        state.cards = readDeckCards();
        const next = fingerprint();
        if (next !== lastFingerprint) {
            lastFingerprint = next;
            render(state);
        }
    }

    async function refreshBoard() {
        const data = await ask("rooms");
        if (data) {
            state.rooms = data.rooms ?? [];
            state.rooms_label = data.currentWaveLabel ?? null;
        }
        const next = fingerprint();
        if (next !== lastFingerprint) {
            lastFingerprint = next;
            render(state);
        }
    }

    async function loadSets() {
        const data = await ask("cardSets");
        if (!data) return;
        state.sets = {
            currentWave: data.currentWave,
            currentWaveLabel: data.currentWaveLabel,
            byCode: new Map(data.sets.map((set) => [set.code, set])),
        };
        render(state);
    }

    function start() {
        mount();
        render(state);
        void loadSets();
        void refreshBoard();
        refreshLocal();
        setInterval(refreshLocal, LOCAL_POLL_MS);
        setInterval(() => void refreshBoard(), BOARD_POLL_MS);
    }

    if (document.body) start();
    else document.addEventListener("DOMContentLoaded", start, { once: true });
})();
