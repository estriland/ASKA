# ASKA

ASKA 是 Windows 桌面聊天客户端，支持文字聊天、消息朗读、语音通话和双语字幕。首次启动时可填写自己的模型 API。在设置中可以管理连接、角色设定和通话选项。

语音通话时，将鼠标移到底边即可展开麦克风、挂断和字幕等控件，移开后会自动收起。也可以用 Tab 键操作。

## 从源码启动

需要 Python 3.12 和带有 `node:sqlite` 的 Node.js。本版使用 Node.js 24.16.0。请在仓库根目录依次运行以下命令。

```powershell
py -3.12 -m venv app\.venv
.\app\.venv\Scripts\python.exe -m pip install -r app\requirements\requirements-desktop.txt
npm.cmd ci --prefix app\brain --omit=dev
.\app\.venv\Scripts\python.exe launcher\build.py
.\ASKA.exe
```

也可以用 `app\.venv\Scripts\python.exe app\client\release_entry.py` 从命令行启动。源码默认提供中性文字聊天。

本地朗读使用支持 BF16 的 NVIDIA CUDA 显卡。显存宽裕时使用全 GPU 推理，显存较紧时自动将文本查表放在系统内存中，声学模型和波形解码仍在显卡上运行。文字聊天可以独立使用。

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

自有程序采用 GPL-3.0-only。模型、角色素材及第三方组件各有适用条款。[代码许可](LICENSE) · [第三方声明](app/THIRD_PARTY_NOTICES.md)
