"""Build the Windows GUI launcher with the framework compiler included on Windows 10/11."""
import argparse
import os
from pathlib import Path
import subprocess


def main():
    here = Path(__file__).resolve().parent
    root = here.parent
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=root / "ASKA.exe")
    parser.add_argument("--icon", type=Path, default=root / "app/assets/aska.ico")
    args = parser.parse_args()
    framework = Path(os.environ["SystemRoot"]) / "Microsoft.NET"
    compiler = next((p for architecture in ("Framework64", "Framework")
                     if (p := framework / architecture / "v4.0.30319/csc.exe").is_file()), None)
    if compiler is None:
        parser.error("Install the .NET Framework 4.x compiler for Windows.")
    subprocess.run([str(compiler), "/nologo", "/target:winexe", "/optimize+", "/codepage:65001",
                    "/reference:System.Windows.Forms.dll", "/win32icon:" + str(args.icon.resolve()),
                    "/out:" + str(args.output.resolve()), str(here / "Launcher.cs")], check=True)


if __name__ == "__main__":
    main()
