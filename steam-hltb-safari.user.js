// ==UserScript==
// @name         Steam 游戏通关时长（Safari）
// @namespace    local.steam.hltb.safari
// @version      3.0.0
// @description  在 Steam 商店游戏页显示 HowLongToBeat 的通关时长
// @match        https://store.steampowered.com/app/*
// @match        https://store.steampowered.com/robots.txt
// @match        https://www.howlongtobeat.com/robots.txt
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM.deleteValue
// @inject-into  content
// @run-at       document-idle
// ==/UserScript==

/*
 * 查询顺序：结果缓存 → iframe 同站查询。
 *
 * Steam 商店页的 CSP 只允许嵌入 Steam 自家页面，HLTB 页面又大多带 X-Frame-Options: DENY，
 * 所以套两层隐藏 iframe：Steam 页 → Steam 的 robots.txt（无 CSP）→ HLTB 的 robots.txt（无 X-Frame-Options）。
 * 脚本在最内层以 HLTB 同站身份调用接口，结果经 GM 存储交回 Steam 页。
 *
 * 不使用 GM.xmlHttpRequest：Safari 下 Tampermonkey 的原生请求通道会一阵一阵地丢失请求或完成通知。
 * 地址带 #hltb-bench 时运行 iframe 通道测速。
 */
(function () {
    'use strict';

    const BASE_URL = 'https://www.howlongtobeat.com';
    // 为 true 时始终显示“复制 debug”按钮；默认只在失败或测速时显示。
    const DEBUG = false;
    const VERSION = '3.0.0';
    const CACHE_PREFIX = 'steam-hltb-cache-';
    const CACHE_VERSION = 1;
    const CACHE_TTL = 7 * 24 * 60 * 60 * 1000;
    const RETRY_DELAY = 300;

    // iframe 通道：实测各层 0.1～0.5 秒启动，两次同站请求合计约 0.5 秒。
    const FRAME_PREFIX = 'steam-hltb-iframe-';
    const FRAME_ATTEMPTS = 2;
    const FRAME_STAGE_TIMEOUT = 4000;
    const FRAME_RESULT_TIMEOUT = 6000;
    const RELAY_FRAME_URL = 'https://store.steampowered.com/robots.txt';
    const HLTB_FRAME_URL = `${BASE_URL}/robots.txt`;
    const RELAY_ROLE = 'steam-hltb-relay';
    const HLTB_ROLE = 'steam-hltb-probe';

    const BENCH_ROUNDS = 6;
    const BENCH_GAP = 800;

    const debugLog = [];
    let visibleBadge = null;

    // ---------- 日志与通用工具 ----------

    // 记录各阶段状态，不保存令牌或接口响应正文。
    function log(stage, detail = '') {
        const line = `[${new Date().toISOString()}] ${stage}${detail ? `：${detail}` : ''}`;
        debugLog.push(line);
        if (debugLog.length > 600) debugLog.shift();
    }

    function errorText(error) {
        return error instanceof Error ? `${error.message}${error.stack ? `\n${error.stack}` : ''}` : String(error);
    }

    // 复制当前诊断信息；剪贴板不可用时展示可手动复制的文本框。
    async function copyDebug(button) {
        const report = [`Steam HLTB v${VERSION}`, `页面：${location.hostname}${location.pathname}`, ...debugLog].join('\n');
        try {
            await navigator.clipboard.writeText(report);
            button.textContent = '已复制调试日志';
        } catch (_) {
            const area = document.createElement('textarea');
            area.value = report;
            area.readOnly = true;
            area.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;width:360px;height:150px;';
            document.body.appendChild(area);
            area.select();
            try {
                if (!document.execCommand('copy')) throw new Error('复制命令失败');
                button.textContent = '已复制调试日志';
            } catch (_) { button.textContent = '请手动复制下方日志'; }
        }
    }

    // 记录脚本运行环境与查询策略。
    function logEnvironment() {
        log('脚本启动', `版本=${VERSION}，站点=${location.hostname}，GM=${typeof globalThis.GM}`);
        log('脚本管理器能力', [
            `名称=${globalThis.GM?.info?.scriptHandler || '未知'}`,
            `版本=${globalThis.GM?.info?.version || '未知'}`,
            `读存储=${typeof globalThis.GM?.getValue}`,
            `写存储=${typeof globalThis.GM?.setValue}`
        ].join('，'));
        log('查询策略', `iframe 最多 ${FRAME_ATTEMPTS} 次，缓存有效期 ${CACHE_TTL / 1000} 秒`);
    }

    // 统一脚本管理器的异步存储接口。
    async function storage(method, key, value) {
        const api = globalThis.GM?.[method];
        if (typeof api !== 'function') throw new Error('脚本管理器缺少存储权限');
        return method === 'setValue' ? api(key, value) : api(key);
    }

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // 生成跨页面任务 ID，只含小写字母、数字和连字符。
    function newTaskId() {
        return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
    }

    // ---------- 重试策略 ----------

    // 生成可重试的错误（超时、网络中断、请求丢失），kind 用于测速时统计失败类型。
    function transientError(message, kind = '其他') {
        const error = new Error(message);
        error.transient = true;
        error.kind = kind;
        return error;
    }

    // 令牌失效时 HLTB 会返回 403 或 404。
    function isTokenRejected(error) {
        return error?.status === 403 || error?.status === 404;
    }

    // 判断错误是否值得重试：请求丢失、令牌失效、限流或服务端错误。
    function isRetryable(error) {
        if (error?.transient) return true;
        const status = error?.status;
        return isTokenRejected(error) || status === 429 || (Number.isFinite(status) && status >= 500);
    }

    // 按次数重试异步任务，只对可恢复的错误重试。
    async function withRetry(task, { attempts, shouldRetry, onRetry = () => {}, delay = 0 }) {
        for (let attempt = 1; ; attempt++) {
            try { return await task(attempt); }
            catch (error) {
                if (attempt >= attempts || !shouldRetry(error)) throw error;
                onRetry(error, attempt + 1);
                if (delay > 0) await sleep(delay);
            }
        }
    }

    // ---------- 名称匹配 ----------

    // 搜索前清理商标符号，并将冒号等分隔符转为空格。
    function cleanSearchName(name) {
        return String(name || '').replace(/[®™©℠]/g, '').normalize('NFKC')
            .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    }

    // 严格核对游戏名，避免把 DLC 或相似游戏的时长误显示为本体。
    function normalizeName(name) {
        return cleanSearchName(name).toLowerCase();
    }

    function findGame(results, name) {
        if (!Array.isArray(results?.data)) throw new Error('查询结果格式有误');
        const target = normalizeName(name);
        return results.data.find(game => normalizeName(game.game_name) === target)
            || results.data.find(game => String(game.game_alias || '').split(/[,;|]/)
                .some(alias => normalizeName(alias) === target));
    }

    // 将通关时长从秒转换成小时。
    function formatHours(seconds) {
        if (!Number.isFinite(seconds) || seconds <= 0) return '暂无数据';
        return `${(Math.round(seconds / 360) / 10).toLocaleString('zh-CN')} 小时`;
    }

    // 检查精简后的游戏信息是否可以直接展示。
    function isValidGame(game) {
        return Number.isInteger(game?.id) && game.id > 0 && typeof game.name === 'string'
            && Number.isFinite(game.compAll) && game.compAll > 0;
    }

    // 生成“没有时长数据”错误：新游戏常见的正常情况，不算异常；label 用于按钮显示。
    function noDataError(message, label) {
        const error = new Error(message);
        error.noData = true;
        error.label = label;
        return error;
    }

    // 从查询结果中挑出同名游戏，并精简为展示与缓存所需字段。
    function pickGame(results, name) {
        const found = findGame(results, name);
        if (!found) throw noDataError('未找到同名游戏', '未收录');
        const game = { id: found.game_id, name: String(found.game_name), compAll: found.comp_all };
        if (!Number.isInteger(game.id) || game.id <= 0) throw new Error('游戏详情地址无效');
        if (!isValidGame(game)) throw noDataError('暂无综合时长', '暂无时长');
        return game;
    }

    // ---------- 结果缓存 ----------

    function createCacheEntry(game, now) {
        return { version: CACHE_VERSION, savedAt: now, game };
    }

    // 判断缓存条目是否完整且未过期。
    function isCacheFresh(entry, now) {
        if (entry?.version !== CACHE_VERSION || !Number.isFinite(entry.savedAt)) return false;
        const age = now - entry.savedAt;
        return age >= 0 && age < CACHE_TTL && isValidGame(entry.game);
    }

    // 读取某个 App 的缓存结果；地址带 #hltb-refresh 时强制重新查询。
    async function readCache(appId) {
        if (location.hash.includes('hltb-refresh')) {
            log('跳过缓存', '地址包含 #hltb-refresh');
            return null;
        }
        try {
            const entry = await storage('getValue', CACHE_PREFIX + appId);
            if (!entry) {
                log('缓存未命中', `App ID ${appId}`);
                return null;
            }
            if (!isCacheFresh(entry, Date.now())) {
                log('缓存已过期或无效', `App ID ${appId}`);
                return null;
            }
            log('命中缓存', `${entry.game.name}，HLTB ID ${entry.game.id}，保存于 ${new Date(entry.savedAt).toISOString()}`);
            return entry.game;
        } catch (error) {
            log('读取缓存失败', errorText(error));
            return null;
        }
    }

    // 保存查询结果，写入失败不影响页面展示。
    async function writeCache(appId, game) {
        try {
            await storage('setValue', CACHE_PREFIX + appId, createCacheEntry(game, Date.now()));
            log('已写入缓存', `App ID ${appId}`);
        } catch (error) {
            log('写入缓存失败', errorText(error));
        }
    }

    // ---------- HLTB 接口 ----------

    // 检查接口状态并解析 JSON。
    function parseResponse(response) {
        if (response.status !== 200) {
            const error = new Error(`接口返回 ${response.status || '未知状态'}`);
            error.status = response.status;
            throw error;
        }
        try { return JSON.parse(response.responseText); }
        catch (_) { throw new Error('接口返回的数据格式有误'); }
    }

    // 构造与 HowLongToBeat 当前网页一致的搜索参数。
    function searchBody(name) {
        const emptyFilter = () => ({ mode: 'include', values: [] });
        return {
            searchType: 'games', searchTerms: name.split(/\s+/), searchPage: 1, size: 20,
            searchOptions: {
                games: {
                    userId: 0, platform: emptyFilter(), sortCategory: 'popular', rangeCategory: 'main',
                    rangeTime: { min: null, max: null },
                    gameplay: { perspective: emptyFilter(), flow: emptyFilter(), genre: emptyFilter() },
                    year: emptyFilter(), modifier: ''
                },
                users: { sortCategory: 'postcount' }, lists: { sortCategory: 'follows' },
                filter: '', sort: 0, randomizer: 0
            },
            useCache: true
        };
    }

    // 在 HLTB 自己的页面里查询，由浏览器自动发送同站 Referer。
    async function searchSameSite(name) {
        log('同站查询开始', name);
        const initResponse = await fetch(`/api/search/site/init?t=${Date.now()}`, {
            credentials: 'same-origin', referrer: `${BASE_URL}/`
        });
        log('同站令牌请求', `HTTP ${initResponse.status}`);
        const init = parseResponse({ status: initResponse.status, responseText: await initResponse.text() });
        if (!init.token) throw new Error('没有获得查询令牌');
        const response = await fetch('/api/search/site', {
            method: 'POST', credentials: 'same-origin', referrer: `${BASE_URL}/`,
            headers: { 'Content-Type': 'application/json', 'x-auth-token': init.token },
            body: JSON.stringify(searchBody(name))
        });
        log('同站搜索请求', `HTTP ${response.status}`);
        return parseResponse({ status: response.status, responseText: await response.text() });
    }

    // ---------- iframe 同站查询：iframe 内的两层 ----------

    // 生成传给 iframe 的 hash 参数。
    function frameTaskHash(role, id, name) {
        return `#${role}=${id}&name=${encodeURIComponent(name)}`;
    }

    // 从 iframe 的 hash 中解析任务参数，格式不合法时返回 null。
    function parseFrameTask(hash, role) {
        const params = new URLSearchParams(String(hash || '').replace(/^#/, ''));
        const id = params.get(role);
        const name = params.get('name');
        if (!id || !/^[a-z0-9-]{8,60}$/.test(id) || !name || name.length > 200) return null;
        return { id, name };
    }

    // 一次 iframe 任务在 GM 存储中使用的三个键：中转层日志、HLTB 层日志、最终结果。
    function frameKeys(id) {
        return {
            relay: `${FRAME_PREFIX}${id}-relay`,
            hltb: `${FRAME_PREFIX}${id}-hltb`,
            result: `${FRAME_PREFIX}${id}-result`
        };
    }

    // 创建不可见、不可聚焦的 iframe。
    function createHiddenFrame(url) {
        const frame = document.createElement('iframe');
        frame.src = url;
        frame.tabIndex = -1;
        frame.setAttribute('aria-hidden', 'true');
        frame.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:1px;height:1px;border:0;visibility:hidden;';
        (document.body || document.documentElement).appendChild(frame);
        return frame;
    }

    // 第一层：Steam 自家 robots.txt，只负责再嵌入 HLTB 的 robots.txt，并报告自己已运行。
    async function runRelayFrame() {
        const task = parseFrameTask(location.hash, RELAY_ROLE);
        if (!task) return;
        log('中转层已运行', `文档类型=${document.contentType}`);
        createHiddenFrame(HLTB_FRAME_URL + frameTaskHash(HLTB_ROLE, task.id, task.name));
        await storage('setValue', frameKeys(task.id).relay, debugLog.slice());
    }

    // 第二层：HLTB 自己的 robots.txt，以同站身份查询并把结果写回 GM 存储。
    async function runHltbFrame() {
        const task = parseFrameTask(location.hash, HLTB_ROLE);
        if (!task) return;
        const keys = frameKeys(task.id);
        log('HLTB 层已运行', `文档类型=${document.contentType}`);
        await storage('setValue', keys.hltb, debugLog.slice());
        let result;
        try { result = { ok: true, data: await searchSameSite(task.name) }; }
        catch (error) {
            log('HLTB 层查询失败', error.message);
            result = { ok: false, error: error.message, status: error.status };
        }
        result.trace = debugLog.slice();
        await storage('setValue', keys.result, result);
    }

    // ---------- iframe 同站查询：Steam 页一侧 ----------

    // 按卡住的阶段生成错误：前两层没运行属于结构性问题（外部条件变化），重试也没用，直接报错。
    function frameStageError(stage) {
        if (stage === 'relay') {
            const error = new Error('iframe 中转层未运行（Steam robots.txt 未加载或脚本未注入）');
            error.kind = '中转层未运行';
            return error;
        }
        if (stage === 'hltb') {
            const error = new Error('iframe HLTB 层未运行（可能被禁止嵌入或脚本未注入）');
            error.kind = 'HLTB 层未运行';
            return error;
        }
        return transientError('iframe 查询超时（HLTB 层已运行但没有返回结果）', '结果超时');
    }

    // 把 iframe 各层回传的日志并入当前日志。
    function mergeFrameTrace(label, trace) {
        if (Array.isArray(trace)) debugLog.push(...trace.map(line => `  [${label}] ${line}`));
    }

    // 轮询 GM 存储直到拿到值或超时。
    async function waitForValue(key, timeout) {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
            const value = await storage('getValue', key);
            if (value) return value;
            await sleep(200);
        }
        return null;
    }

    // 依次等待中转层、HLTB 层和最终结果，超时时指明卡在哪一层。
    async function awaitFrameResult(keys) {
        const relayTrace = await waitForValue(keys.relay, FRAME_STAGE_TIMEOUT);
        mergeFrameTrace('中转层', relayTrace);
        if (!relayTrace) throw frameStageError('relay');
        const hltbTrace = await waitForValue(keys.hltb, FRAME_STAGE_TIMEOUT);
        if (!hltbTrace) throw frameStageError('hltb');
        const result = await waitForValue(keys.result, FRAME_RESULT_TIMEOUT);
        mergeFrameTrace('HLTB 层', result?.trace || hltbTrace);
        if (!result) throw frameStageError('result');
        if (!result.ok) {
            const error = new Error(`HLTB 层查询失败：${result.error}`);
            error.status = result.status;
            throw error;
        }
        return result.data;
    }

    // 通过两层隐藏 iframe 查询一次，结束后移除 iframe 并清理存储。
    async function searchThroughFrames(name) {
        const id = newTaskId();
        const keys = frameKeys(id);
        const startedAt = Date.now();
        log('iframe 查询开始', `任务 ${id}`);
        const frame = createHiddenFrame(RELAY_FRAME_URL + frameTaskHash(RELAY_ROLE, id, name));
        try {
            const data = await awaitFrameResult(keys);
            log('iframe 查询成功', `耗时=${Date.now() - startedAt} 毫秒`);
            return data;
        } finally {
            frame.remove();
            for (const key of Object.values(keys)) {
                try { await storage('deleteValue', key); } catch (_) { /* 清理失败不影响页面 */ }
            }
        }
    }

    // ---------- 查询编排 ----------

    // iframe 同站查询，只对偶发超时、限流等可恢复错误重试。
    async function queryGame(name) {
        return withRetry(() => searchThroughFrames(name), {
            attempts: FRAME_ATTEMPTS, shouldRetry: isRetryable, delay: RETRY_DELAY,
            onRetry: (error, next) => log('iframe 查询重试', `原因=${error.message}，下一次=第 ${next}/${FRAME_ATTEMPTS} 次`)
        });
    }

    // ---------- 通道测速（地址带 #hltb-bench 时运行） ----------

    // 汇总某一组测速结果：成功率、中位耗时、最慢耗时与失败类型。
    function summarizeBench(results, group) {
        const rows = results.filter(row => row.group === group);
        const times = rows.filter(row => row.ok).map(row => row.ms).sort((a, b) => a - b);
        const kinds = {};
        rows.filter(row => !row.ok).forEach(row => { kinds[row.kind] = (kinds[row.kind] || 0) + 1; });
        const failText = Object.entries(kinds).map(([kind, count]) => `${kind}×${count}`).join('，') || '无';
        const timing = times.length
            ? `中位=${times[Math.floor((times.length - 1) / 2)]} 毫秒，最慢=${times[times.length - 1]} 毫秒`
            : '无成功样本';
        return `${group}：成功 ${times.length}/${rows.length}，${timing}，失败类型=${failText}`;
    }

    // 执行一次测速任务，把结果归一成 { ok, ms, kind, value }。
    async function measure(task) {
        const startedAt = Date.now();
        try {
            const value = await task();
            return { ok: true, ms: Date.now() - startedAt, value };
        } catch (error) {
            const kind = error.kind || (error.status ? `HTTP ${error.status}` : error.message);
            return { ok: false, ms: Date.now() - startedAt, kind };
        }
    }

    // 连续做若干次 iframe 完整查询（不重试、不读写缓存），检查通道是否仍然稳定。
    async function runBench(ui, name) {
        const group = 'iframe 同站查询';
        const results = [];
        log('通道测速开始', `${group} ${BENCH_ROUNDS} 次，间隔 ${BENCH_GAP} 毫秒`);
        for (let round = 1; round <= BENCH_ROUNDS; round++) {
            ui.showStatus(`测速 ${round}/${BENCH_ROUNDS}`);
            results.push({ group, ...await measure(() => searchThroughFrames(name)) });
            await sleep(BENCH_GAP);
        }
        log('通道测速结果', summarizeBench(results, group));
        ui.showStatus('测速完成，请复制 debug');
    }

    // ---------- Steam 页面 ----------

    function steamAppId() {
        return location.pathname.match(/^\/app\/(\d+)/)?.[1] || null;
    }

    // 读取 Steam 英文名称，处理商店页面的中文本地化标题。
    async function englishName(localizedName, appId) {
        if (!appId) {
            log('读取 Steam App ID 失败', location.pathname);
            return localizedName;
        }
        try {
            const response = await fetch(`/api/appdetails?appids=${appId}&l=english`, { credentials: 'same-origin' });
            log('Steam 英文名请求', `App ID ${appId}，HTTP ${response.status}`);
            if (!response.ok) return localizedName;
            const entries = Object.values(await response.json());
            const entry = entries.find(item => item?.success && Number(item.data?.steam_appid) === Number(appId));
            const name = entry?.data?.name?.trim() || localizedName;
            log('搜索名称', name);
            return name;
        } catch (error) {
            log('Steam 英文名请求失败', errorText(error));
            return localizedName;
        }
    }

    // 由页面标题得到清理后的英文搜索名。
    async function resolveSearchName(header, appId) {
        const localizedName = header.title?.textContent?.trim();
        if (!localizedName) throw new Error('未找到游戏标题');
        log('Steam 页面标题', localizedName);
        const name = cleanSearchName(await englishName(localizedName, appId));
        if (!name) throw new Error('游戏名称为空');
        log('清理后的搜索名称', name);
        return name;
    }

    // 等待 Steam 标题与社区按钮容器出现。
    async function waitForSteamHeader() {
        const find = () => ({
            title: document.querySelector('.apphub_AppName'),
            actions: document.querySelector('.apphub_OtherSiteInfo')
        });
        const existing = find();
        if (existing.title && existing.actions) return existing;
        log('等待 Steam 游戏标题和按钮容器');
        return new Promise(resolve => {
            const observer = new MutationObserver(() => {
                const header = find();
                if (header.title && header.actions) finish(header);
            });
            const finish = header => {
                clearTimeout(timer);
                observer.disconnect();
                resolve(header);
            };
            const timer = setTimeout(() => finish(find()), 10000);
            observer.observe(document.documentElement, { childList: true, subtree: true });
        });
    }

    const HLTB_TITLE = 'HowLongToBeat';
    const STYLE_ID = 'steam-hltb-safari-style';

    // HLTB 官方 logo 的单色圆角图标：圆角方块用按钮文字颜色填充，H 挖空透出按钮底色。
    // evenodd 规则下：方块 → 填充；H 外框 → 挖空；H 上下两道窄缝 → 再次填充。
    const LOGO_SVG = '<svg class="steam-hltb-logo" viewBox="0 0 16 16" aria-hidden="true" focusable="false">'
        + '<path fill="currentColor" fill-rule="evenodd" d="'
        + 'M3.5 0H12.5A3.5 3.5 0 0 1 16 3.5V12.5A3.5 3.5 0 0 1 12.5 16H3.5A3.5 3.5 0 0 1 0 12.5V3.5A3.5 3.5 0 0 1 3.5 0Z'
        + 'M5.2 3H10.8V13H5.2Z'
        + 'M7.4 3H8.6V6.9H7.4Z'
        + 'M7.4 9.1H8.6V13H7.4Z"/></svg>';

    // 按钮内部样式与读取中的圆环动画，只注入一次；系统开启“减少动态效果”时放慢转速。
    function ensureBadgeStyles() {
        if (document.getElementById(STYLE_ID)) return;
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = `
            /* Steam 的 .btn_medium > span 是 block、line-height 30px；用块级 flex 且高度等于一行（1lh），
               不产生需要基线对齐的行盒，避免按钮被撑高；读取中只有图标时也保持同样高度。 */
            .steam-hltb-content { display: flex; align-items: center; gap: 6px; height: 30px; height: 1lh; }
            /* flex 内首项是 SVG，没有文字基线，按钮默认的基线对齐会让它比“社区中心”高出一截；两者等高，改为顶端对齐。 */
            #steam-hltb-safari-badge { vertical-align: top; }
            .steam-hltb-logo { width: 16px; height: 16px; flex: none; }
            .steam-hltb-spinner {
                width: 12px; height: 12px; box-sizing: border-box; flex: none;
                border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%;
                animation: steam-hltb-spin 0.8s linear infinite;
            }
            @keyframes steam-hltb-spin { to { transform: rotate(360deg); } }
            @media (prefers-reduced-motion: reduce) { .steam-hltb-spinner { animation-duration: 2.4s; } }
        `;
        document.head.appendChild(style);
    }

    /**
     * Steam 页上的 HLTB 按钮
     * 1) 与“社区中心”同尺寸的 Steam 原生按钮，内容为圆角 H 图标 + 圆环或文字
     * 2) 切换读取中、成功、无数据、失败、测速等状态，并同步悬停提示
     * 3) 管理“复制 debug”按钮：只在失败或测速时显示
     */
    class HltbBadge {
        constructor(actions) {
            ensureBadgeStyles();
            this.link = document.createElement('a');
            this.link.id = 'steam-hltb-safari-badge';
            this.link.className = 'btnv6_blue_hoverfade btn_medium';
            this.link.href = BASE_URL;
            this.link.target = '_blank';
            this.link.rel = 'noopener noreferrer';
            this.link.style.marginRight = '5px';
            const outer = document.createElement('span');
            this.content = document.createElement('span');
            this.content.className = 'steam-hltb-content';
            outer.appendChild(this.content);
            this.link.appendChild(outer);
            this.debugButton = this.createDebugButton();
            actions.insertBefore(this.debugButton, actions.firstChild);
            actions.insertBefore(this.link, this.debugButton);
            this.showLoading();
        }

        createDebugButton() {
            const button = document.createElement('button');
            button.textContent = '复制 debug';
            button.style.cssText = `display:${DEBUG ? 'inline-block' : 'none'};margin-right:5px;cursor:pointer;`;
            button.addEventListener('click', () => copyDebug(button));
            return button;
        }

        // 渲染 logo 加一段内容（圆环或文字），并更新悬停提示。
        render(tooltip, text) {
            this.content.innerHTML = LOGO_SVG;
            const tail = document.createElement('span');
            if (text === null) tail.className = 'steam-hltb-spinner';
            else tail.textContent = text;
            this.content.appendChild(tail);
            this.link.title = tooltip;
            this.link.setAttribute('aria-label', tooltip);
        }

        showLoading() {
            this.render(`${HLTB_TITLE} 读取中…`, null);
        }

        setSearchLink(name) {
            this.link.href = `${BASE_URL}/?q=${encodeURIComponent(name)}`;
        }

        showGame(game) {
            const hours = formatHours(game.compAll);
            this.render(`${HLTB_TITLE} 综合时长：${hours}`, hours);
            this.link.href = `${BASE_URL}/game/${game.id}`;
        }

        // 未收录或暂无时长属于正常情况，不显示 debug 按钮。
        showNoData(error) {
            const tooltip = error.label === '未收录'
                ? `${HLTB_TITLE} 未收录此游戏，点击去网站搜索`
                : `${HLTB_TITLE} 暂无综合时长`;
            this.render(tooltip, error.label);
        }

        showError(error) {
            this.render(`${HLTB_TITLE} 读取失败：${error.message}`, '读取失败');
            this.revealDebug();
        }

        // 测速等诊断模式直接显示状态文字。
        showStatus(text) {
            this.render(`${HLTB_TITLE} ${text}`, text);
            this.revealDebug();
        }

        revealDebug() {
            this.debugButton.style.display = 'inline-block';
        }
    }

    // 在 Steam 游戏页查找并显示通关时长，优先使用缓存。
    async function runSteamPage() {
        if (document.getElementById('steam-hltb-safari-badge')) return;
        const header = await waitForSteamHeader();
        if (!header.actions) throw new Error('未找到社区中心按钮容器');
        const ui = new HltbBadge(header.actions);
        visibleBadge = ui;
        log('时长按钮已显示');
        const startedAt = Date.now();
        try {
            const appId = steamAppId();
            if (location.hash.includes('hltb-bench')) {
                await runBench(ui, await resolveSearchName(header, appId));
                return;
            }
            const cached = appId ? await readCache(appId) : null;
            if (cached) {
                ui.showGame(cached);
                return;
            }
            const name = await resolveSearchName(header, appId);
            ui.setSearchLink(name);
            const game = pickGame(await queryGame(name), name);
            log('匹配游戏', `${game.name}，HLTB ID ${game.id}`);
            ui.showGame(game);
            if (appId) await writeCache(appId, game);
        } catch (error) {
            if (error.noData) {
                log('没有时长数据', error.message);
                ui.showNoData(error);
            } else {
                log('查询失败', errorText(error));
                ui.showError(error);
            }
        } finally {
            log('查询总耗时', `${Date.now() - startedAt} 毫秒`);
        }
    }

    // ---------- 启动 ----------

    // 判断当前文档是否位于 iframe；Tampermonkey 沙盒里的 window 可能是代理对象，优先用 ancestorOrigins。
    function isInFrame() {
        if (location.ancestorOrigins) return location.ancestorOrigins.length > 0;
        try { return window.self !== window.top; } catch (_) { return true; }
    }

    // robots.txt 只在 iframe 中作为跳板；Steam 游戏页只在顶层运行。
    function start() {
        const inFrame = isInFrame();
        const onRobots = location.pathname === '/robots.txt';
        if (inFrame) {
            if (!onRobots) return;
            log('脚本启动', `版本=${VERSION}，iframe，站点=${location.hostname}`);
            const run = location.hostname === 'www.howlongtobeat.com' ? runHltbFrame : runRelayFrame;
            run().catch(error => log('iframe 层异常', errorText(error)));
            return;
        }
        if (location.hostname !== 'store.steampowered.com' || onRobots) return;
        logEnvironment();
        runSteamPage().catch(error => {
            log('Steam 页面异常', errorText(error));
            visibleBadge?.showError(error);
        });
    }

    // Node 环境（单元测试）只导出纯函数，不启动页面逻辑。
    if (typeof location === 'undefined' && typeof module === 'object') {
        module.exports = {
            cleanSearchName, normalizeName, findGame, pickGame, formatHours, searchBody,
            withRetry, isRetryable, isTokenRejected, transientError, summarizeBench,
            frameTaskHash, parseFrameTask, frameKeys, frameStageError,
            createCacheEntry, isCacheFresh, CACHE_TTL, CACHE_VERSION
        };
        return;
    }
    start();
})();
