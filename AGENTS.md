# 公开仓库开发规范

- 阅读README及任务要求后检查Git状态，保留已有改动；只执行当前明确授权任务，完成后停止。
- plugin/包含源码、测试及plugin/assets/资源；tools/包含安装、构建与验证；docs/包含用户说明和开发说明。保留现有模块路径，不为统一目录强行改名。
- 业务逻辑、包名、状态键和schema迁移须单独授权与验证；工作区整理不修改这些内容。
- Node回归：node --test --test-concurrency=1 plugin/test/*.test.mjs。构建与发布校验见docs/DEVELOPMENT.md；完整工作区的正式输出显式指定../release/v版本号，独立克隆默认输出在忽略的output/。
- 安装/真实宿主验证会访问实际目标，执行前必须有明确授权；不要修改凭据、限额或真实账本。合成测试与实际验收必须分开说明。
- Agent对话、内部报告、memory、证据日志、密钥及用户配置不得写入或提交仓库。检查git diff及候选文件，.gitignore不会清除既有历史。
- Reviewer独立只读审核并报告意见，不擅自修改代码。未明确授权不得提交、Push、建GitHub Release、改写历史、删除历史资料或覆盖已有发布包。
- 第三方素材保留独立许可和署名，Live2D Core不入库。独立仓库无法访问内部资料时只使用当前用户授权，不补造验收或内部状态。
- 用户明确锁定版本1.0.0，只有用户明确要求才能改版本号；修复和文档更新不得自动升版。公开README是客户说明唯一内容源，HTML和插件README由tools/build-help.mjs生成；开发操作见docs/DEVELOPMENT.md，不混入客户说明。

