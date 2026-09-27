# Steam 游戏通关时长（Safari）

一个 Tampermonkey 用户脚本：在 Steam 商店的游戏页上，在“社区中心”按钮旁边显示这款游戏在 [HowLongToBeat](https://howlongtobeat.com) 上的综合通关时长。

- 按钮显示 HowLongToBeat 的 H 图标加时长（比如“12.5 小时”），点击会打开该游戏在 HLTB 上的详情页。
- 读取时显示转圈；HLTB 还没收录的游戏显示“未收录”，收录了但没有时长数据的显示“暂无时长”。
- 查询结果会在本地缓存 7 天，同一个游戏不会重复查询。
- 不会打开额外的标签页，也不需要跨站请求权限。

## 安装

1. 在 Safari 中安装 [Tampermonkey](https://apps.apple.com/app/id6738342400)，并允许它访问 `store.steampowered.com` 和 `www.howlongtobeat.com`。
2. 打开 [steam-hltb-safari.user.js](https://raw.githubusercontent.com/Phishion/steam-hltb-safari/main/steam-hltb-safari.user.js)，Tampermonkey 会弹出安装页面，点击安装即可。
3. 打开任意 Steam 游戏页（`https://store.steampowered.com/app/...`），“社区中心”按钮左边会出现 HLTB 按钮。

## 工作原理

在 Safari 上，Tampermonkey 的 `GM.xmlHttpRequest` 跨站请求很不稳定，经常丢失请求或丢失完成通知；而 HLTB 的接口不允许跨域访问，还会检查 Referer。所以这个脚本改用两层隐藏的 iframe，让查询在 HLTB 自己的页面里进行：

```
Steam 游戏页
 └─ 隐藏 iframe：store.steampowered.com/robots.txt   （Steam 自家页面，符合 Steam 的 CSP 限制，本身没有 CSP）
     └─ 隐藏 iframe：www.howlongtobeat.com/robots.txt   （HLTB 唯一没有禁止被嵌入的页面）
          → 脚本在这一层以 HLTB 同站身份调用搜索接口
          → 结果通过 Tampermonkey 的存储交回 Steam 页
```

这个方案依赖一个前提：两个网站的 `robots.txt` 响应头保持现状。如果以后失效，按钮会显示“读取失败”，点击“复制 debug”可以拿到诊断日志。

## 调试

- 在游戏页地址后面加上 `#hltb-refresh` 再刷新页面：跳过缓存，重新查询。
- 加上 `#hltb-bench` 再刷新页面：连续查询 6 次，统计成功率和耗时。完成后点击“复制 debug”导出日志。

## 开发

```sh
node --test tests/*.test.js
```

单元测试覆盖名称匹配、缓存、重试、iframe 任务参数等纯函数。脚本在 Node 环境下只会导出这些函数，不会运行页面逻辑。
