# @dsh-external/dsh-perf-suite

统一 DSH 性能插件：把多个社区性能插件合并、精简、重构为一个包。

## 已集成模块

| 来源 | 模块 | 说明 |
|---|---|---|
| dsh-pref-kit | 流式合并 | 合并 text/reasoning delta，减少事件量；已删除 chatContainment / rowManager |
| dsh-session-slim | 会话数据裁剪 | 历史/live 剥离 sourceEventSeqs；已结算 step 裁剪 assistant/chunk；核心补丁见 `patches/0002-session-slim.patch` |
| dsh-plugin-perf | Web 资源压缩/缓存/预加载 | gzip/brotli + immutable cache + preload；不局限于慢网络，本地也减少传输与重复加载 |
| dsh-webui-perf | WebUI 优化开关 | 设置开关 + 官方源码补丁 `patches/0001-dsh-webui-perf.patch` |
| dsh-chat-content-visibility-auto | 聊天列表 content-visibility | 客户端注入 CSS，跳过屏外消息渲染 |
| dsh-large-proj-perf | 大会话补丁（可选） | `largeSessionPerf: true` 时启用 fork/投影/materialize 优化 |
| dsh-compressor | 上下文压缩（可选） | `contextCompression: true` 时启用；含 Rust native 压缩器与 `compressor_retrieve` 恢复工具 |
| Context Pool（新） | 按需展开 | 长 tool_result 自动池化为树；`context_pool_explore` / `context_pool_fetch` 按需取回，历史不变、前缀缓存保持命中 |

## 安装

```bash
# 构建
cd dsh-perf-suite
bash scripts/build.sh

# 装配到 web profile
dsh plugin --profile web add file:$(pwd)
# 或注入器
# dev_install_package {"dir": "/home/firsry/myself/THREADRIPPER/dsh-perf-suite"}
```

重启 DSH 后生效。

## 配置

通过 `cordis.patch.yml` 或 profile patch 覆盖：

```yaml
- insert:
    - id: dsh-perf-suite
      name: "@dsh-external/dsh-perf-suite"
      config:
        windowMs: 30
        webCompression: gzip+br
        immutableCache: true
        preloadClientBundles: immediate
        webuiPerfEnabled: true
        contentVisibility: true
        contextCompression: false
        largeSessionPerf: false
```

## 核心补丁

一键应用：

```bash
bash scripts/apply-core-patches.sh /path/to/deepseek-harness
```

- `patches/0001-dsh-webui-perf.patch`：WebUI 渲染/高亮/缓存优化（需重新构建 client）。
- `patches/0002-session-slim.patch`：sourceEventSeqs 区间化 + 客户端 live chunk 裁剪。

## License

BSD-3-Clause
