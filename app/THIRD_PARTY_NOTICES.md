# 第三方组件与模型

便携版采用推理用 PyTorch 运行时，随包保留 CUDA 和 CPU 动态库。Torch 静态链接库、SDK 头文件、CMake 文件与 protobuf 开发编译器在组装时排除。已安装分发的 RECORD 和组件索引记录实际文件范围。自有 JavaScript 以 esbuild 0.25.12 生成两个 ESM 入口，构建工具由开发者安装。[esbuild](https://esbuild.github.io/)

Windows 版的 `THIRD_PARTY_COMPONENTS.json` 按实际安装目录列出 Python 和 npm 的版本、来源及随附许可文件。Python 解释器的许可位于 `runtime/python/LICENSE.txt`，Node 和其内置组件的声明位于 `runtime/node/LICENSE`。Python wheel 与 npm 模块自带的版权、许可和 NOTICE 文件保留在安装目录中。源码版使用 `brain/package-lock.json` 和 `requirements/` 安装依赖。

| 组件 | 本版用途与来源 |
|---|---|
| PyQt6 6.11.0、PyQt6-sip 13.12.0 | 桌面绑定采用 GPL 路线。对应版本的源码分发见 [PyQt6](https://pypi.org/project/PyQt6/6.11.0/#files) 和 [PyQt6-sip](https://pypi.org/project/PyQt6-sip/13.12.0/#files)。 |
| Qt 6.11.1 | Qt 动态库随 PyQt6-Qt6 提供，许可文件位于该 wheel 的 dist-info 目录。[Qt 6.11.1 源码](https://download.qt.io/archive/qt/6.11/6.11.1/single/) |
| PyQt6-Frameless-Window 0.8.2、pywin32 312 | 窗口框架与 Windows 接口。随附原文见 `licenses/window-frame/`。[窗口库](https://github.com/zhiyiYo/PyQt-Frameless-Window) · [pywin32](https://github.com/mhammond/pywin32) |
| Pi、MiniSearch | 对话后台与本地检索。版本见 npm 锁文件。[Pi](https://github.com/earendil-works/pi) · [MiniSearch](https://github.com/lucaong/minisearch) |
| Qwen3-TTS、faster-qwen3-tts | 语音基座及推理。使用 Qwen3-TTS-12Hz-1.7B-Base；日语叠加本项目的 288 步适配器和说话人参数。多语言模型经项目微调，另附音色参数。基座的 Apache-2.0 与推理组件的 MIT 原文分别在 `licenses/Qwen-Apache-2.0.txt` 和 `voice/tts/vendor/LICENSE-faster-qwen3-tts.txt`。[基座](https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-Base) · [流式推理](https://github.com/andimarafioti/faster-qwen3-tts) |
| Whisper Small、faster-whisper、Silero VAD | 语音识别与活动检测。SYSTRAN 的 Small 是 OpenAI Whisper 的 CTranslate2 转换，模型卡标注 MIT。Whisper 许可见 `licenses/Whisper-MIT.txt`。[模型及转换说明](https://huggingface.co/Systran/faster-whisper-small) · [Silero VAD](https://github.com/snakers4/silero-vad) |

项目贡献者以 GPL-3.0-only 授予自有程序的使用、修改及再分发权利。角色文本、声音表演、角色形象与派生声音参数的权利按各自来源处理。Windows 版还包含 PyTorch、CUDA 运行库、音频编解码库等二进制组件，随附的第三方条款适用于相应组件。
