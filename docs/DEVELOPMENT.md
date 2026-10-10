# 开发说明

公开README是客户使用说明；HTML与便携插件README由tools/build-help.mjs从该内容生成。预览图片位于plugin/assets/previews，使用示例数据，图片署名及许可随插件保留。

保留plugin/源码及测试、tools/构建安装工具、docs/说明和plugin/assets/资源布局。开发需要Node.js及Windows PowerShell。

```powershell
node --test --test-concurrency=1 plugin/test/*.test.mjs
node tools/build-help.mjs
node tools/build-release.mjs
node tools/verify-release.mjs
```

独立克隆默认产物在被忽略的output/。完整工作区校验已存在正式产物时，在public执行：

```powershell
node tools/verify-release.mjs ../release/v1.0.0
```

构建工具拒绝覆盖已有产物。正式包修正须先保留原文件并有用户授权，不能自行删除历史成果。GitHub提交、Push与发布须明确授权。版本固定1.0.0，只有用户明确要求才能升版。

preview-ui.mjs使用示例数据；预览所需React UMD及官方Core需要用户自行准备在被忽略的temp/中，Core不随仓库/发布包分发。真实宿主验证和安装访问实际目标，不能将合成验证当作桌面或在线验收。