# Speedometer GPX · AstroBox API Level 4

用于同步 `com.cakeal.speedometer` 手表速度计应用的 GPX 轨迹。采用 Rust SDK `astrobox-ng-wit = 0.4.0`、独立的 `psys-world-v4` 接口，Manifest 声明 `api_level: 4`、`wasi_version: 3`。需要 AstroBox **2.2.0 或更新版本**。

## 安装和使用

1. 在 AstroBox 的插件页面导入 `dist/Speedometer GPX.abp`，启用插件。
2. 在 AstroBox 连接手表，手动打开手表上的速度计应用。
3. 打开插件，选择设备，点击「同步手表列表」。只显示已经结束并保存的 GPX。
4. 点击「下载并导出」下载单条轨迹，然后通过系统文件对话框保存到手机或电脑；「下载全部轨迹」先缓存所有文件，再在「本地轨迹」中逐条导出。
5. 点击「删除手表文件」并确认后才删除手表原文件。下载或取消操作不会自动删除文件，已下载的本地副本会保留。

0.1.3 改为消息回调驱动的同步状态机：发出请求后立即返回，收到回复或超时事件再处理下一步，不再通过 Rust 通道跨回调等待。0.1.2 开启的 `inter-task-wakeup` 与 AstroBox 2.2.0 的运行时存在兼容性问题，已移除；构建脚本会拒绝启用该功能的依赖图。0.1.1 修复了 0.1.0 遗漏消息订阅权限的问题。请覆盖导入新版 ABP，并允许 AstroBox 的订阅权限请求。若以前拒绝过权限，需要在 AstroBox 插件权限管理中重新允许后重试；更新或重载插件，让宿主读取新的 Manifest。

0.1.4 补齐宿主事件中 UTF-8 字节数组的解码（保留设备、包名与请求匹配检查）；发送成功后才启动回复计时，避免授权对话框耗尽超时。超时提示区分没有收到消息、编码无法解析和回复不匹配。手表新版在 GPX 列表显示通信阶段，并修复首次连接事件可能丢弃已收到请求的问题。

0.1.5 补齐 AstroBox 的 `payloadText`（以及 `payload_text`）事件字段，并优先于二进制 `payload` 解析。回归测试使用手表实际 JS 服务生成的握手、列表和分块回复包裹在该宿主事件中，检查完整解包和设备/包名过滤。此兼容性修复仍需手机与手表实测确认。

## 权限

| Manifest 权限 | 用途 |
| --- | --- |
| `device` | 获取已知和已连接设备 |
| `register_interconnect_recv` | 订阅指定手表、指定快应用包名的消息；与发送权限分开 |
| `interconnect` | 向速度计发送列表、读取和删除请求 |
| `ui` | 显示轨迹管理界面 |
| `dialog` | 确认删除，使用系统文件保存对话框 |
| `timer` | 请求超时检测 |

插件不需要网络访问权限，不上传轨迹到云端。`icon.png` 为 **512×512 透明 PNG**，沿用速度计图标。

## 下载与缓存

- 协议为 `speedometer.gpx` v1，每次最多读取 768 字节，只保留一个待应答请求。
- 请求 ID、协议版本、操作名及事件中提供的设备/包名均需匹配；事件支持 JSON 对象、字符串及 UTF-8 字节数组。每个文件块校验 Base64、CRC32、长度、偏移、etag 和结束标志。
- 超时 15 秒，最多重试 3 次；损坏块重读同一偏移。文件变化或不存在时停止并提示刷新列表。
- 每块持久化后提交断点；重新连接、重开插件后下载同一版本可续传。损坏断点、etag 变化会从头开始，不能拼接不同版本。
- 缓存写入插件的 WASI 私有目录 `gpx-cache/<设备地址的十六进制编码>/`，下载文件为 `.part`，完成后转为 `.gpx`。JSON 记录文件版本、已确认字节位置和整文件 CRC32。
- 导出前再次检查完整缓存，使用 v4 `save-file-start / write-chunk / finish` 分块保存，失败时中止保存会话。断开手表后可在本地轨迹中导出。
- 列表的展示时间来自手表 `displayTime`；文件名保持原样，包括新文件的当地时区后缀。GPX 内容逐字节保留，包含海拔和 UTC 时间。
- 手机窄屏单列、宽屏双列，跟随宿主明暗主题。

手表应用被系统销毁后不会应答，请重新打开速度计。列表分页不是固定快照，记录结束或删除其他文件后可重新同步。具体机型的蓝牙通信、手机保存目标和宿主授权流程仍需真机联调；单元测试不代表已经完成这些验证。

## 开发与构建

```sh
rustup target add wasm32-wasip2
python3 scripts/build_dist.py --release --package
```

Level 4 宿主使用 WASI p3，同时兼容 Rust 标准库的 p2 导入；编译目标仍为 `wasm32-wasip2`。入口和宿主调用使用原生 `async fn` / `.await`。宿主异步接口可以正常 `.await`，手表回复通过事件回调推进状态机；回复、超时和取消之间不使用 Rust 通道或等待任务。日志只记订阅和请求阶段、操作名、请求 ID，不输出 GPX 内容。

```sh
# 在 macOS ARM64 上运行纯协议、缓存和跨语言协议测试
cargo test --target aarch64-apple-darwin
cargo clippy -- -D warnings

# 在包含手表源码的父项目中重新生成真实 JS 协议测试报文
node scripts/watch_fixture.mjs
```

其他开发系统请把测试目标换成本机 Rust target，避免默认 WASI target 无法直接运行。构建结果在 `dist/`：Manifest、图标、WASM Component 和 ABP 安装包。

## 源码

- `src/lib.rs`：v4 生命周期和事件导出。
- `src/runtime.rs`：设备、订阅、请求、超时回调、导出、确认删除。
- `src/workflow.rs`：列表、分块下载和删除的回调状态机，支持独立于宿主的测试。
- `src/ui.rs`：轨迹管理界面。
- `src/protocol.rs`：消息解析和分块校验。
- `src/cache.rs`：私有文件缓存和断点恢复。
- `tests/fixtures/watch.json`：由手表实际 JS 服务生成的回复；测试含 UTF-8 名称、正负海拔、分块及续传。

官方参考：[v4 的变化](https://abox.run/docs/plugin-development/v4/whats-new)、[Rust 教程](https://abox.run/docs/plugin-development/v2/getstarted/rust)、[SDK](https://github.com/AstralSightStudios/AstroBox-NG-wit-crate)。Rust 教程中的旧 API 示例不适用于本插件；接口以 SDK 0.4.0 中的 v4 WIT 为准。
