"""隔离 Qwen3-ASR worker 的客户端配置。"""
from core.app_config import (
    PROJECT_ROOT, QWEN_ASR_MODEL, QWEN_ASR_PYTHON,
)
from core.asr_worker_client import ASRWorkerClient


WORKER_PATH = PROJECT_ROOT / "voice" / "asr" / "qwen_asr_worker.py"


class QwenASRClient(ASRWorkerClient):
    def __init__(self, python_path=QWEN_ASR_PYTHON,
                 model_path=QWEN_ASR_MODEL, timeout=180,
                 worker_path=None):
        super().__init__(
            backend_name="Qwen3-ASR",
            python_path=python_path,
            model_path=model_path,
            worker_path=worker_path or WORKER_PATH,
            model_env="ASUKA_QWEN_ASR_MODEL",
            log_filename="qwen-asr.log",
            timeout=timeout,
        )
