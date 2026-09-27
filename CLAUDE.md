# Steam HLTB Safari 用户脚本

在 Steam 商店游戏页显示 HowLongToBeat（HLTB）的综合通关时长，目标环境是 Safari + Tampermonkey。

## 文件
- `steam-hltb-safari.user.js`：唯一的脚本文件，按区块组织：日志与通用工具 / 重试策略 / 名称匹配 / 结果缓存 / HLTB 接口 / iframe 同站查询（iframe 内两层、Steam 页一侧）/ 查询编排 / 通道测速 / Steam 页面 / 启动。
- `tests/core.test.js`：纯函数的单元测试，运行 `node --test tests/*.test.js`。脚本在 Node 下（没有 `location`）只导出纯函数，不启动页面逻辑。

## 查询流程（v3.0）
1. 读取缓存 `GM.getValue('steam-hltb-cache-<appId>')`，有效期 7 天；地址带 `#hltb-refresh` 时跳过缓存。
2. 通过 Steam 的 `/api/appdetails?l=english` 取得英文名，清理后作为搜索词。
3. **iframe 同站查询**（唯一的查询通道），最多尝试 2 次：
   - Steam 页 → 隐藏 iframe `store.steampowered.com/robots.txt`（中转层）→ 隐藏 iframe `www.howlongtobeat.com/robots.txt`（HLTB 层）。
   - HLTB 层用同站 `fetch` 调用 `/api/search/site/init` 和 `/api/search/site`，结果写入 GM 存储 `steam-hltb-iframe-<id>-result`，Steam 页轮询读取。
   - 分阶段等待：中转层 4 秒、HLTB 层 4 秒、结果 6 秒。前两层没有运行属于结构性问题（外部条件变了），不重试，直接报“读取失败”；只有“结果超时”、限流等可恢复错误才重试。
4. 地址带 `#hltb-bench` 时运行通道测速：连续做 6 次 iframe 完整查询，输出“通道测速结果”。
5. v3.0 删除了 `GM.xmlHttpRequest` 跨站请求（以及 `@connect`、相关 `@grant`）：它在 Safari 下失败率太高，没有保留价值。如果 iframe 方案失效，另找新方案，不要恢复它。

## 按钮（`HltbBadge` 类）
- 内容是单色圆角 H 图标（16px，SVG 路径照着官方图标描的：圆角方块用 `currentColor` 填充，H 挖空透出按钮底色，跟随按钮文字颜色）加一段圆环或文字；悬停提示（`title` / `aria-label`）写明完整含义。
- 各个状态：读取中（包括重试）显示圆环；成功显示“12.5 小时”；未找到同名游戏显示“未收录”；有这个游戏但没有时长显示“暂无时长”；失败显示“读取失败”，具体原因放在悬停提示里。
- 未收录 / 暂无时长属于**正常情况**（比如新上市的游戏），由 `pickGame` 抛出 `noData` 错误，不显示 debug 按钮，也不记为失败。
- “复制 debug”按钮只在失败或测速时显示；把 `DEBUG` 设为 true 时会一直显示。
- 按钮内容容器必须是块级 `flex`，高度设为 `1lh`（等于 Steam `.btn_medium > span` 的 30px 行高）。不要用 `inline-flex` 加 `vertical-align`，那样会让基线对不齐，把按钮撑高 1～2 像素。
- 按钮本身（`#steam-hltb-safari-badge`）要设 `vertical-align: top`：flex 里第一个子元素是 SVG，没有文字基线，默认的基线对齐会让它比“社区中心”高出一截。
- 样式通过带 `steam-hltb-` 前缀的 `<style>` 注入一次；系统开启“减少动态效果”时圆环转速放慢。

## 启动规则（`start()`）
- 没有 `@noframes`，脚本会在 iframe 里运行。用 `isInFrame()`（优先使用 `location.ancestorOrigins`）判断当前是顶层页面还是 iframe。
- `robots.txt` 只在 iframe 里、并且 hash 带有合法任务参数时才会运行；Steam 游戏页只在顶层运行。
- 不要在 HLTB 的顶层页面运行任何逻辑，`@match` 只包含 HLTB 的 `robots.txt`。

## iframe 方案依赖的外部条件（失效时按钮会显示“读取失败”，日志里写明卡在哪一层）
- Steam 商店页 CSP 的 `frame-src` 允许 `'self'`；Steam 的 `robots.txt` 没有 CSP。
- HLTB 的 `robots.txt` 没有 `X-Frame-Options`（首页等其他页面都带 `DENY`）。
- HLTB 接受 `Referer: https://www.howlongtobeat.com/robots.txt`（只要是 HLTB 域名下的路径都可以）。
- 用 curl 检查：`curl -sD - -o /dev/null https://www.howlongtobeat.com/robots.txt | grep -i frame`

## 排查结论（2026-09-26 ～ 2026-09-27）
- 用 curl 或 Swift URLSession 直接请求 HLTB 接口：p50 约 0.23 秒，92 个请求没有一次卡住。所以服务端和网络都没问题。
- Tampermonkey Safari 的原生请求通道（Swift 实现）会**一阵一阵地**丢失请求或完成通知：可能完全没有回调，也可能停在 readyState=1 或 readyState=3。坏的时期短则约 10 秒，长则超过 38 秒；通道好的时候也会比直接请求多出 1～1.5 秒。GET 和 POST 都会失败。
- 已经排除的原因：回调注册方式（v1.8.1）、`abort()`（v1.8.2）。`fetch: true` 用不了：扩展后台的 `fetch()` 带不上 Referer，HLTB 返回 403。
- 在 Tampermonkey 里，readyState=3 时拿不到 `responseText`。
- 以上是 v1.x～v2.x 使用 `GM.xmlHttpRequest` 时的结论，v3.0 已经不再使用它。
- HLTB 不允许跨域（OPTIONS 预检返回 403），并且检查 Referer：没有 Referer 返回 403（init）或 404（search）。
- HLTB 在 2026 年 9 月把 `/api/bleed` 改名为 `/api/search/site`；init 除了 `token`，还返回 `hpKey`、`hpVal`（目前没用到，不带它们搜索也能正常返回）。
- iframe 方案实测（v1.9.0）：连续 5 次全部成功，中位 1.1 秒；HLTB 层里的两次同站请求各约 0.24 秒。
- HLTB 有限流：大约 20 秒内 40 多轮请求就会返回 429，约 1 分钟后恢复。压测时注意。

## 维护注意
- 调试日志通过页面上的"复制 debug"按钮导出；不要把令牌或接口响应正文写进日志。iframe 各层的日志会以 `[中转层]`、`[HLTB 层]` 开头并入 Steam 页的日志。
- iframe 相关代码保留为按区块组织的函数，而不是一个类：这些函数分别运行在三个不同的页面里（Steam 页、中转层、HLTB 层），放进同一个类反而容易混淆它们各自在哪里运行。
