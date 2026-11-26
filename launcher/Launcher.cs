using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Text;
using System.Windows.Forms;

[assembly: AssemblyTitle("ASKA")]
[assembly: AssemblyProduct("ASKA")]
[assembly: AssemblyDescription("ASKA 桌面客户端")]

internal static class Launcher
{
    // ProcessStartInfo on .NET Framework takes one Windows command line.
    private static string Quote(string argument)
    {
        var result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char c in argument)
        {
            if (c == '\\') { slashes++; continue; }
            result.Append('\\', c == '"' ? slashes * 2 + 1 : slashes);
            result.Append(c);
            slashes = 0;
        }
        result.Append('\\', slashes * 2);
        return result.Append('"').ToString();
    }

    [STAThread]
    private static int Main(string[] args)
    {
        try
        {
            string app = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "app");
            string entry = Path.Combine(app, "client", "release_entry.py");
            if (!File.Exists(entry)) entry += "c";
            bool bundled = Directory.Exists(Path.Combine(app, "runtime", "python"));
            string python = bundled ? Path.Combine(app, "runtime", "python", "pythonw.exe")
                                    : Path.Combine(app, ".venv", "Scripts", "pythonw.exe");
            if (!File.Exists(entry) || !File.Exists(python))
                throw new FileNotFoundException("找不到桌面程序或 Python 环境。请将 ASKA.exe 与完整的 app 文件夹放在一起。源码版请先按 README 安装环境。");
            if (bundled)
            {
                foreach (string file in new[] { @"runtime\node\node.exe", @"models\asr\faster-whisper-small\model.bin",
                                                @"quality\desktop.json", @"quality\qwen-base\model.safetensors",
                                                @"quality\voice-288\adapter_model.safetensors" })
                    if (!File.Exists(Path.Combine(app, file)))
                        throw new FileNotFoundException("便携版缺少 app\\" + file + "。请恢复完整的 app 文件夹。");
            }

            var command = new List<string> { "-B", "-X", "utf8", Quote(entry) };
            foreach (string argument in args) command.Add(Quote(argument));
            var start = new ProcessStartInfo(python, string.Join(" ", command.ToArray())) {
                WorkingDirectory = app, UseShellExecute = false, CreateNoWindow = true
            };
            using (var process = Process.Start(start))
            {
                process.WaitForExit();
                if (process.ExitCode != 0)
                    MessageBox.Show("客户端退出时报告了错误。请查看 app\\user-data\\logs。", "ASKA",
                                    MessageBoxButtons.OK, MessageBoxIcon.Error);
                return process.ExitCode;
            }
        }
        catch (Exception error)
        {
            MessageBox.Show(error.Message, "ASKA", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }
}
