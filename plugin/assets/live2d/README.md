# 鲸鱼娘 Live2D

来源：https://github.com/A8Chann/dsh-pet-live2d （2026-10-04 下载）。
角色原作：上善无形；DeepSeek 女仆二次设计：ZipZipPipe；Live2D 绑定、动作和表情：氵六青。
模型、美术未修改，许可 CC BY-NC-SA 4.0；原始署名和条件见 NOTICE.md 与 whale/LICENSE。
vendor.js 来自上述项目，含 PixiJS 8.19.0 与 untitled-pixi-live2d-engine 1.3.5。
代码许可见 UPSTREAM-LICENSE、PIXI-LICENSE、ENGINE-LICENSE。
renderer.js 是 USTC 插件新增的透明渲染、眨眼、跟随、自拍互动与释放逻辑。

Live2D Cubism Core 为 Live2D Inc. 专有运行库，本发布包不包含或分发 Core。
首次使用从官方 https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js 获取，
仅缓存到用户自己的 DSH_HOME/ustc-guard/live2d-cache；后续可离线使用。
下载失败或 WebGL 不可用时回退 GIF，不影响监控。模型始终从插件本地加载，无用户对话数据进入角色 iframe。
Core 官方许可：https://www.live2d.com/sdk/license/ 。分享或商业发布前须分别遵守 Core 和美术许可。
