"""语音通话会话的共享状态与客户端事件契约。"""
from __future__ import annotations

from enum import Enum


class VoiceCallState(str, Enum):
    IDLE = "idle"
    DIALING = "dialing"
    CONNECTED = "connected"
    MUTED = "muted"
    RESTORING_MIC = "restoring_mic"
    DISCONNECTING = "disconnecting"
    FAILED = "failed"


ACTIVE_CALL_STATES = frozenset({
    VoiceCallState.DIALING,
    VoiceCallState.CONNECTED,
    VoiceCallState.MUTED,
    VoiceCallState.RESTORING_MIC,
})

TTS_PLAYBACK_STATES = frozenset({
    VoiceCallState.CONNECTED,
    VoiceCallState.MUTED,
    VoiceCallState.RESTORING_MIC,
})

MICROPHONE_MUTED_EVENT = "microphone_muted"
MICROPHONE_UNMUTED_EVENT = "microphone_unmuted"
MICROPHONE_EVENTS = frozenset({
    MICROPHONE_MUTED_EVENT,
    MICROPHONE_UNMUTED_EVENT,
})


CALL_STATE_LABELS = {
    VoiceCallState.IDLE: "未接通",
    VoiceCallState.DIALING: "正在拨号",
    VoiceCallState.CONNECTED: "通话中",
    VoiceCallState.MUTED: "麦克风关闭",
    VoiceCallState.RESTORING_MIC: "恢复麦克风",
    VoiceCallState.DISCONNECTING: "正在挂断",
    VoiceCallState.FAILED: "未能接通",
}


def call_state_label(state):
    """返回稳定的中文界面标签；未知状态安全回退为未接通。"""
    try:
        normalized = VoiceCallState(state)
    except (TypeError, ValueError):
        normalized = VoiceCallState.IDLE
    return CALL_STATE_LABELS[normalized]
