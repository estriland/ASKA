# ASKA｜角色扮演本地语音agent

在 Windows 桌面上，你可以给明日香发消息，也可以直接打电话给她。你说中文，她用日语接话，通话时可以看中文字幕。回复由你选择的对话模型生成，语音识别和语音合成都在你的电脑上运行。

## 下载与首次使用

**[从百度网盘下载 Windows x64 一体包](https://pan.baidu.com/s/1DFTuypLlNCj58E_ndevmwQ)**　提取码 `ASKA`

当前版本 **RC7-r2**，大小 **6.46 GiB**，内含运行环境和日语语音模型。文字聊天可单独使用，本地朗读需要支持 BF16 的 NVIDIA CUDA 显卡。[发行说明与 SHA-256 校验值](https://github.com/estriland/ASKA/releases/tag/v2026.11.27-rc7)

1. 完整解压 `ASKA-Windows-x64-2026.11.27-rc7-r2.7z`，双击根目录的 `ASKA.exe`。
2. 首次设置时可以填写你希望明日香怎么称呼你、你们是什么关系，也可以留空。进入「模型连接」后，填写自己的 API 地址、模型名称和服务商要求的 API Key，点「保存并开始」。
3. 在输入框里发一条消息，或点右侧的电话按钮开始通话。通话时把鼠标移到底边，就能展开麦克风、挂断和字幕控件，移开后会自动收起。也可以用 Tab 键操作。

## 从昨天的消息聊到今天的电话

介绍片里，你昨天给明日香发了条消息，说「明天早饭打算吃沙拉」。第二天接通电话，她问「昨天说的沙拉，好吃吗？」

> **你**　我吃了一碗牛肉面。里面也有两片青菜。
>
> **明日香**　へえ。その二枚がサラダってわけ？（哦，那两片就是你的沙拉啊？）

文字聊天和通话共用对话历史。在「角色设定」的「说话性格」里，可以写下「和熟人偶尔开两句玩笑」。你选的模型会结合前文与这个口吻来接话。挂断后可以展开通话记录，回听她说过的话。

## 角色声线与流式 TTS

介绍片里，明日香把同一句「あんたバカ？」说了两遍，一遍害羞，一遍生气。这条日语声线基于 Qwen3-TTS 微调。训练时，每段原音都配上台词和日文读法，比如给句尾标注「拉长，再放低」。

本机采用流式合成，第一段声音生成后就开始播放，后面的声音接着生成。在 RTX 5090 上以全 GPU 模式预热后，实测四句日语，从开始合成到返回首段音频用时 **0.32–0.34 秒**。显存较紧时，程序会把文本查表放到系统内存中，声学模型和波形解码仍在显卡上运行。

## 从源码启动

源码默认提供中性文字聊天。需要 Python 3.12 和带有 `node:sqlite` 的 Node.js。本版使用 Node.js 24.16.0。请在仓库根目录依次运行以下命令。

```powershell
py -3.12 -m venv app\.venv
.\app\.venv\Scripts\python.exe -m pip install -r app\requirements\requirements-desktop.txt
npm.cmd ci --prefix app\brain --omit=dev
.\app\.venv\Scripts\python.exe launcher\build.py
.\ASKA.exe
```

也可以用 `app\.venv\Scripts\python.exe app\client\release_entry.py` 从命令行启动。

要重新生成便携版的程序文件，请使用该版随附的 Python 3.12.10 与 esbuild 0.25.12。从本仓库根目录运行以下命令，输出位置选一个新目录。

```powershell
npm.cmd install --prefix .build-tools --save-exact esbuild@0.25.12
py -3.12 launcher\build_runtime.py --app app --output build-code --esbuild .build-tools\node_modules\@esbuild\win32-x64\esbuild.exe
```

将输出文件覆盖到对应便携版副本的 `app` 中即可使用修改后的程序。保留该版的模型、配置与运行依赖。日语和双语版使用同一份程序，`BUILD_INFO.json` 记录语音版本，`BUILD_CODE.json` 记录编译输入和产物。

## 文件布局

- `app/client` 提供桌面界面，`app/brain` 提供本地对话服务，`app/voice` 提供语音识别和语音合成。
- `launcher` 包含 Windows 图形启动器的源码、编译脚本和「02」图标的矢量原稿。编译使用 Windows 的 .NET Framework 4.x 编译器和 `app/assets/aska.ico`。
- 首次运行后，聊天与回放保存在 `app/user-data`，模型连接保存在 `app/client/config.local.json`。

ASKA 是非官方同人项目。自有程序采用 GPL-3.0-only，模型、角色素材及第三方组件各有适用条款。[代码许可](LICENSE) · [第三方声明](app/THIRD_PARTY_NOTICES.md)
