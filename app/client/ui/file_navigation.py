"""Reveal a configuration file without reading its possibly secret contents."""
from pathlib import Path
import sys
from PyQt6.QtCore import QProcess, QUrl
from PyQt6.QtGui import QDesktopServices


def reveal_configuration(file):
    target = Path(file).resolve()
    if not target.is_file():
        raise ValueError('配置文件尚未生成，请先保存对应设置：' + str(target))
    if sys.platform == 'win32':
        result = QProcess.startDetached('explorer.exe', ['/select,', str(target)])
        ok = result[0] if isinstance(result, tuple) else result
    else:
        ok = QDesktopServices.openUrl(QUrl.fromLocalFile(str(target.parent)))
    if not ok: raise OSError('无法定位配置文件：' + str(target))
