"""用户可配置的远程多模态 API 配置。

配置只写入被 Git 忽略的 ``client/config.local.json``。UI 的 QSettings
不保存密钥，避免敏感信息进入注册表或诊断资料。
"""
from __future__ import annotations

import json
import hashlib
import hmac
import os
import uuid
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse

from core.app_config import LOCAL_CONFIG_PATH, deepseek_api_key


CUSTOM_API_PROVIDER = "custom-api"
CUSTOM_API_CONFIG_KEY = "CUSTOM_API_PROFILE"
ACTIVE_ID = "CUSTOM_API_PROFILE_ID"
SAVED = "CUSTOM_API_SAVED_PROFILES"
BOOK_SECRET = "CUSTOM_API_BOOK_SECRET"
LEGACY_ID = "legacy"
SUPPORTED_API_TYPES = {
    "openai-completions",
    "openai-responses",
    "anthropic-messages",
    "google-generative-ai",
}


def _read_config(path: Path) -> dict:
    try:
        value = json.loads(Path(path).read_text(encoding="utf-8-sig"))
    except FileNotFoundError:
        return {}
    if not isinstance(value, dict):
        raise ValueError('本机配置须为 JSON 对象，请检查配置文件')
    return value


def normalize_custom_api_profile(value: dict) -> dict:
    """校验并规范化一个 Pi 可注册的自定义 API 配置。"""
    if not isinstance(value, dict):
        raise ValueError("API 配置必须是对象")

    name = str(value.get("name") or "自定义 API").strip()[:80]
    model_id = str(value.get("model_id") or "").strip()
    if not model_id or len(model_id) > 200:
        raise ValueError("请填写有效的模型 ID")

    base_url = str(value.get("base_url") or "").strip().rstrip("/")
    parsed = urlparse(base_url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("API 地址必须是完整的 http:// 或 https:// URL")
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError('API 地址请只填写服务地址；密钥放在 API Key 栏')

    api_type = str(
        value.get("api_type") or "openai-completions").strip()
    if api_type not in SUPPORTED_API_TYPES:
        raise ValueError("不支持的 API 协议")

    try:
        context_window = int(value.get("context_window", 128000))
        max_tokens = int(value.get("max_tokens", 8192))
    except (TypeError, ValueError) as exc:
        raise ValueError("上下文和最大输出必须是整数") from exc
    if not 4096 <= context_window <= 2_000_000:
        raise ValueError("上下文必须在 4096 到 2000000 之间")
    if not 256 <= max_tokens <= min(context_window, 262144):
        raise ValueError("最大输出必须在 256 到上下文长度之间")

    return {
        "provider": CUSTOM_API_PROVIDER,
        "name": name or "自定义 API",
        "base_url": base_url,
        "api_key": str(value.get("api_key") or "").strip(),
        "model_id": model_id,
        "api_type": api_type,
        "supports_vision": bool(value.get("supports_vision", True)),
        'supports_reasoning': bool(value.get('supports_reasoning',
            parsed.scheme == 'https' and parsed.hostname == 'api.deepseek.com')),
        "context_window": context_window,
        "max_tokens": max_tokens,
    }


def load_custom_api_profile(path: Path = LOCAL_CONFIG_PATH) -> dict | None:
    try:
        return load_api_connections(path).active
    except (OSError,ValueError):
        return None


def saved_api_provider(selection, custom, path=LOCAL_CONFIG_PATH):
    """A clean installation starts with an empty connection form."""
    if selection == CUSTOM_API_PROVIDER:
        return CUSTOM_API_PROVIDER if custom else 'none'
    if selection == 'deepseek':
        return 'deepseek' if deepseek_api_key() else 'none'
    if selection == 'none':
        return 'none'
    if custom:
        return CUSTOM_API_PROVIDER
    try:
        return 'deepseek' if _read_config(path).get('DEEPSEEK_API_KEY') else 'none'
    except (OSError,ValueError):
        return 'none'


def connection_revision(profile,secret):
    identity=[profile[k] for k in ('api_type','base_url','model_id','api_key')]
    return hmac.new(bytes.fromhex(secret),json.dumps(identity,ensure_ascii=False).encode('utf8'),hashlib.sha256).hexdigest()


@dataclass
class ApiConnections:
    active_id: str | None
    profiles: dict
    secret: str

    @property
    def active(self):
        return self.routed(self.active_id)

    def routed(self,key):
        if key is None:
            return None
        value = self.profiles[key].copy()
        if key != LEGACY_ID:
            value['connection_id'] = key
            value['connection_revision']=connection_revision(value,self.secret)
        return value

    @classmethod
    def from_config(cls, config):
        saved = config.get(SAVED, {})
        if not isinstance(saved,dict):
            raise ValueError('已保存连接的格式无效，请检查本机配置文件')
        profiles = {key:normalize_custom_api_profile(value) for key,value in saved.items()}
        current = config.get(CUSTOM_API_CONFIG_KEY)
        active_id = config.get(ACTIVE_ID, LEGACY_ID) if current is not None else None
        if active_id is not None:
            if not isinstance(active_id,str):
                raise ValueError('当前连接 ID 无效')
            if active_id in profiles:
                raise ValueError('当前连接 ID 与已保存连接重复')
            profiles[active_id] = normalize_custom_api_profile(current)
        if current is not None and active_id is None:
            raise ValueError('当前连接 ID 缺失')
        for key in profiles:
            if not isinstance(key,str) or (key != LEGACY_ID and
                    (len(key)!=32 or any(c not in '0123456789abcdef' for c in key))):
                raise ValueError('连接 ID 无效')
        secret=config.get(BOOK_SECRET,'')
        if (secret or any(key!=LEGACY_ID for key in profiles)) and (not isinstance(secret,str)
                or len(secret)!=64 or any(c not in '0123456789abcdef' for c in secret)):
            raise ValueError('本机连接校验信息无效')
        return cls(active_id, profiles, secret)


def load_api_connections(path: Path = LOCAL_CONFIG_PATH) -> ApiConnections:
    return ApiConnections.from_config(_read_config(path))


@contextmanager
def _edit_connections(path):
    from PyQt6.QtCore import QLockFile
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    lock = QLockFile(str(path) + '.lock')
    if not lock.tryLock(2500):
        raise OSError('配置文件正在使用，请稍后重试')
    try:
        config = _read_config(path)
        book = ApiConnections.from_config(config)
        if not book.secret:
            book.secret=os.urandom(32).hex()
        yield book
        # The old single-profile field owns the active body. Other IDs live only in SAVED.
        config[CUSTOM_API_CONFIG_KEY] = book.profiles.get(book.active_id)
        config[ACTIVE_ID] = book.active_id
        config[BOOK_SECRET] = book.secret
        config[SAVED] = {key:value for key,value in book.profiles.items() if key!=book.active_id}
        temporary = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
        try:
            with temporary.open('x',encoding='utf8') as stream:
                json.dump(config,stream,ensure_ascii=False,indent=2)
                stream.write('\n')
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary,path)
        finally:
            temporary.unlink(missing_ok=True)
    finally:
        lock.unlock()


def save_custom_api_profile(value: dict,
                            path: Path = LOCAL_CONFIG_PATH, *, connection_id=None, new=False) -> dict:
    """Save and activate; previous single-profile callers update the active entry."""
    profile = normalize_custom_api_profile(value)
    with _edit_connections(path) as book:
        if new:
            key = uuid.uuid4().hex
        else:
            key = connection_id or book.active_id or LEGACY_ID
            if connection_id and key not in book.profiles:
                raise ValueError('该连接已被移除，请重新选择')
        book.profiles[key] = profile
        book.active_id = key
    return book.active


def activate_api_connection(key, path: Path = LOCAL_CONFIG_PATH):
    with _edit_connections(path) as book:
        if key not in book.profiles:
            raise ValueError('该连接已被移除，请重新选择')
        book.active_id = key
    return book.active


def remove_api_connection(key, path: Path = LOCAL_CONFIG_PATH):
    with _edit_connections(path) as book:
        if key not in book.profiles:
            raise ValueError('该连接已被移除')
        del book.profiles[key]
        if book.active_id == key:
            book.active_id = None
    return book
