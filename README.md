# 速度计

Xiaomi Vela JS GPS 速度计。
- 测速页：大号实时速度，左右两栏历史平均与历史最高，海拔、记录时长与轨迹点数；点击单位切换 km/h、m/s、mph。
- 定位页：大字号经纬度与方向，下方并列展示海拔、水平定位精度。
- 轨迹页：浏览已完成的 GPX，选择文件查看轨迹点数、时长及海拔范围，单独确认删除。

原 `pages/detail` 示例页已删除。应用内三个页面共享同一个 GPS 会话，切页不会重新创建定位订阅。

## 记录与统计

点击「记录」创建轨迹，按钮变为「结束」。每秒将最新有效经纬度、UTC 时间和设备返回的海拔追加到文件；缺失坐标或 GPS 数据超过 5 秒未更新时跳过该秒，不补造坐标。设备未返回海拔的点省略 `<ele>`，不会将缺失海拔写成零。点击「结束」关闭 GPX XML 并保存。

文件位于手表应用私有目录 `internal://files/speedometer/`。新文件名使用手表当地时间并附带时区偏移，例如 `track-2026-10-09T19-33-50-183+0800.gpx`。轨迹列表和详情中的开始时间按手表当前时区显示；没有时区后缀的旧文件名仍按 UTC 识别并转换显示，旧文件不自动重命名。GPX 内部时间保留标准 UTC。写入中使用 `.part`，完成后变为 `.gpx`。异常退出时，下次进入轨迹页会用分块读取尝试恢复完整轨迹点，丢弃写了一半的末尾。长轨迹的记录、浏览和恢复采用分块方式，避免把整个轨迹放进内存。

记录在应用内切换页面、熄屏和切入后台时继续。`manifest.json` 声明 `config.background.features: ["system.geolocation"]`，定位与采样时钟在 `app.ux` 创建；记录期间不会在 `onHide` 中取消订阅或结束文件。点击「结束」才完成 GPX；未记录时离开前台会释放定位。应用真正被销毁时尝试保存，若系统强制终止则下次恢复 `.part`。后台是否持续执行仍需对应机型真机验证，依据[官方后台运行机制](https://iot.mi.com/vela/quickapp/zh/guide/framework/other/background-running.html)。

每次显示应用页面，短暂保持亮屏 10 秒，随后调用 `setKeepScreenOn(false)` 释放常亮；定位更新、自动重试和 GPX 采样不会再次维持亮屏。实际熄屏时间按设备的系统设置执行，Vela 公开亮度接口没有强制熄屏或设置熄屏时长的方法。

历史平均以每秒的有效速度样本计算，包含静止的零速度，排除定位中断的时间；最高值取有效 GPS 速度的峰值。统计在本地持久化，跨次打开应用累积，与 GPX 文件删除相互独立。应用卸载会清除私有文件和统计。


## 手机导出

手表端已接入官方 `system.interconnect`，为后续 AstroBox 插件提供 GPX 分页列表、带 CRC32 校验的分块下载、断点重试及删除接口；通信处理在 `app.ux` 创建，切页不会丢失监听。正在记录或保存的文件不能远程下载、删除。插件按包名 `com.cakeal.speedometer` 通信，协议为 `speedometer.gpx` v1。

完整请求、回复、错误码及 AstroBox 接口对照见 [AstroBox GPX 同步协议](docs/astrobox-gpx-protocol.md)。当前尚未制作可安装的 AstroBox 插件，手机保存/分享与真实蓝牙链路在插件阶段联调；同步前应打开手表应用。没有服务器或手机端上传按钮。

## 开发与验证

```sh
npm install
npm test
npm run build
npm run start
```

调试包：`dist/com.cakeal.speedometer.debug.1.0.0.rpk`。发布使用 `npm run release`，需要配置自己的签名。

单元测试覆盖取速、自动重试、跨页会话、持久化统计、每秒 GPX 采样、海拔缺失、异常恢复及文件读取。请在真机补充验证：三个页面跳转、10 秒后解除常亮、熄屏/后台持续记录、断 GPS 后恢复、结束保存、文件浏览/删除、退出后再打开。模拟器的 GPS 结果不能替代真机验证。

仅适配带 GPS 且向 Vela JS 应用开放 `system.geolocation` 的设备；设备支持以[官方明细](https://iot.mi.com/vela/quickapp/zh/features/system/geolocation.html)为准。圆屏、方屏、窄屏按形状与比例选择布局，不覆盖无 GPS 设备或其他操作系统。

## 图标

`src/common/logo.png` 是 192 × 192 的透明 PNG，符合[官方图标建议](https://iot.mi.com/vela/quickapp/zh/guide/framework/manifest.html)。由内置 imagegen 生成后缩小到交付尺寸；生成要求为：深蓝圆形底、薄荷绿速度表弧线与指针、白色刻度，无文字、无外部阴影，圆形外部透明。
