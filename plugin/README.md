# USTC API Guard 1.0.0

在 DSH 或 TokenWorks（词元工坊）中查看 USTC 模型的用量、预计费用和历史图表。

## 安装

面向 Windows 10/11 桌面版 DSH 和 TokenWorks；请先启动应用一次，创建配置。macOS、Linux、Windows ARM 暂未验证。

1. 下载并完整解压 `DSH-Token-Guard-v1.0.0.zip`。
2. 保存工作，完全退出应用，包括托盘进程和更新器。
3. 双击 `install.bat`，选择 DSH 或 TokenWorks，输入程序文件的完整路径，再选择实际使用的配置目录。
4. 提示安装完成后重新启动应用。

无需另外安装 Node.js 或 npm；使用 Windows PowerShell 5.1。配置目录需位于可写的本地 NTFS 磁盘。安装器不固定盘符或用户名，有多个配置时请选对目标。

## 卸载

完全退出应用后，运行解压目录中的 `uninstall.bat`，选择相同程序和配置。卸载会移除插件及加载登记，保留用量记录、其他配置和恢复备份。

## 使用

- 选择 USTC 模型后，在面板查看今日、近 3 小时和近 12 小时用量。
- 点击详情按钮，查看 Token 或预计费用图表；可以切换时间范围、筛选类型、点击柱子查看明细。
- 点击最小化按钮收起面板，点击浮条恢复；拖动顶部横条移动，双击复位。
- 费用为本机估算，不等同平台账单。

## 界面预览

以下图片由当前插件界面渲染，使用示例数据。

### 主面板

![主面板：今日费用、RPM、并发和近期用量](assets/previews/main.png)

### 最小化

![最小化浮条：今日和近3小时费用](assets/previews/minimized.png)

### Token 图表

![Token详情：时段分布与历史趋势](assets/previews/tokens.png)

### 费用图表

![预计费用：时段分布与历史趋势](assets/previews/cost.png)

## 许可

原创代码采用 MIT。鲸鱼娘模型和美术采用 [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/)，作者为上善无形、ZipZipPipe、氵六青，模型未修改；其他素材及运行库的许可文件随插件保留。
