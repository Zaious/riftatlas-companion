/**
 * 在編年史的分頁上跑，把登入狀態交給擴充。
 *
 * 面板要能直接掛房間，就得證明「你是誰」，而登入是在編年史完成的。這支只做一件
 * 事：使用者開編年史任何一頁時，把已經存在瀏覽器裡的 Supabase session 複製到擴充
 * 的儲存區。沒有自己的登入流程、不碰密碼、也不替使用者登入任何東西。
 *
 * 為什麼可以只是「複製」：那份 session 本來就存在這個網域的 localStorage 裡，是
 * 網站自己放的；擴充讀它，跟網站自己讀它是同一份東西、同樣的權限。也因為如此，
 * 保持新鮮不需要額外機制——supabase-js 會在頁面上自動續期並寫回 localStorage，
 * 這支每次載入時再抄一次就好。
 *
 * 登出後 session 會從 localStorage 消失，這裡跟著清掉擴充的副本。
 */

(() => {
    "use strict";

    const KEY_PATTERN = /^sb-.+-auth-token$/;

    function readSession() {
        for (let i = 0; i < localStorage.length; i += 1) {
            const key = localStorage.key(i);
            if (!key || !KEY_PATTERN.test(key)) continue;
            try {
                const value = JSON.parse(localStorage.getItem(key));
                if (value?.access_token) {
                    return {
                        accessToken: value.access_token,
                        // 秒，Supabase 的格式。background 用它判斷要不要先請使用者回站續期。
                        expiresAt: Number(value.expires_at) || 0,
                    };
                }
            } catch {
                /* 壞掉的那一筆跳過，繼續找 */
            }
        }
        return null;
    }

    function sync() {
        const session = readSession();
        try {
            if (session) chrome.storage.local.set({ chronicleSession: session });
            else chrome.storage.local.remove("chronicleSession");
        } catch {
            /* 擴充正在更新或已停用；下次開頁再同步 */
        }
    }

    sync();

    // 登入與登出都不會重載頁面，session 是在原地被寫進 localStorage 的。隔一段時間
    // 再抄一次，剛登入的人就不必為了讓面板認得他而重新整理。
    setInterval(sync, 15000);
})();
