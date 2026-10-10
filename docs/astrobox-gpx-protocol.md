# AstroBox GPX 同步协议 v1

手表端已在 `app.ux` 注册 `system.interconnect` 消息处理器。`speedometer-astrobox-plugin/` 中的 Rust API Level 4 插件使用此协议列出、下载、删除已完成 GPX，安装包在其 `dist/` 目录。

## 连接与生命周期

- 快应用包名：`com.cakeal.speedometer`。
- 协议名：`speedometer.gpx`，版本：`1`。
- 手表接收 `connect.onmessage` 的 JSON 字符串，兼容原始对象及 `{data: ...}` 事件包装；回复使用官方的 `connect.send({data: responseObject})`。
- 插件先订阅该设备、该包名的消息，再发送请求。本插件使用 AstroBox API Level 4 的 `register-interconnect-recv(deviceAddr, pkgName)` 订阅，`send-qaic-message(deviceAddr, pkgName, JSON字符串)` 发送，接收事件为 `interconnect-message`；这些接口使用原生异步调用。插件需要分别声明 `register_interconnect_recv` 订阅权限和 `interconnect` 发送权限，获取设备还需 `device` 权限。设备地址和消息事件载荷应按插件所用 SDK/WIT 解包，再解析为下述业务 JSON。插件优先解包 `payloadText` / `payload_text`，兼容字符串、对象以及序列化字节数组的事件载荷；保持设备、包名、请求 ID 和操作名检查。回复超时从发送成功后开始计时，不包含宿主授权等待。
- AstroBox v1 的对应接口为 `interconnect.sendQAICMessage(pkgName, data)`，接收监听器名为 `onQAICMessage_com.cakeal.speedometer`；v1 已被官方标为过时。
- 同步前打开手表速度计。监听器跟随应用生命周期，切页不销毁；应用被系统停止或销毁后不能应答，需要重新打开后重试。后台录制由 `system.geolocation` 保持，不能仅凭 Interconnect 注册保证未录制时也常驻后台。
- 不改快应用包名和签名。小米官方安卓配套应用路线要求包名及签名一致；AstroBox 提供其自身 QAIC 通信接口，实际连接、机型兼容及事件包装须通过 AstroBox 插件真机联调确认。当前未声称完成端到端蓝牙验证。

官方参考：[Vela Interconnect](https://iot.mi.com/vela/quickapp/zh/features/network/interconnect.html)、[AstroBox v2 发送接口](https://plugindoc.astrobox.online/host-api/interconnect/)、[AstroBox v2 接收注册](https://plugindoc.astrobox.online/host-api/register/)、[AstroBox v1 接口](https://abox.run/docs/plugin-v1/js-api/interconnect)、[Vela 后台运行](https://iot.mi.com/vela/quickapp/zh/guide/framework/other/background-running.html)。

## 公共消息格式

请求：

```json
{"protocol":"speedometer.gpx","version":1,"id":"req-001","op":"hello"}
```

`id` 为 1～64 个字符的字符串，用来匹配回复。每次请求一个回复，不主动推送完整文件。发送下一条请求前等待上一条完成；请求文本最多 4096 个字符。没有有效协议名、请求 ID、操作名的消息会被忽略。

成功回复：

```json
{
  "protocol":"speedometer.gpx",
  "version":1,
  "id":"req-001",
  "op":"hello",
  "ok":true,
  "result":{
    "package":"com.cakeal.speedometer",
    "operations":["hello","list","read","delete"],
    "chunkBytes":768,
    "pageSize":4
  }
}
```

失败回复保持相同信封，使用 `ok:false` 和 `error:{code,message}`，没有 `result`。客户端按 `code` 处理，不解析中文提示。

## 列表 `list`

```json
{"protocol":"speedometer.gpx","version":1,"id":"list-1","op":"list","offset":0,"limit":4}
```

`offset` 默认 0，`limit` 默认 4，允许 1～4。只返回已完成的 `.gpx`，不包含 `.part`、修复中间文件或正在保存的轨迹。排序按修改时间倒序，同时间按文件名排序。

```json
{
  "protocol":"speedometer.gpx","version":1,"id":"list-1","op":"list","ok":true,
  "result":{
    "files":[{
      "name":"track-2026-10-09T19-33-50-183+0800.gpx",
      "bytes":259,
      "modifiedAt":1791545630000,
      "displayTime":"2026-10-09 19:33:50",
      "etag":"259:1791545630000"
    }],
    "total":1,
    "nextOffset":null
  }
}
```

- `name` 是文件标识，后续请求必须原样回传，不使用展示时间作为文件名。
- `bytes` 为真实字节数；`modifiedAt` 为 Unix 毫秒时间戳。
- `displayTime` 按手表当前时区显示。新文件名含当地时间与时区后缀；旧的无时区后缀文件名按 UTC 识别，兼容读取、不自动重命名。GPX 内部 `<time>` 始终为 UTC。
- `etag` 是“字节数:修改时间”，用于变化检测，不是内容哈希。
- `nextOffset` 非空时继续请求下一页，为空时结束。分页期间若录制结束或文件被删除，列表可能变化；插件应按 `name` 去重，遇到范围错误或完成同步后重新刷新列表，不把分页当成固定快照。

## 分块下载 `read`

```json
{
  "protocol":"speedometer.gpx","version":1,"id":"read-1","op":"read",
  "name":"track-2026-10-09T19-33-50-183+0800.gpx",
  "etag":"259:1791545630000",
  "offset":0,"length":768
}
```

`etag` 必须使用最近列表中的值。`offset` 是字节偏移，默认 0，可到文件末尾；`length` 默认 768，允许 1～768。每次只读一块，不把长轨迹全部载入手表内存。

成功 `result` 的字段：

| 字段 | 含义 |
| --- | --- |
| `name`, `etag` | 当前文件标识及版本 |
| `offset` | 本块起始字节偏移 |
| `bytes` | 本块实际字节数 |
| `nextOffset` | 下一块应请求的偏移 |
| `total` | 文件总字节数 |
| `eof` | 是否已到文件末尾 |
| `encoding` | 固定 `base64` |
| `data` | 文件原始字节的 Base64 编码 |
| `crc32` | 本块原始字节的标准 CRC-32/ISO-HDLC，8 位小写十六进制 |

插件下载步骤：

1. 从列表取得 `name`、`etag`、`bytes`，创建本地临时文件。
2. 从偏移 0 请求，Base64 解码为原始字节，校验字节数与 CRC32。
3. 按 `offset` 写入本地文件，使用返回的 `nextOffset` 请求下一块；不将 Base64 文本当作 GPX 保存。
4. 收到 `eof:true` 后确认本地总字节数等于 `total`，再将本地临时文件变为 `.gpx`。手机保存/分享由后续 AstroBox 插件调用其文件能力完成。
5. 中断时保存已确认的偏移和 `etag`；重新连接后从该偏移继续。超时、校验失败可以原样重试同一块，不能重复追加已写入的字节。
6. `FILE_CHANGED` 时刷新列表并重新下载，不能拼接不同版本的数据。`NOT_FOUND` 时停止该文件下载。

CRC32 使用反射多项式 `0xedb88320`、初值和最终异或均为 `0xffffffff`；标准测试串 `123456789` 得到 `cbf43926`。空块 CRC32 为 `00000000`。CRC 用于传输完整性检查，不用于身份认证。

## 删除 `delete`

插件在用户选择删除后发送：

```json
{
  "protocol":"speedometer.gpx","version":1,"id":"delete-1","op":"delete",
  "name":"track-2026-10-09T19-33-50-183+0800.gpx",
  "etag":"259:1791545630000"
}
```

成功返回 `result:{name,deleted:true}`。同一文件已经不存在时返回 `deleted:false`，仍为成功，便于丢失回复后的重复请求。文件存在但 `etag` 不匹配时拒绝删除并返回 `FILE_CHANGED`。

只接受本应用目录内的 `track-*.gpx` 文件名，不接受完整路径、上级目录、子目录或未完成记录。手表轨迹页在收到远程删除通知时同步移除该项。下载完成不会自动删除手表原文件；插件需要发送独立删除请求。

## 错误与重试

| code | 插件处理 |
| --- | --- |
| `UNSUPPORTED_VERSION` | 协议版本不兼容，停止操作 |
| `UNKNOWN_OPERATION` | 操作名错误 |
| `BAD_REQUEST` | 文件名、分页或读取范围无效，修正请求 |
| `NOT_FOUND` | 下载目标不存在，刷新列表 |
| `FILE_CHANGED` | 文件版本或读取长度变化，刷新列表并重新下载 |
| `RECORDING_ACTIVE` | 轨迹仍在记录/保存，结束后再同步 |
| `FILE_ERROR` | 本地文件 API 失败，可提示用户后重试 |

建议每条请求等待 15 秒，超时后最多重试 3 次；失败后提示重新连接并打开手表应用。一次仅发一条请求。手表端最多保留 4 个待处理请求，超过时丢弃；断开会丢弃尚未执行的队列，已经执行的删除不能因断开回滚。因此删除和按偏移读取设计为可重复请求。

手表端不发送主动广播、不自动删除文件、不启动 GPS 或重置统计来同步。协议测试覆盖长文件逐字节重组、CRC、断点重试、双斜杠路径、文件变化检测、删除重复请求、活动记录保护和连接销毁。实际设备与 AstroBox 插件的收发链路仍需联调。
