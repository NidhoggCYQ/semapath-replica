# SemaPath Replica

面向 Excel/CSV 的 Windows 数据分析桌面应用。将数据读取、精确计算、图表、可核对的数据依据、正式结果和报告交付组织在同一个任务中。

这是独立的学习与作品项目，基于 [DeepChat v1.1.1](https://github.com/ThinkInAIXYZ/deepchat/tree/ca75acfdc680fa3d0a2bbde13575fa711d08a3bd) 开源底座开发，以 SemaPath 的数据分析工作流作为产品参考。它不是原版 SemaPath 或 DeepChat 的官方发行版，也尚未复刻原版全部功能。

## 下载与安装

[进入 Releases 下载 Windows x64 安装包](https://github.com/NidhoggCYQ/semapath-replica/releases)。首个公开预览版本为 **v0.1.0-beta.1**。

1. 下载以 `windows-x64.exe` 结尾的安装程序。
2. 运行安装程序，选择安装位置并完成安装。
3. 从桌面或开始菜单打开 **SemaPath Replica**。安装完成后不会强制自动打开窗口。
4. 新建分析任务，添加 Excel/CSV，核对工作表与表头。可以使用手动计算入口；使用自然语言分析时，需要配置自己的模型服务和 API Key。
5. 查看计算结果、图表和数据依据，确认正式回答后导出 PDF 与依据 JSON。

安装包包含 Electron、应用依赖、固定版本 Node 工具链与自包含的 Power BI 桥接程序。基础 Excel 计算不要求另装 Node、pnpm、Python 或 .NET SDK。模型服务需要网络或用户自行提供的本地模型；云端连接和可选扩展有各自的配置要求。

预览安装包没有商业代码签名证书。Windows 可能显示“未知发布者”或信誉提示；这与应用本身的启动验证是不同的检查。请核对本仓库发布页与 SHA-256 校验文件。当前仅发布 Windows x64，未验证 ARM64、macOS 或 Linux 安装包。

## 已有功能

| 板块 | 能力与产出 |
| --- | --- |
| 任务工作台 | 任务、来源、对话、分析结果、数据依据、任务文件及报告管理 |
| Excel/CSV | 多文件、多工作表、表头和字段读取、分页预览、来源版本校验 |
| 计算与分析 | 求和、均值、计数、极值、筛选、分组、排名、占比、比较，以及九种受控分析方法 |
| 图表 | 十四种适用图型及表格，图形绑定实际结果并可查看精确数值 |
| 数据依据 | 输入单元格、公式、文件指纹；查询、关联和程序输出保留各自的来源边界 |
| 代码处理 | 声明任务输入、执行本地代码、校验完整输出并登记结果表，再接入分析与报告 |
| 正式结果 | 候选提交、完整读取复核、确认发布、版本冻结和历史恢复 |
| 报告 | A4/16:9 PDF、精确结果与引用、冻结依据 JSON；16:9 是 PDF，不是 PPTX |

自然语言分析需要用户选择支持相应调用方式的模型。模型提出计划和解释，数值由本地引擎或已记录的实际程序计算。对任意问题的理解质量不能仅凭工具协议测试推定。

## 服装门店案例

[下载虚构 Excel 示例](examples/clothing-store-sample.xlsx)，[查看无需模型的基础核对步骤](examples/README.md)。

使用虚构的 2026 年 10 月账本，包含 24 个 SKU、360 笔原始订单、513 条销售明细、72 条进货、32 条退货和 12 条费用。应用实际完成六表读取、案例代码计算、五张完整结果表登记、九次原生汇总、六组图表视图、依据查看、正式发布、PDF/JSON 导出及重启恢复。

独立实现从原始 Excel 复算，107 项数值比较通过；8 个派生比例另行核对一致。净销售额 122,759.05 元、商品毛利 67,834.05 元、经营结余 42,684.05 元；采购付款造成现金收支 -15,476.95 元，与库存成本增加额 58,161.00 元对账一致。

该案例采用固定步骤工具调度，不是真实大模型自由理解验收；跨表成本和库存口径由案例脚本经应用执行。数据全部为合成记录，不能当作真实门店上线业绩。经营结余未扣所得税、折旧等，不等同于完整会计净利润。

## 当前边界

- 真实模型业务语义效果仍需实际模型配置与多轮业务数据验证。
- Power BI 本地/PBIX 和云租户真实连接另行验收。Entra Client ID、Tenant ID、云环境待补充；可选 Fabric 定义读取的较宽权限仍暂不申请。
- 知识库、子智能体、浏览器、扩展和其它底座模块未在这个 Windows 预览版本中逐项验收。
- 程序输出保留声明输入和完整输出，不自动证明程序业务逻辑或每个原始单元格的变换血缘，也不声称捕获完整可重放环境。
- 单文件及分析方法有明确资源上限，见 [方法与图表](docs/replica/methods-and-charts.md)。
- 应用使用独立配置、协议和数据目录；上游自动更新保持关闭。新版本从本仓库 Release 手动安装，不接收原版软件更新。

## 技术与开发

Electron 41、Vue 3、TypeScript、Vite、Pinia、Tailwind/shadcn-vue、SQLite、SheetJS；本地分析使用 Worker、十进制精确计算和共用 SVG 图表编译器。Power BI 桥为自有 .NET 程序。测试使用 Vitest 与 Playwright。

```powershell
pnpm install --frozen-lockfile
pnpm run build
pnpm exec electron-builder --win --x64 --publish never
```

开发要求 Node 24.18.0、pnpm 10.34.5；完整构建 Power BI 桥需要 .NET SDK 10.0.403，可通过 `SEMAPATH_DOTNET_ROOT` 指定外置 SDK。普通依赖安装可能需要原生构建工具或适配 Electron ABI 的官方预编译依赖。

本机受控发布流程：

```powershell
.\scripts\replica.ps1 package-win
```

该命令使用外置 `SEMAPATH_DEV_CACHE` 工具链，校验固定的官方 SQLite/Electron 预编译文件和 Node 发行包后构建。详见 [Windows 发布说明](docs/replica/windows-release.md) 和 [开发目录与工具链](docs/replica/development.md)。

## 来源与许可

保留 DeepChat 的 Apache-2.0 许可证、原作者版权和上游历史，见 [LICENSE](LICENSE) 与 [独立修改声明](SEMAPATH-REPLICA-NOTICE.txt)。上游说明保存在 [DeepChat README](docs/upstream/DeepChat-README.md)。本项目窗口、安装程序和托盘沿用已确认的 Lucide route 图标，包含对应 ISC 许可文本。未将原版 SemaPath 安装包或用户数据打包进本项目。
