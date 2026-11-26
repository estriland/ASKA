"""隔离 faster-whisper worker 的客户端配置。"""
from core.app_config import (
    PROJECT_ROOT, WHISPER_ASR_PYTHON, WHISPER_LITE_CPU_THREADS,
    WHISPER_LITE_MODEL, WHISPER_MODEL,
)
from core.asr_worker_client import ASRWorkerClient


WORKER_PATH = PROJECT_ROOT / "voice" / "asr" / "whisper_asr_worker.py"


class WhisperASRClient(ASRWorkerClient):
    def __init__(self, python_path=WHISPER_ASR_PYTHON,
                 model_path=WHISPER_MODEL, timeout=180,
                 worker_path=None):
        super().__init__(
            backend_name="Whisper",
            python_path=python_path,
            model_path=model_path,
            worker_path=worker_path or WORKER_PATH,
            model_env="ASUKA_WHISPER_MODEL",
            log_filename="whisper-asr.log",
            timeout=timeout,
        )


class WhisperLiteASRClient(ASRWorkerClient):
    """CPU INT8 Whisper Small；不创建 CUDA context。"""

    def __init__(self, python_path=WHISPER_ASR_PYTHON,
                 model_path=WHISPER_LITE_MODEL, timeout=180,
                 worker_path=None, cpu_threads=WHISPER_LITE_CPU_THREADS):
        super().__init__(
            backend_name="Whisper Small CPU",
            python_path=python_path,
            model_path=model_path,
            worker_path=worker_path or WORKER_PATH,
            model_env="ASUKA_WHISPER_MODEL",
            log_filename="whisper-lite-asr.log",
            timeout=timeout,
            extra_env={
                "ASUKA_WHISPER_DEVICE": "cpu",
                "ASUKA_WHISPER_COMPUTE_TYPE": "int8",
                "ASUKA_WHISPER_CPU_THREADS": max(1, int(cpu_threads)),
            },
        )

    def availability_error(self):
        if not self.model_path.is_dir():
            return (
                "尚未安装 Whisper Small 本地模型；请运行 "
                "voice\\python312\\python.exe tools\\asr\\install_whisper_lite.py")
        return super().availability_error()
