"""Capabilities and shared weights of the installed portable edition."""
from functools import lru_cache
import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile

PROJECT_ROOT = Path(os.environ.get("ASUKA_PROJECT_ROOT", Path(__file__).resolve().parents[2])).resolve()


@lru_cache(maxsize=None)
def installed_edition(root=PROJECT_ROOT):
    info = Path(root) / "BUILD_INFO.json"
    if not info.is_file():
        return None
    edition = json.loads(info.read_text("utf8")).get("voice_edition")
    if edition not in (None, "ja", "ja-zh"):
        raise ValueError("无法识别语音版本，请检查 BUILD_INFO.json。")
    return edition


def multilingual_available():
    return installed_edition() != "ja"


def prepare_multilingual_codec(root=PROJECT_ROOT):
    """Give the unmodified model loader its expected file; both models use identical weights."""
    if installed_edition(root) != "ja-zh":
        return
    source = root / "quality/qwen-base/speech_tokenizer/model.safetensors"
    target = root / "models/tts/model/speech_tokenizer/model.safetensors"
    if target.is_file():
        return
    if not source.is_file():
        raise FileNotFoundError("缺少随包的语音编解码器，请重新完整解压。")
    expected = json.loads((root / "quality/contents.json").read_text("utf8"))["qwen-base/speech_tokenizer/model.safetensors"]
    with source.open("rb") as stream:
        if hashlib.file_digest(stream, "sha256").hexdigest() != expected:
            raise ValueError("共享编解码器与本版模型校验不一致。")
    try:
        os.link(source, target)
        return
    except FileExistsError:
        if target.is_file():
            return
        raise
    except OSError:
        # Removable media and some network drives cannot make hard links.
        with tempfile.NamedTemporaryFile(dir=target.parent, prefix=".codec-", suffix=".tmp", delete=False) as output:
            temp = Path(output.name)
        try:
            shutil.copyfile(source, temp)
            os.replace(temp, target)
        finally:
            temp.unlink(missing_ok=True)
