"""集中管理本机路径、端口和敏感配置。"""
from __future__ import annotations

import json
import os
from pathlib import Path


PROJECT_ROOT = Path(
    os.environ.get("ASUKA_PROJECT_ROOT", Path(__file__).resolve().parents[2])
).resolve()
CLIENT_DIR = PROJECT_ROOT / "client"
ASSETS_DIR = PROJECT_ROOT / "assets"
BRAIN_DIR = PROJECT_ROOT / "brain"
BUILTIN_PERSONALITY_GRAPHS_DIR = BRAIN_DIR / "personality" / "graphs"
IMPORTED_PERSONALITY_GRAPHS_DIR = (
    PROJECT_ROOT / "data" / "personality" / "graphs"
)

PI_HOST = "127.0.0.1"
PI_PORT = int(os.environ.get("ASUKA_BRAIN_PORT", "18836"))
PI_BASE_URL = f"http://{PI_HOST}:{PI_PORT}"

LLAMA_HOST = "127.0.0.1"
LLAMA_PORT = int(os.environ.get("ASUKA_LLAMA_PORT", "18837"))
LLAMA_BASE_URL = f"http://{LLAMA_HOST}:{LLAMA_PORT}"

LOCAL_CONFIG_PATH = Path(os.environ.get("ASUKA_LOCAL_CONFIG", CLIENT_DIR / "config.local.json")).resolve()


def _load_local_config() -> dict:
    try:
        value = json.loads(LOCAL_CONFIG_PATH.read_text(encoding="utf-8-sig"))
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


LOCAL_CONFIG = _load_local_config()


def local_value(name: str, default=None):
    """环境变量优先，其次读取不入 Git 的 config.local.json。"""
    env_value = os.environ.get(name)
    if env_value not in (None, ""):
        return env_value
    return LOCAL_CONFIG.get(name, default)


# 保持 PATH 中的 node 作为开发环境默认值；便携包通过环境变量指向随包运行时。
NODE_EXE = str(local_value("ASUKA_NODE_EXE", PROJECT_ROOT / "runtime/node/node.exe"))


LLAMA_DIR = Path(local_value("ASUKA_LLAMA_DIR", str(PROJECT_ROOT / "optional" / "llama.cpp")))
MODELS_DIR = Path(local_value(
    "ASUKA_LLM_MODELS_DIR",
    str(PROJECT_ROOT / "optional" / "llm"),
))
TTS_MODEL_DIR = Path(local_value(
    "ASUKA_TTS_MODEL_DIR", str(PROJECT_ROOT / "assets-local" / "light-voice")))
_bundled_speaker = PROJECT_ROOT / "models" / "tts" / "speaker.safetensors"
TTS_REF_AUDIO = Path(local_value(
    "ASUKA_TTS_REF_AUDIO",
    _bundled_speaker if _bundled_speaker.is_file() else PROJECT_ROOT / "assets-local" / "light-reference.wav",
))
WHISPER_MODEL = Path(local_value(
    "ASUKA_WHISPER_MODEL",
    str(PROJECT_ROOT / "voice" / "models" / "faster-whisper-large-v3"),
))
WHISPER_LITE_MODEL = Path(local_value(
    "ASUKA_WHISPER_LITE_MODEL",
    str(PROJECT_ROOT / "voice" / "models" / "faster-whisper-small"),
))
WHISPER_LITE_CPU_THREADS = int(local_value(
    "ASUKA_WHISPER_LITE_CPU_THREADS",
    str(max(2, min(8, os.cpu_count() or 4))),
))
WHISPER_ASR_PYTHON = Path(local_value(
    "ASUKA_WHISPER_ASR_PYTHON",
    str(PROJECT_ROOT / "voice" / "python312" / "python.exe"),
))
QWEN_ASR_PYTHON = Path(local_value(
    "ASUKA_QWEN_ASR_PYTHON",
    str(PROJECT_ROOT / "voice" / "qwen-asr-python" / "python.exe"),
))
QWEN_ASR_MODEL = Path(local_value(
    "ASUKA_QWEN_ASR_MODEL",
    str(PROJECT_ROOT / "assets-local" / "qwen-asr"),
))
VAD_MODEL_DIR = Path(local_value(
    "ASUKA_VAD_MODEL_DIR",
    str(PROJECT_ROOT / "voice" / "python312" / "Lib" / "site-packages"
        / "silero_vad" / "data"),
))


def deepseek_api_key() -> str:
    return str(local_value("DEEPSEEK_API_KEY", "")).strip()
