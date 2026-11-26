"""Start the exported source or portable desktop, with a separate writable profile."""
import os
from pathlib import Path
import shutil
import socket
import sys

ROOT=Path(__file__).resolve().parents[1]
sys.path[:0]=[str(ROOT/'client'),str(ROOT)]
from core.runtime_paths import configure_storage


def configure():
    directory=ROOT/'user-data'
    directory.mkdir(exist_ok=True)
    (directory/'logs').mkdir(exist_ok=True)
    configure_storage(directory,relationship=True)
    os.environ['PI_CODING_AGENT_DIR']=os.environ['PI_AGENT_DIR']
    # The model settings UI and documented source setup use the same key file.
    os.environ['ASUKA_LOCAL_CONFIG']=str(ROOT/'client/config.local.json')
    node=ROOT/'runtime/node/node.exe'
    executable=str(node) if node.is_file() else shutil.which('node')
    if not executable:raise FileNotFoundError('需要安装 Node.js，或完整解压便携运行时。')
    if not os.environ.get('ASUKA_BRAIN_PORT'):
        with socket.socket() as reserved:
            reserved.bind(('127.0.0.1',0))
            os.environ['ASUKA_BRAIN_PORT']=str(reserved.getsockname()[1])
    os.environ.update(ASUKA_PROJECT_ROOT=str(ROOT),ASUKA_NODE_EXE=executable,ASUKA_REQUIRE_OWN_BRAIN='1',
                      ASUKA_WINDOW_TITLE='ASKA',PYTHONIOENCODING='utf-8')
    quality=ROOT/'quality/desktop.json'
    if quality.is_file():
        os.environ['ASUKA_QUALITY_CONFIG']=str(quality)
        catalog=ROOT/'quality/character-memory'
        if catalog.is_dir():
            os.environ['ASUKA_CHARACTER_MEMORY_ROOT']=str(catalog)
    bundled=ROOT/'runtime/python'
    if bundled.is_dir():
        from core.voice_edition import multilingual_available, installed_edition
        if installed_edition(ROOT) == 'ja-zh':
            for weight in ('models/tts/model/model.safetensors', 'models/tts/speaker.safetensors'):
                if not (ROOT / weight).is_file():
                    raise FileNotFoundError('中日双语版缺少 ' + weight + '，请完整解压。')
        os.environ.update(ASUKA_WHISPER_ASR_PYTHON=str(bundled/'python.exe'),
            ASUKA_WHISPER_LITE_MODEL=str(ROOT/'models/asr/faster-whisper-small'),
            ASUKA_VAD_MODEL_DIR=str(bundled/'Lib/site-packages/silero_vad/data'))
        if multilingual_available():
            os.environ['ASUKA_TTS_MODEL_DIR']=str(ROOT/'models/tts/model')
    return directory


def main():
    directory=configure()
    from PyQt6.QtCore import QLockFile
    lock=QLockFile(str(directory/'desktop.lock'))
    lock.setStaleLockTime(0)
    if not lock.tryLock(0):
        from PyQt6.QtWidgets import QApplication, QMessageBox
        from PyQt6.QtGui import QIcon
        app=QApplication(sys.argv[:1])
        app.setWindowIcon(QIcon(str(ROOT/'assets/aska.ico')))
        QMessageBox.information(None,'ASKA','这份 ASKA 已经打开。')
        return
    try:
        template=ROOT/'client/config.portable.example.json'
        config=ROOT/'client/config.local.json'
        if template.is_file() and not config.exists():
            shutil.copyfile(template,config)
        import main as desktop
        desktop.main()
    finally:
        lock.unlock()


if __name__=='__main__':
    main()
