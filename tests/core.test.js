// 用户脚本纯函数的单元测试，运行：node --test tests/*.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../steam-hltb-safari.user.js');

const game = { id: 187784, name: 'IRON NEST: Heavy Turret Simulator', compAll: 36000 };

// 构造带状态码的接口错误
function statusError(status) {
    const error = new Error(`接口返回 ${status}`);
    error.status = status;
    return error;
}

test('cleanSearchName 去除商标符号并把分隔符转为空格', () => {
    assert.equal(core.cleanSearchName('IRON NEST: Heavy Turret Simulator™'), 'IRON NEST Heavy Turret Simulator');
    assert.equal(core.cleanSearchName(null), '');
});

test('pickGame 按名称或别名匹配，并精简字段', () => {
    const results = { data: [
        { game_id: 1, game_name: 'IRON NEST DLC', comp_all: 100 },
        { game_id: 187784, game_name: 'IRON NEST: Heavy Turret Simulator', comp_all: 36000 }
    ] };
    assert.deepEqual(core.pickGame(results, 'IRON NEST Heavy Turret Simulator'), game);
    const aliasResults = { data: [{ game_id: 2, game_name: '其他名字', game_alias: 'Foo, Bar Baz', comp_all: 3600 }] };
    assert.equal(core.pickGame(aliasResults, 'bar baz').id, 2);
});

test('pickGame 找不到或无时长时报错', () => {
    assert.throws(() => core.pickGame({ data: [] }, 'x'), /未找到同名游戏/);
    assert.throws(() => core.pickGame({ data: [{ game_id: 3, game_name: 'x', comp_all: 0 }] }, 'x'), /暂无综合时长/);
    assert.throws(() => core.pickGame({}, 'x'), /查询结果格式有误/);
});

test('pickGame 没有时长数据属于正常情况，其他问题才是异常', () => {
    const capture = fn => { try { fn(); } catch (error) { return error; } return null; };
    const notFound = capture(() => core.pickGame({ data: [] }, 'x'));
    assert.equal(notFound.noData, true);
    assert.equal(notFound.label, '未收录');
    const noTime = capture(() => core.pickGame({ data: [{ game_id: 3, game_name: 'x', comp_all: 0 }] }, 'x'));
    assert.equal(noTime.noData, true);
    assert.equal(noTime.label, '暂无时长');
    assert.equal(capture(() => core.pickGame({}, 'x')).noData, undefined);
    assert.equal(capture(() => core.pickGame({ data: [{ game_id: 0, game_name: 'x', comp_all: 10 }] }, 'x')).noData, undefined);
});

test('formatHours 转换为保留一位小数的小时', () => {
    assert.equal(core.formatHours(36000), '10 小时');
    assert.equal(core.formatHours(5400), '1.5 小时');
    assert.equal(core.formatHours(0), '暂无数据');
});

test('isRetryable 只重试可恢复的错误', () => {
    assert.equal(core.isRetryable(core.transientError('请求超时')), true);
    for (const status of [403, 404, 429, 500, 503]) assert.equal(core.isRetryable(statusError(status)), true);
    assert.equal(core.isRetryable(statusError(400)), false);
    assert.equal(core.isRetryable(new Error('接口返回的数据格式有误')), false);
});

test('withRetry 在可恢复错误后重试直至成功', async () => {
    const retries = [];
    let calls = 0;
    const result = await core.withRetry(async attempt => {
        calls++;
        if (attempt < 3) throw core.transientError('请求超时');
        return 'ok';
    }, { attempts: 3, shouldRetry: core.isRetryable, onRetry: (_, next) => retries.push(next) });
    assert.equal(result, 'ok');
    assert.equal(calls, 3);
    assert.deepEqual(retries, [2, 3]);
});

test('withRetry 达到次数上限或遇到不可重试错误时抛出', async () => {
    let calls = 0;
    await assert.rejects(core.withRetry(async () => { calls++; throw core.transientError('请求超时'); },
        { attempts: 3, shouldRetry: core.isRetryable }), /请求超时/);
    assert.equal(calls, 3);
    calls = 0;
    await assert.rejects(core.withRetry(async () => { calls++; throw statusError(400); },
        { attempts: 3, shouldRetry: core.isRetryable }), /400/);
    assert.equal(calls, 1);
});

test('isCacheFresh 校验版本、有效期与内容', () => {
    const now = 1_800_000_000_000;
    const entry = core.createCacheEntry(game, now);
    assert.equal(core.isCacheFresh(entry, now + 1000), true);
    assert.equal(core.isCacheFresh(entry, now + core.CACHE_TTL), false);
    assert.equal(core.isCacheFresh(entry, now - 1000), false);
    assert.equal(core.isCacheFresh({ ...entry, version: core.CACHE_VERSION + 1 }, now), false);
    assert.equal(core.isCacheFresh(core.createCacheEntry({ ...game, compAll: 0 }, now), now), false);
    assert.equal(core.isCacheFresh(null, now), false);
});

test('searchBody 按空格拆分搜索词', () => {
    assert.deepEqual(core.searchBody('IRON NEST').searchTerms, ['IRON', 'NEST']);
});

test('summarizeBench 统计成功率、中位耗时与失败类型', () => {
    const results = [
        { group: 'fetch=false GET init', ok: true, ms: 900 },
        { group: 'fetch=false GET init', ok: true, ms: 1200 },
        { group: 'fetch=false GET init', ok: true, ms: 2000 },
        { group: 'fetch=false GET init', ok: false, ms: 6500, kind: '无回调丢失' },
        { group: 'fetch=false GET init', ok: false, ms: 2800, kind: '停滞' },
        { group: 'fetch=false GET init', ok: false, ms: 2900, kind: '停滞' },
        { group: 'fetch=true GET init', ok: false, ms: 10, kind: 'HTTP 404' }
    ];
    assert.equal(core.summarizeBench(results, 'fetch=false GET init'),
        'fetch=false GET init：成功 3/6，中位=1200 毫秒，最慢=2000 毫秒，失败类型=无回调丢失×1，停滞×2');
    assert.equal(core.summarizeBench(results, 'fetch=true GET init'),
        'fetch=true GET init：成功 0/1，无成功样本，失败类型=HTTP 404×1');
});

test('frameTaskHash 与 parseFrameTask 往返一致，并拒绝不合法参数', () => {
    const hash = core.frameTaskHash('steam-hltb-relay', 'abc123-xyz', 'IRON NEST: Heavy & Turret+');
    assert.deepEqual(core.parseFrameTask(hash, 'steam-hltb-relay'), { id: 'abc123-xyz', name: 'IRON NEST: Heavy & Turret+' });
    assert.equal(core.parseFrameTask(hash, 'steam-hltb-probe'), null);
    assert.equal(core.parseFrameTask('#steam-hltb-relay=BAD_ID!&name=x', 'steam-hltb-relay'), null);
    assert.equal(core.parseFrameTask('#steam-hltb-relay=abc123-xyz', 'steam-hltb-relay'), null);
    assert.equal(core.parseFrameTask('', 'steam-hltb-relay'), null);
});

test('frameStageError 前两层未运行时不重试，结果超时才重试', () => {
    assert.equal(core.isRetryable(core.frameStageError('relay')), false);
    assert.equal(core.isRetryable(core.frameStageError('hltb')), false);
    assert.equal(core.isRetryable(core.frameStageError('result')), true);
    assert.equal(core.frameStageError('relay').kind, '中转层未运行');
});

test('frameKeys 为同一任务生成三个不同的存储键', () => {
    const keys = core.frameKeys('abc123-xyz');
    assert.equal(new Set(Object.values(keys)).size, 3);
    Object.values(keys).forEach(key => assert.match(key, /abc123-xyz/));
});
