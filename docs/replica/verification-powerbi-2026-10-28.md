# 2026-10-28 Power BI 连接与快照验证

基线为 SemaPath 0.2.19 Windows x64。当前开发身份仍为 0.1.0-dev.1。本轮实现 Power BI 本地/云端只读连接代码及其快照分析、数据依据、关联和报告路径；完整原版复刻尚未完成。

## 已执行的检查

| 检查 | 结果及边界 |
| --- | --- |
| 相关回归 | 219 项、20 个文件通过，含恢复的独立真实 MySQL 7 项；此前阶段 205 项，加本轮 14 项 |
| 新增合同 | REST 精度/完整结果、DAX 边界、state/PKCE、加密缓存、租户/账号、取消后不提交、原生协议重启与报告来源篡改 |
| 桌面回归 | 00–08 共十条同次全部通过，约 4.5 分钟；最终空快照文案修正后新增两条再次通过，约 1.4 分钟 |
| 最终专项 | Power BI/原生桥/报告三个文件 28 项通过，属于上述套件的子集，不重复累计 |
| 构建 | 自有 .NET Windows x64 自包含连接器、主进程、预加载、Worker、Vue 界面构建通过 |
| 静态检查 | Node/Vue 类型、oxlint、资源清理/弹窗 guard、99 个匹配文件格式、Windows CRLF 空白检查通过 |
| 国际化 | 20 locales、440 namespace registrations、4930 source message contracts；未宣称所有语言已人工翻译 |
| 报告 | /5 冻结报告，A4 三页与 16:9 七页；真实 Chromium 渲染，独立解析/逐页渲染，共十页 |
| UI | 1440×1000 浅色、1280×1000 深色，Windows 125%；键盘焦点、无水平溢出、错误/取消入视口、两主题错误文字对比度 ≥4.5 |

单元测试的原生加密合同使用受控接口替身；实际 Windows safeStorage/DPAPI 保存、密文内容和重启读取在真实 Electron 中验证。构建日志里的上游 VueUse pure-annotation 和大 chunk 提示保留，不是新错误。

## 真实原生子进程与合成模型合同

实际运行自行编译的 `SemaPath.PowerBiBridge.exe`，校验 NDJSON 协议标识与 .NET 10 runtime、并发请求 ID 对应、真实本地发现调用、只读命令拒绝、关闭后的重新启动。发现调用在本机没有 Desktop 模型时返回空列表；没有把空列表运行当作 TOM/ADOMD 业务取数验收。

另一条桌面测试明确使用 `test/fixtures/powerbiBridgeProtocol.cjs` 的合成 NDJSON，覆盖两个模型时不自动误选、模型绑定、表/字段/度量/关系结构、精确预览、模型失效、取消及本地结果快照。该夹具只由测试进程拦截其自己的 native 子进程启动，不进入生产路由，不存在产品的测试开关或模拟模型入口；它不是 Analysis Services 引擎，也不是 PBIX。

## 云端到报告的实际应用路径

云端微软 SDK 和固定主机 HTTP 边界由测试进程提供合成响应，浏览器回调服务器、state/PKCE 校验、DPAPI、Typed IPC、Vue、SQLite、SheetJS/Worker、发布和 PDF 渲染均实际执行：

1. 配置独立合成 Client/Tenant，走本机随机端口登录回调。密文不含合成 token、MSAL 缓存或账号文本，Renderer 只见公开账号。
2. 选择精确工作区/模型 ID；执行 DAX。HTTP 200 中的截断 error 不保存来源，实际等待中的查询可本地取消，文案明确远端可能仍在运行。
3. 返回 `9007199254740993001` 等大整数及 `0.10000000000000000000`、`0.20000000000000000000` 等原始文本，完整保存四行结果。来源记录模型/工作区、DAX 摘要、取数时间和 lossless_json 精度标识。
4. 与客户区域 Excel 以文本键左关联；原始 Power BI 来源及完整返回记录进入根来源。通过既有 ProviderRuntime 和合成 HTTP 模型规划/复核，按区域精确汇总为华东 0.3、华南 5、未匹配 2.5。
5. 点击数字能追到 Power BI 结果的 `数据!D2/D3` 及 Excel 原始客户区域单元格；模型提示不含访问令牌、缓存或完整 DAX。
6. 发布后删除测试源文件和生成快照，再导出 A4/16:9 PDF 与依据 JSON。PDF 保留 DAX、模型/工作区、指纹和依据；JSON 保留完整原始结果及关联映射。文件摘要与报告保存的摘要一致。
7. 重启独立测试配置，公开账号和模型绑定恢复，已发布分析与两份成果仍在；没有 Renderer page error。

这些结果证明相应协议与工程链路，不证明真实微软登录、租户开关、业务模型理解或 Analysis Services 服务器兼容性。

## PDF 与界面证据

除应用自检/pdf-parse，另用 pypdf/pdfplumber 核对文字边界、尺寸和外部 URI，使用 Poppler 105 dpi 渲染全部十页并检查。A4 594.96×841.92 pt，演示版 960×540 pt；页外字符与外部 URI 均为 0。保留 DAX 结果可能已聚合、浮点近似、REST 未取得模型结构的说明。

界面沿用既有蓝色、系统字体、原生控件、线性工作台及浅深主题。错误/进度/取消放在查询动作附近。两主题错误文字颜色使用现有语义颜色调和，并验证 Vue 编译后的选择器只影响 Power BI 错误，不污染全局主题。唯一一次 detector 对四个变更目标返回 `[]`。

独立审阅首轮指出 Power BI 查询流程下方仍用 Excel/CSV 的空数据提示，容易把“模型已连接”与“尚无可分析快照”混淆。已改为“尚未创建分析快照”及连接模型/DAX/保存完整结果的说明，并移除该状态的文件主按钮；文件/Excel 的原有入口保留。新增断言并重录查询失败/运行中证据后，同一审阅者将唯一 P2 评为 resolved，disposition: ship。本次 verdict pass 只评分该项修复，不扩大为全产品或真实环境联测批准。记录为缓存 `review-result.md`、`review-verdict.json`。

独立文档核对确认本轮属于既有系统普通扩展：八张最终截图摘要与清单一致，字体、颜色、布局、控件和依据规则沿用 incumbent，DESIGN.md 无需更新。保留既有 PRODUCT Platform/设计元数据格式及缺省 sidecar，不未经请求修复旧 drift。核对前后 PRODUCT.md、DESIGN.md 摘要不变，详见缓存 `documentation-review.md`。

## 待验收与用户暂缓事项

- 用户于 2026-10-28 明确暂缺 Entra Client ID、Tenant ID 和云环境，要求记录后续补充、继续其它开发。本机也未发现 Desktop 或用户 PBIX；真实 Desktop 发现/重开、TOM/ADOMD 数据、云端账号/授权/权限/容量/XMLA 仍待联测。
- Fabric getDefinition 涉及 `SemanticModel.ReadWrite.All`，自动审批以权限扩大拒绝扩展。用户随后明确先留存、暂不申请、后续提醒；当前代码不请求该范围。已创建 2026-11-04 10:00（北京时间）一次提醒，合并 Entra 与 Fabric 两项待办。
- 不自动生成执行 DAX，不写回模型；F043 度量变更门控、自由业务图与开放式 Agent、完整报告模板和正式安装发行仍在后续范围。
- 既有 Windows SDK/干净 SQLite 源码构建及十三项上游 POSIX CLI 模拟测试限制保留，不能因新 .NET 连接器编译通过而称这些问题解决。

## 文件与清理

源码、测试、锁文件、依赖许可和必要文档位于桌面开发总目录。SDK/下载/NuGet/obj/bin/认证测试配置/截图/日志/PDF 均在缓存；`out/powerbi-bridge` 是必要、被忽略且打包位置明确的工具输出。自有连接器没有复制原版二进制。

相关 MySQL 回归仅恢复前阶段的独立合成数据目录和端口 59035，不更改已有 Windows 数据库服务。结束后验证监控/服务器进程与 Unicode 盘符目标，通过其明确拥有的 Windows shutdown event 正常关闭；日志确认 Shutdown complete 后移除 Z:。未强停其它实例。

可审阅缓存根为 `C:/Users/asus/Documents/ChatGPT/数据分析工具开发/SemaPath开发缓存/`：

- `logs/powerbi-*`：构建、类型、格式、lint、国际化、219 项回归、十条桌面流程及最终两条复验。
- `powerbi-qa-2026-10-28/review/`：八个浅/深色状态截图；`detector.json` 为唯一 detector 结果。
- `powerbi-qa-2026-10-28/final/`：PDF、冻结 JSON、全部页 PNG、概览及独立解析 `inspection.json`。
- `powerbi-qa-2026-10-28/test-instance-cleanup.json`：独立数据库正常关闭和临时盘符清理。
