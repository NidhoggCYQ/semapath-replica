# Power BI 连接与分析

## 当前任务

按 SemaPath 0.2.19 补齐 Power BI Desktop 本地模型发现、模型结构、只读 DAX，以及 Microsoft 云端认证、工作区/语义模型选择、REST/XMLA 取数，接入现有快照、分析、数据依据、发布与报告链路。开发源码和必要文档在桌面总目录，测试配置与产物外置。

## 用户待补充（2026-10-28 已确认）

用户目前没有 Entra 公共客户端应用的 Client ID、Tenant ID 和国际云/中国云配置，要求先记录，后续补充，当前继续其他开发。

- 待补：Client ID、Tenant ID、国际云或中国云，以及本人通过 Microsoft 浏览器登录完成认证。
- 不需要向聊天发送密码、访问令牌或刷新令牌；应用通过系统加密存储认证缓存。
- 在收到配置前，云端实现按协议和合成响应验证，不标为真实账号、租户开关、Read/Build 权限、容量/XMLA 或实际业务模型验收通过。
- 本地连接、认证/取数代码、界面、异常状态和现有分析/报告接入继续开发，不等待上述信息。

## 已接入的路径

本地：发现 Desktop 的 `msmdsrv` 子进程与监听端口，列出数据库，支持多模型选择和已知本地端口。连接身份包括进程、启动时间、端口和数据库 ID；读取前后校验身份，查询前后核对结构指纹。模型重开或结构改变后失败并要求重新连接。TOM 读取表、字段、度量表达式及单列关系；未覆盖的关系类型显示 partial，不标为完整。

云端：用户自己的 Entra 公共客户端应用 → 系统浏览器 → 本机随机端口回调 → state/PKCE → MSAL 令牌缓存 → 工作区/语义模型精确 ID → REST ExecuteQueries 或显式 XMLA。支持国际云和中国云的独立 authority/resource/API 端点。默认申请委托 `Workspace.Read.All` 与 `Dataset.Read.All`；不使用 API Key、Client Secret 或原版应用标识。

令牌仅在主进程及自有 native 子进程之间使用。应用配置、活动账号和 MSAL 缓存经 Electron safeStorage 加密；无明文回退。Renderer 只取得公开账号信息和不可逆账号标识。退出登录清空本地活动缓存，不宣称撤销微软已有会话或应用同意。

查询结果：完整返回值 → 字符串精度的 XLSX 快照（工作表“数据”、首列“结果行号”）→ 现有自然语言/手动/九种方法/十四图型/问题框架/下钻 → 原始数字依据 → 正式发布 → 冻结 PDF/JSON。可与任务中的 Excel、CSV、MySQL 或其他快照显式关联；Power BI 根来源、完整 DAX 返回值和原始单元格引用继续保留。

## 操作

1. 新建任务 → 连接数据/管理连接 → Power BI 本地。先在 Desktop 打开 PBIX，点击“发现本地模型”，选择后连接。也可展开已知本地端口入口；只连接本机 Analysis Services 进程。
2. 点击“读取模型结构”，展开表查看字段/度量表达式和关系；可选表预览。预览用于理解结构，不登记分析依据。
3. 填写快照名称及一条只读 DAX，例如 `EVALUATE 'Orders'`；实际表名必须来自自己的模型。执行并保存快照，成功后进入任务文件。
4. 云端先在“云端应用配置”填写 Client ID、Tenant ID 和云环境，保存并通过 Microsoft 登录。应用注册使用移动和桌面应用重定向 `http://localhost`，按租户规则完成委托权限/管理员同意。
5. 加载工作区、选择工作区（也支持“我的工作区”）、加载模型并连接；模型列表显示精确 ID，避免同名混用。云端默认使用 REST，XMLA 作为显式查询通道。
6. 取得快照后，在分析工作中直接提问；如需跨表，先创建显式关联快照。点击数字和图形核对依据，发布后导出 A4/16:9 PDF 与完整依据 JSON。

自然语言分析现可在“自动读取连接数据”中允许当前任务已绑定的模型，由所选聊天模型依据可读取的真实结构生成只读 DAX，保存完整结果快照再分析。登录和具体模型绑定仍由用户完成；结构不可读时应澄清，不猜测表名。操作与限制见 [自然语言取数](natural-data.md)。DAX 可能已聚合，结果行不等于模型底层交易明细。“结果行号”定位这次查询返回记录，不是业务主键。重新查询生成新快照，不改写旧分析。

## 数据、权限和生命周期边界

- 一条 EVALUATE 查询，可带查询局部 DEFINE；拒绝修改命令、注释、多结果语句。每次最多 5000 行、40 个业务列、4 MB 结果数据；native/HTTP 帧另有大小上限。超限或接口报告不完整时失败，不保存截断结果。
- 本地/ XMLA 通过 .NET 以不经过 JS Number 的文本接收 Int64/Decimal。REST 使用 JSON 原始数字文本，保留大整数与小数尾零。浮点结果保留模型的近似语义，不将其包装为任意精度原数。
- 普通操作等待上限 120 秒，native 命令 90 秒；浏览器登录上限 5 分钟。每任务单操作、全局最多四项；Renderer 销毁会取消自己的等待。进入保存阶段后不接受取消，防止将已保存结果误报为取消。
- 账号/应用配置切换使旧云端操作失效，旧结果不得写入新账号上下文。模型绑定记录独立 ID，查询结果必须仍对应原绑定。云端取消只停止本地等待，不声称终止服务器计算。
- ExecuteQueries 需要模型读取/生成权限和租户查询开关。HTTP 200 中的 error、过量/多表结果也必须失败。REST 本身不提供完整 TOM 结构；结构不可读时显示原因，仍允许用已知 DAX 通过 REST 取数。
- XMLA 需要实际容量、端点和模型权限。我的工作区及同名工作区存在定位歧义时，完整 XMLA 结构读取失败，不猜测连接到另一模型。表、字段、度量和关系覆盖独立显示。
- 本轮不写回或修改 Power BI 模型。可选 Fabric getDefinition 需要更宽的 `SemanticModel.ReadWrite.All`，自动审批因权限扩大拒绝这项扩展；当前未接入，也未在登录中请求该权限。用户已于 2026-10-28 明确要求先留存、继续其它开发、后续提醒；不再就本轮重复征求权限。

## 构建与来源

自有连接器源码在 `native/powerbi`，目标 Windows x64、.NET 10，Microsoft.AnalysisServices / AdomdClient 19.117.0；NuGet 锁文件和 RestoreLockedMode 固定依赖。构建使用外置 .NET SDK 10.0.403，发布自包含 runtime 10.0.14，开发机以外运行已构建连接器不需要 SDK。依赖许可说明和微软原始 EULA 在 `native/powerbi/licenses`，随输出复制；没有复制原版 SemaPath native 二进制。

主进程与预加载共用 `analysisPowerBi.routes.ts` 的 Zod 契约。NDJSON 请求有唯一 ID、帧上限、取消、超时及子进程重启；令牌不会作为命令行参数传递。打包把连接器放在独立 `resources/powerbi-bridge`，源目录、测试及重复 asar 副本排除。

```text
BEFORE  任务 → Power BI 本地/云端 → 待开发提示
AFTER   任务 → 发现/登录 → 选择模型 → 结构/预览 → 只读 DAX → 完整结果快照
                                                        → 分析/数字依据/发布/冻结报告
```

## 验证与待办

验证见 [Power BI 验证记录](verification-powerbi-2026-10-28.md)。原生桥的实际运行不等于已经通过真实 PBIX 取数；合成微软 SDK/HTTP 和 native NDJSON 验证不等于真实微软账号或 Analysis Services 引擎验收。

本机尚未发现已安装/正在运行的 Power BI Desktop，也没有用户提供的 PBIX；真实本地模型发现、TOM/ADOMD 读取及重开行为待后续联测。云端真实 Client ID/Tenant ID、租户开关、同意/权限、容量/XMLA 和业务模型效果仍待上述用户配置。完整原版自由业务图、开放式 Agent 工具协议、模型度量变更门控、报告模板和正式安装发行继续在总进度中单列。

实现依据：[ExecuteQueries](https://learn.microsoft.com/en-us/rest/api/power-bi/datasets/execute-queries-in-group)、[客户端库](https://learn.microsoft.com/en-us/analysis-services/client-libraries?view=sql-analysis-services-2025)、[MSAL Node 认证请求](https://learn.microsoft.com/en-us/entra/msal/javascript/node/acquire-token-requests)、[XMLA 连接](https://learn.microsoft.com/en-us/fabric/enterprise/powerbi/service-premium-connect-tools)、[Fabric getDefinition 权限](https://learn.microsoft.com/en-us/rest/api/fabric/semanticmodel/items/get-semantic-model-definition)。
