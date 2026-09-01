/**
 * Rift Atlas 助手 — 注入大廳的一塊面板。
 *
 * 三件事，都是 Rift Atlas 沒有而玩家一直在手動繞過的：
 *   1. 這副牌是不是只用了現在買得到的卡（它的隨機配對挑不掉環境）
 *   2. 把房號掛到公開布告欄（原本得自己複製、切分頁、貼上）
 *   3. 看見別人正在等的房間（原本得先約好朋友，或在某個群裡喊）
 *
 * 只讀 Rift Atlas，不寫：面板不碰它的任何狀態，不送出任何對局資料，也不替使用者
 * 按下他們自己沒按的東西。唯一會離開瀏覽器的是使用者按下「掛到布告欄」時，自己
 * 填的那幾個欄位。
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
    const SOUND_KEY = "rbc_panel_sound";

    /** 讀本地狀態的節奏。localStorage 在同一個分頁裡改動不會發事件，只能自己看。 */
    const LOCAL_POLL_MS = 2000;
    /** 問布告欄的節奏。板上的房間以分鐘計，半分鐘一次綽綽有餘。 */
    const BOARD_POLL_MS = 30000;

    const ROOM_KEY = "riftbound_simulator_last_room";
    const NAME_KEY = "riftbound_simulator_player_name";
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

    /** Rift Atlas 上用的名字，拿來當布告欄暱稱的預設值——同一個人，沒理由問兩次。 */
    function readPlayerName(session) {
        if (session?.playerName) return String(session.playerName).slice(0, 20);
        try {
            return (localStorage.getItem(NAME_KEY) || "").slice(0, 20);
        } catch {
            return "";
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

    function ask(message) {
        return new Promise((resolve) => {
            try {
                chrome.runtime.sendMessage(message, (reply) => {
                    // 擴充被更新或停用時 sendMessage 會留下 lastError；讀掉它，否則
                    // Chrome 會把它當成未處理的錯誤印在主控台。
                    if (chrome.runtime.lastError) return resolve({ ok: false, error: "擴充剛更新過，重新整理這一頁就好" });
                    resolve(reply ?? { ok: false, error: "沒有回應" });
                });
            } catch {
                resolve({ ok: false, error: "沒有回應" });
            }
        });
    }

    // ---------- 提示音 ----------

    let audioCtx = null;

    /**
     * 兩種提示音，用合成的而不是打包音檔：這樣擴充裡沒有二進位檔案，想稽核的人
     * 讀得完每一個位元組。
     *
     * 上行兩音＝有人進來了，下行兩音＝房間掉下板了。
     */
    function beep(kind) {
        if (!soundOn) return;
        try {
            audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
            if (audioCtx.state === "suspended") void audioCtx.resume();
            const notes = kind === "join" ? [660, 990] : [520, 390];
            notes.forEach((freq, index) => {
                const at = audioCtx.currentTime + index * 0.13;
                const osc = audioCtx.createOscillator();
                const gain = audioCtx.createGain();
                osc.type = "sine";
                osc.frequency.value = freq;
                gain.gain.setValueAtTime(0.0001, at);
                gain.gain.exponentialRampToValueAtTime(0.15, at + 0.02);
                gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.12);
                osc.connect(gain).connect(audioCtx.destination);
                osc.start(at);
                osc.stop(at + 0.13);
            });
        } catch {
            /* 瀏覽器不給放（例如使用者還沒跟頁面互動過）就算了，畫面上照樣看得到 */
        }
    }

    // ---------- 面板 ----------

    const CSS = `
    :host { all: initial; }
    .panel {
        position: fixed; right: 16px; bottom: 16px; z-index: 2147483000;
        width: 288px; max-width: calc(100vw - 32px); max-height: 78vh;
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
        display: flex; align-items: center; gap: 6px;
    }
    .sec > h4 .right { margin-left: auto; text-transform: none; letter-spacing: 0; font-weight: 400; }
    .muted { color: #7d89a8; }
    .ok { color: #7fd6a2; }
    .warn { color: #f0b866; }
    .err { color: #f08a8a; }
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
    button:hover:not(:disabled) { background: #d8b978; color: #0b0f1a; }
    button:disabled { opacity: .45; cursor: default; }
    button.block { width: 100%; padding: 7px; font-weight: 700; }
    button.ghost { border-color: #2a3350; color: #9fb0d0; }
    button.ghost:hover:not(:disabled) { background: #1c2540; color: #edf4ff; }
    button.mute {
        border: 0; padding: 0 2px; color: #7d89a8; font-size: 13px; line-height: 1;
    }
    button.mute:hover:not(:disabled) { background: transparent; color: #d8b978; }
    input, select {
        font: inherit; font-size: 12px; width: 100%; box-sizing: border-box;
        background: #05070d; color: #edf4ff; border: 1px solid #2a3350; padding: 5px 7px;
    }
    input:focus, select:focus { outline: none; border-color: #d8b978; }
    label.field { display: block; margin-bottom: 6px; }
    label.field > span { display: block; font-size: 10px; color: #7d89a8; margin-bottom: 2px; }
    .pair { display: flex; gap: 6px; }
    .pair > * { flex: 1; }
    code { font-family: ui-monospace, SFMono-Regular, monospace; letter-spacing: .08em; }
    ul { margin: 4px 0 0; padding-left: 16px; }
    li { margin: 2px 0; }
    a { color: #7fa8ea; }
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
    let soundOn = true;
    try {
        collapsed = localStorage.getItem(COLLAPSE_KEY) !== "0";
        soundOn = localStorage.getItem(SOUND_KEY) !== "0";
    } catch {
        /* 讀不到就照預設 */
    }

    function remember(key, value) {
        try {
            localStorage.setItem(key, value);
        } catch {
            /* 記不住偏好不影響這一次使用 */
        }
    }

    function mount() {
        if (document.getElementById(HOST_ID)) return;
        const host = document.createElement("div");
        host.id = HOST_ID;
        // Shadow DOM：對方是 Tailwind，全域 reset 會把面板洗掉；反過來我們的樣式
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

    function minutesLeft(expiresAt) {
        const remaining = new Date(expiresAt).getTime() - Date.now();
        if (!Number.isFinite(remaining) || remaining <= 0) return 0;
        return Math.ceil(remaining / 60000);
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
        const head = `<h4>我的房間<button class="mute push" data-act="sound" title="${soundOn ? "關掉提示音" : "打開提示音"}">${soundOn ? "🔔" : "🔕"}</button></h4>`;

        if (!code) {
            return `<div class="sec">${head}<p class="muted">在 Rift Atlas 建立房間之後，這裡就能把房號掛上布告欄。</p></div>`;
        }

        if (!state.signedIn) {
            return `<div class="sec">${head}
                <div class="row"><span class="name"><code>${escapeHtml(code)}</code></span></div>
                <p class="muted">要掛上布告欄，先在<a href="${SITE}/account" target="_blank" rel="noopener">編年史登入</a>——開一次網站就好，不用回來重整。</p>
            </div>`;
        }

        if (state.posted) {
            const left = minutesLeft(state.posted.expiresAt);
            return `<div class="sec">${head}
                <div class="row">
                    <span class="name"><code>${escapeHtml(code)}</code></span>
                    <span class="tag push ok">板上還有 ${left} 分鐘</span>
                </div>
                <div class="pair">
                    <button data-act="publish" ${state.busy ? "disabled" : ""}>再撐 20 分鐘</button>
                    <button class="ghost" data-act="takeDown" ${state.busy ? "disabled" : ""}>收掉</button>
                </div>
                ${state.message ? `<p class="${state.messageKind || "muted"}" style="margin-top:7px">${escapeHtml(state.message)}</p>` : ""}
            </div>`;
        }

        const suggested = escapeHtml(state.draft.nickname);
        return `<div class="sec">${head}
            <div class="row"><span class="name"><code>${escapeHtml(code)}</code></span></div>
            <label class="field"><span>你的稱呼</span><input data-f="nickname" maxlength="20" value="${suggested}" placeholder="小明"></label>
            <div class="pair" style="margin-bottom:6px">
                <label class="field" style="margin:0"><span>環境</span><select data-f="format">
                    <option value="current"${state.draft.format === "current" ? " selected" : ""}>只打${escapeHtml(state.sets?.currentWaveLabel || "當前環境")}</option>
                    <option value="open"${state.draft.format === "open" ? " selected" : ""}>不限</option>
                </select></label>
                <label class="field" style="margin:0"><span>賽制</span><select data-f="matchMode">
                    <option value="bo1"${state.draft.matchMode === "bo1" ? " selected" : ""}>BO1</option>
                    <option value="bo3"${state.draft.matchMode === "bo3" ? " selected" : ""}>BO3</option>
                </select></label>
            </div>
            <label class="field"><span>備註（選填）</span><input data-f="note" maxlength="40" value="${escapeHtml(state.draft.note)}" placeholder="新手，想找人陪練"></label>
            <button class="block" data-act="publish" ${state.busy ? "disabled" : ""}>${state.busy ? "掛出中…" : "掛到布告欄等對手"}</button>
            ${state.message ? `<p class="${state.messageKind || "muted"}" style="margin-top:7px">${escapeHtml(state.message)}</p>` : ""}
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
                    <span class="tag${room.format === "current" ? " cur" : ""}">${room.format === "current" ? escapeHtml(state.boardLabel || "當前環境") : "不限"}</span>
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

        panel.querySelector(".head").addEventListener("click", (event) => {
            // 鈴鐺在標題列裡，點它不該把面板收起來。
            if (event.target.closest('[data-act="sound"]')) return;
            collapsed = !collapsed;
            remember(COLLAPSE_KEY, collapsed ? "1" : "0");
            render(state);
        });

        // 打字的當下就記進 draft，否則一次背景刷新就把使用者填到一半的東西重繪掉。
        for (const field of panel.querySelectorAll("[data-f]")) {
            const key = field.dataset.f;
            field.addEventListener("input", () => {
                state.draft[key] = field.value;
            });
            field.addEventListener("change", () => {
                state.draft[key] = field.value;
            });
        }

        for (const button of panel.querySelectorAll("[data-act]")) {
            button.addEventListener("click", (event) => {
                event.stopPropagation();
                const act = button.dataset.act;
                if (act === "sound") {
                    soundOn = !soundOn;
                    remember(SOUND_KEY, soundOn ? "1" : "0");
                    if (soundOn) beep("join");
                    render(state);
                    return;
                }
                if (act === "publish") void publish(state);
                if (act === "takeDown") void takeDown(state);
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

    // ---------- 動作 ----------

    async function publish(state) {
        const code = state.session?.roomCode;
        if (!code || state.busy) return;
        const nickname = (state.draft.nickname || "").trim();
        if (!nickname) {
            state.message = "留個稱呼，對方才知道等的是誰。";
            state.messageKind = "warn";
            return render(state);
        }

        state.busy = true;
        state.message = null;
        render(state);

        const reply = await ask({
            type: "publish",
            room: {
                roomCode: code,
                nickname,
                format: state.draft.format,
                matchMode: state.draft.matchMode,
                note: state.draft.note,
            },
        });

        state.busy = false;
        if (reply.ok) {
            state.posted = reply.data.room;
            state.message = null;
            void refreshBoard(state);
        } else {
            state.message = reply.error || "掛出去失敗了";
            state.messageKind = "err";
        }
        render(state);
    }

    async function takeDown(state) {
        if (state.busy) return;
        state.busy = true;
        render(state);

        const reply = await ask({ type: "takeDown" });
        state.busy = false;
        if (reply.ok) {
            state.posted = null;
            state.message = null;
            void refreshBoard(state);
        } else {
            state.message = reply.error || "收掉失敗了";
            state.messageKind = "err";
        }
        render(state);
    }

    // ---------- 迴圈 ----------

    const state = {
        session: null,
        cards: new Map(),
        sets: null,
        rooms: null,
        boardLabel: null,
        signedIn: false,
        posted: null,
        busy: false,
        message: null,
        messageKind: "muted",
        draft: { nickname: "", format: "current", matchMode: "bo1", note: "" },
    };

    let lastFingerprint = "";
    let lastPhase = null;
    let lastPostedLeft = null;

    function fingerprint() {
        return JSON.stringify([
            state.session?.roomCode ?? null,
            state.cards.size,
            [...state.cards.keys()],
            state.rooms?.map((room) => room.roomCode) ?? null,
            Boolean(state.sets),
            state.signedIn,
            state.posted ? minutesLeft(state.posted.expiresAt) : null,
            state.busy,
            state.message,
        ]);
    }

    function renderIfChanged() {
        const next = fingerprint();
        if (next === lastFingerprint) return;
        lastFingerprint = next;
        render(state);
    }

    function refreshLocal() {
        const previous = state.session;
        state.session = readSession();
        state.cards = readDeckCards();

        // 沒填過就用 Rift Atlas 上的名字。使用者改過之後不再覆蓋——draft 是他的。
        if (!state.draft.nickname) state.draft.nickname = readPlayerName(state.session);

        // 房號換了（開了新的一間），板上那筆就不是這一間了。
        if (state.posted && state.session?.roomCode !== state.posted.roomCode) state.posted = null;

        /*
          有人進來了。

          沒有任何事件會通知我們這件事，但 Rift Atlas 自己記了對局階段：開好房間在
          等人的時候是 lobby，對手一進來就往下走（選戰場、開打）。所以「掛在板上的
          房間離開 lobby」就是那一刻——只在自己確實掛著的時候才響，單人練習跟自己
          點進別人的房間都不會誤觸。
        */
        const phase = state.session?.lastKnownPhase ?? null;
        if (state.posted && lastPhase === "lobby" && phase && phase !== "lobby") beep("join");
        if (previous || phase) lastPhase = phase;

        // 掉下板了。分頁一直開著的人不會看到那一刻，所以用聽的。
        if (state.posted) {
            const left = minutesLeft(state.posted.expiresAt);
            if (lastPostedLeft !== null && lastPostedLeft > 0 && left === 0) {
                beep("expire");
                state.posted = null;
            }
            lastPostedLeft = left;
        } else {
            lastPostedLeft = null;
        }

        renderIfChanged();
    }

    async function refreshBoard(state_) {
        const reply = await ask({ type: "rooms" });
        if (reply.ok) {
            state_.rooms = reply.data.rooms ?? [];
            state_.boardLabel = reply.data.currentWaveLabel ?? null;
            // 板上跟自己房號相同的那一筆就是自己掛的：房號是一間房的身分，兩個人
            // 掛同一個房號的意思本來就是同一間房。
            const mine = state_.rooms.find((room) => room.roomCode === state_.session?.roomCode);
            state_.posted = mine ?? (state_.session?.roomCode ? null : state_.posted);
        }
        renderIfChanged();
    }

    async function refreshSession() {
        const reply = await ask({ type: "session" });
        state.signedIn = Boolean(reply.ok && reply.data.signedIn);
        renderIfChanged();
    }

    async function loadSets() {
        const reply = await ask({ type: "cardSets" });
        if (!reply.ok) return;
        const data = reply.data;
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
        void refreshSession();
        void refreshBoard(state);
        refreshLocal();
        setInterval(refreshLocal, LOCAL_POLL_MS);
        setInterval(() => void refreshBoard(state), BOARD_POLL_MS);
        setInterval(() => void refreshSession(), BOARD_POLL_MS);
    }

    if (document.body) start();
    else document.addEventListener("DOMContentLoaded", start, { once: true });
})();
