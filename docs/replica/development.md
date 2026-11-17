# 本地开发

工程基线：DeepChat v1.1.1，提交 ca75acfdc680fa3d0a2bbde13575fa711d08a3bd。
目标基线：SemaPath 0.2.19 Windows x64。当前已完成工程隔离与第一条 Excel 业务链路，尚未完成原版全部功能复刻。

## 目录与工具链

开发源码位于桌面总目录中的 app 子目录。源码仓库保留上游历史和许可证，开发分支为 codex/semapath-replica。
运行缓存、下载、Node/pnpm 工具链、包存储、日志、测试数据与开发用户配置放在当前缓存工作区的 SemaPath开发缓存 下。源码中不包含本机凭据。

运行 scripts/replica.ps1 时会配置进程级 PATH，不修改系统 Node/pnpm。使用 Node 24.18.0 和 pnpm 10.34.5。
可用 SEMAPATH_DEV_CACHE 指定其他缓存绝对路径；其中应具有 toolchains/node-v24.18.0/node.exe 与 toolchains/pnpm-10.34.5/node_modules/pnpm/bin/pnpm.cjs。
本机初次引导将原版随包 Node 的只读副本放入缓存，再从 npm 获取固定 pnpm；后续启动使用缓存副本，不依赖改动原版文件。

## 命令

```powershell
.\scripts\replica.ps1 doctor
.\scripts\replica.ps1 install
.\scripts\replica.ps1 dev
.\scripts\replica.ps1 typecheck
.\scripts\replica.ps1 test test/main/app/productIsolation.test.ts
.\scripts\replica.ps1 build
.\scripts\replica.ps1 unpack
```

install 按锁文件安装，先跳过自动安装脚本，再单独安装 Electron 和重建应用原生依赖。项目 node_modules 仅为必要链接，实际包和虚拟存储放在外部缓存。
开发构建的 out 是工具要求的生成目录，已被 Git 忽略。unpack 的成品输出放外部缓存 build 下；暂不配置公开发布和自动更新源。

桌面 E2E 默认使用独立配置与隐藏、不可聚焦的 Electron 窗口，不显示应用或占用用户桌面；Playwright 截图直接保存到外部缓存。仅测试进程同时具有 `DEEPCHAT_E2E_USER_DATA_DIR` 和 `SEMAPATH_E2E_BACKGROUND=1` 时启用，普通开发启动行为保持原样。已有旧打包产物无法保证支持此模式，默认拒绝运行该类可见打包验收。

## 应用隔离

产品名 SemaPath Replica Dev，包名 semapath-replica，appId com.semapath.replica.dev。
用户配置默认命名空间为 SemaPathReplicaDev；开发脚本将实际配置与 Chromium 缓存放入缓存 profiles/development 下。
Skills、会话 offload 和安装临时资料使用 SEMAPATH_REPLICA_HOME，默认独立目录 .semapath-replica。CLI 启动器保存在本应用配置目录的 bin 中。
开发运行默认不注册系统协议；打包版只注册 semapath-replica。显式旧版 deepchat 输入链接仍保留解析兼容，不接管该系统关联。
自动更新检查、下载和安装保持关闭，避免上游发行包覆盖开发版。启用前必须建立自己的发布源并补齐签名、版本迁移与回归。

## Power BI 连接器工具链

Windows 主进程增量构建和完整 build 会先编译 `native/powerbi/PowerBiBridge.csproj`。使用外置 .NET SDK 10.0.403；本机缓存为 `toolchains/dotnet-10.0.403`，其他路径可用 `SEMAPATH_DOTNET_ROOT` 指定。NuGet 包、obj/bin 和 .NET CLI 配置都在开发缓存，只有自包含发布输出在被忽略的 `out/powerbi-bridge`；打包复制到独立资源目录。已构建应用运行不要求用户安装 SDK。

本机 SDK 从微软 `https://builds.dotnet.microsoft.com/dotnet/Sdk/10.0.403/dotnet-sdk-10.0.403-win-x64.zip` 下载，按微软发布元数据验证 SHA-512：`7a114c318fa7f1d9822991b534b2814d0e78386ceda816b371f5141acefe741d87ccb606ede06cadac8f9ac5070e32b708a67bbd1619ff5e5a7858a27874ef48`。没有修改系统 SDK。使用 pnpm 的 `build:powerbi` 可单独构建；原生依赖锁在 `native/powerbi/packages.lock.json`，构建启用 RestoreLockedMode。

SDK 缺失会明确失败，不复制原版 connector 作为实现。开发执行 `dev` 前应先完成一次 `build-main`；`start` 使用既有产物。连接器的实际运行及协议测试与真实 PBIX/云端账号验收分开，见 powerbi.md。

## 接下来

当前已通过桌面构建与独立配置启动，已实现 Excel 文件、计算、依据、自然语言计划/复核和发布链路。接下来按范围账本继续对照原版功能，并补齐正式原生构建环境与真实模型语义验收。
正式验收按缓存中的 147 项实施底表逐项展开；测试通过只说明对应工程行为，不代表已经完成全部功能。
## 本机原生依赖现状

当前发现 Visual Studio 2022 C++ 工具，但未发现可用于 node-gyp 的 Windows SDK，完整原生源码重编译尚未通过。
已验证的开发启动方式是使用基线安装包中相同版本的 SQLite 12.9.0 预编译模块，SHA-256 固定校验；其余 N-API 组件使用包内预编译模块。
该模式显式执行：

```powershell
.\scripts\replica.ps1 install -UseBaselineNativeModules
```

默认基线资源位于桌面 SemaPath/应用/SemaPath-0.2.19/resources，可用 -BaselineResources 指定其它已核验位置。来源与 hash 记录写到外部缓存 native-bootstrap.json，不更改原版文件。
待补齐 Windows SDK 后，使用普通 install 验证原生源码重编译；正式发行仍须干净环境回归。
外置 pnpm 虚拟存储时开发脚本会设置进程级 NODE_PATH 以解析工程顶层依赖。

## 平台测试记录

Windows 上全量 CLI 测试中有 13 项 POSIX 模拟失败；已用固定上游未修改实现对照，得到相同的 13 项失败、4 项通过、3 项跳过，确认并非本轮新增。报告位于外部缓存 logs/upstream-cli-baseline.json。
Windows CLI 测试以及新增的独立目录/不覆盖其它命令用例单独验证；POSIX 真实文件权限用例后续在相应平台验证，不以跳过方式冒称全部测试通过。

## Excel 开发版入口

总目录的启动开发版.cmd 调用 scripts/replica.ps1 start，通过 electron-vite preview --skipBuild 打开现有构建；缺少构建时会提示先执行 build，不在每次启动时重新编译。可用 scripts/replica.ps1 sample 生成独立合成样例（已有同名文件不会被覆盖）。

只修改主进程时可用 build-main，只修改界面时可用 build-ui；最终交付仍需要类型、格式、i18n、静态与相关行为检查。

默认进入分析任务。开发者工具可以通过菜单或快捷键手动打开；设置 SEMAPATH_DEVTOOLS=1 可恢复开发环境自动打开行为。


自然语言分析的模型配置、执行和数据发送范围见 [natural-analysis.md](natural-analysis.md)。正常开发版使用已有模型服务；test/e2e/specs/03-natural-analysis.smoke.spec.ts 的合成 HTTP 服务只在测试进程中启用，不属于开发版运行服务。
