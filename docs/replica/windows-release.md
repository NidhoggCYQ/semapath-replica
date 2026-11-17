# Windows x64 预览版本发布

首次公开版本：0.1.0-beta.1。仓库：<https://github.com/NidhoggCYQ/semapath-replica>。源码、安装包和验收说明属于本项目，缓存、日志、独立测试配置和安装验证目录置于外部开发缓存。

## 构建

从工程根目录运行 `scripts/replica.ps1 package-win`。工具链为外置 Node 24.18.0、pnpm 10.34.5、.NET SDK 10.0.403。设置 `SEMAPATH_DEV_CACHE` 指定外置根目录；其它机器的 .NET SDK 路径可用 `SEMAPATH_DOTNET_ROOT` 指定。

发布脚本使用两个固定官方发行包：

- SQLite：better-sqlite3-multiple-ciphers 12.9.0，Electron ABI 145 / Windows x64；GitHub Release 归档 SHA-256 为 `cd4b5711b432b617bc252cef773b76029182f407f58fab800acc977bc0fb7d81`。
- Node：node-v24.18.0-win-x64.zip；官方 SHASUMS256 校验值为 `0ae68406b42d7725661da979b1403ec9926da205c6770827f33aac9d8f26e821`，node.exe 另与 runtime-versions.json 校验。

脚本替换早期开发引导的 SQLite 模块为官方预编译文件，记录来源、归档和二进制指纹，然后生成已确认的 Logo，运行完整类型检查、主进程/界面构建、自包含 Power BI 桥和 CLI 构建。electron-builder 使用 `build/replica-windows.config.cjs`，仅在校验官方模块后关闭重复原生重编译。

打包主文件采用 out/resources/package.json 白名单，生产依赖由 electron-builder 收集；源码、测试、审计、配置、凭据、原版包、日志和开发用户数据不进入应用包。保留依赖许可和资源许可。运行时从外置构建目录复制，避免把本机配置混入安装包。

构建临时输出在外置缓存 release-2026-11-18/版本/build。最终可分发安装包、校验文件和使用说明复制到桌面开发总目录的发布包/版本，不把 win-unpacked 等中间产物纳入源码。

## 安装与验证边界

NSIS 提供当前用户安装及目录选择；安装结束不强制打开应用，卸载不默认删除应用数据。安装程序、桌面/开始菜单名称为 SemaPath Replica，内部独立 appId/profile 命名空间继续保留以避免覆盖已有开发数据和原版数据。

本版本未申请商业代码签名证书。需记录实际 Authenticode 状态，不能把本机成功安装表述为 Windows SmartScreen 无信誉提示。此版本仅验证 Windows x64，不能声称已经覆盖所有 Windows 版本、企业策略和第三方安全软件环境。

发布前检查安装包内容与指纹，后台安装到受控测试目录，以无已有模型/历史配置启动，检查首次使用入口，再用已安装的同一应用验证 Excel 导入、计算、依据、发布、报告和重启恢复。验证不继承开发 NODE_PATH 或依赖本机 Node PATH。独立测试窗口必须隐藏且不可聚焦。

验收记录列出实际通过项目及未覆盖项目。用户自然语言分析仍需自己的模型配置；合成控制器只验证工具与交付链路。GitHub 发布后重新下载安装包并比较 SHA-256，确保线上资产与本地验收包一致。

## 发布与更新

公开仓库仅上传受控源码、必要资源、测试和文档；临时下载、日志、截图、模型凭据和用户数据库留在外部缓存。上游 Release 自动化限定为上游仓库，本项目首发采用独立、明确的构建与发布流程，不使用上游更新源或发布密钥。

版本标签与 package.json 一致。首发标记为 prerelease，Release 附 Windows x64 安装程序、SHA-256 校验及使用说明。自动更新保持关闭，后续版本从本仓库 Release 手动安装。
