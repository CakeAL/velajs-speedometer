# Speedometer GPX

速度计的 AstroBox 配套插件，版本 **1.0.0**，使用 **API Level 4 / WASI p3**，需要 AstroBox **2.2.0 或更新版本**。

## 使用

1. 导入 `dist/Speedometer GPX.abp` 并启用插件，允许所需权限。
2. 连接手表，打开手表上的速度计，选择设备并点击「同步手表列表」。
3. 单条轨迹点击「下载并导出」；批量先「下载全部轨迹」，再「全部导出为 ZIP」，保存到手机并解压。
4. 手表和本地轨迹均支持单条／全部删除，删除前会确认。本地缓存按设备独立管理，未完成的下载也可以删除。

只同步已结束保存的轨迹，下载支持断点续传和文件校验。本地导出与删除可离线使用。删除手表文件会保留本地副本；删除插件缓存不会删除已经导出的文件。

## 开发

```sh
rustup target add wasm32-wasip2
python3 scripts/build_dist.py --release --package
cargo clippy -- -D warnings
# macOS ARM64；其他系统替换为本机 Rust target
cargo test --target aarch64-apple-darwin
```

使用 Rust SDK `astrobox-ng-wit = 0.4.0`，图标为 512×512 透明 PNG。权限：`device`、`interconnect`、`register_interconnect_recv`、`ui`、`dialog`、`timer`。手机保存和蓝牙通信仍需真机验证。

项目介绍、手表构建和上架说明见 [项目 README](../README.md)，通信格式见 [GPX 同步协议](../docs/astrobox-gpx-protocol.md)。
