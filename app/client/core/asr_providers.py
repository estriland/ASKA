"""本地 ASR Provider 元数据与隔离 worker 适配器。"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Callable


@dataclass(frozen=True)
class ASRProviderMetadata:
    provider_id: str
    label: str
    resource_hint: str
    requires_gpu: bool = False
    supports_mixed_language: bool = True


class WorkerASRProvider:
    """把隔离 ASR worker 适配到统一的本地 Provider 接口。"""

    def __init__(self, metadata: ASRProviderMetadata,
                 client_getter: Callable[[], object]):
        self.metadata = metadata
        self._client_getter = client_getter

    @property
    def is_available(self):
        return bool(self._client_getter().is_available)

    @property
    def is_running(self):
        return bool(self._client_getter().is_running)

    def availability_error(self):
        return self._client_getter().availability_error()

    def warmup(self):
        self._client_getter().warmup()

    def transcribe(self, audio, sample_rate, language="mixed"):
        return self._client_getter().transcribe(
            audio, sample_rate, language=language)

    def close(self):
        self._client_getter().close()
