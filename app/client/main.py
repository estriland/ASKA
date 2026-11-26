# asuka-ai/client/main.py
# llama.cpp 可视化客户端 (照 Codex 风格)
import sys
import os
import threading
import time
import uuid
from collections import Counter, deque
from pathlib import Path
sys.path.insert(0, os.path.dirname(__file__))

# Direct invocation follows the same private project/runtime entry as the .bat files.
if __name__ == '__main__':
    if (Path(__file__).resolve().parent / 'quality.refactor.json').is_file():
        from voice_candidate import main as launch_project
    else:
        from release_entry import main as launch_project
    launch_project()
    raise SystemExit(0)

# pythonw.exe（无控制台）下 sys.stdout/stderr 为 None，任何 print 都会崩。
# 兜底：换成 devnull，保证无声环境下也能跑。
if sys.stdout is None:
    sys.stdout = open(os.devnull, "w", encoding="utf-8", errors="replace")
if sys.stderr is None:
    sys.stderr = open(os.devnull, "w", encoding="utf-8", errors="replace")

from PyQt6.QtWidgets import (QApplication, QMainWindow, QWidget, QVBoxLayout,
                              QHBoxLayout, QComboBox, QPushButton, QTextEdit,
                              QLineEdit, QLabel, QCheckBox, QSpinBox,
                              QSlider, QListWidget, QDialog, QScrollArea,
                              QStackedWidget, QSplitter, QMenu, QFrame,
                              QDialogButtonBox, QMessageBox)
from PyQt6.QtCore import QEvent, Qt, QThread, QSettings, QTimer, QUrl, QPoint, QSize, pyqtSignal
from PyQt6.QtGui import QAction, QDesktopServices, QFont, QIcon, QKeySequence, QPixmap, QShortcut

from core.llama_manager import LlamaManager
from core.chat_failure import failure_from_exception, failure_message, record_failure, chat_failure
from core.pending_chat import PendingChatStore
from core.initiative import InitiativeController
from core.session_navigation import SessionNavigation, CancelReply, DeleteConversation, SessionListRead
from core.conversation_export import ExportConversation
from core.call_tones import CallTonePlayer
from core.call_audio import CallAudio
from core.tts_manager import TTSManager, can_read_reply, clean_for_tts, prepare_synthesis
from core.reply_delivery import SINGLE_VOICE
from core.app_config import ASSETS_DIR, PROJECT_ROOT, LOCAL_CONFIG_PATH, deepseek_api_key
from core.api_config import (
    CUSTOM_API_PROVIDER, load_custom_api_profile,
    save_custom_api_profile, saved_api_provider, load_api_connections,
    activate_api_connection, remove_api_connection, connection_revision, LEGACY_ID,
)
from core.metrics import elapsed_ms, latency, timer
from core.tts_diagnostics import REPORTS_DIR, tts_diagnostics
from core.voice_call import (
    ACTIVE_CALL_STATES, MICROPHONE_MUTED_EVENT,
    MICROPHONE_UNMUTED_EVENT, TTS_PLAYBACK_STATES,
    VoiceCallState, call_state_label,
)
from ui.pages import DiagnosticsPage, SettingsCard, SettingsPage, settings_form
from ui.dialogue_settings import DialogueSettingsCard
from ui.role_settings import RoleSettingsCard
from ui.api_connection import ApiConnectionFields
from ui.wheel_guard import WheelGuard
from ui.message_composer import MessageComposer
from ui.composer_bar import ComposerSurface, ContextIndicator, MenuButton, composer_icon
from ui.floating_chat import FloatingChatSurface
from ui.call_page import VoiceCallPage
from ui.voice_reveal import PlaybackProgress
from ui.themes import THEME_NAMES, apply_theme, theme_id, set_theme_style, colors, render_style, desktop_surface_style
from ui.window_frame import ThemedMainWindow, ThemedDialog
from core.context_usage import ContextUsageThread
from core.dictation import DictationController
from ui.file_navigation import reveal_configuration
from ui.appearance import SettingsSwitch, SidebarTitleDelegate, SidebarToggle
from ui.inference_settings import InferenceSettings, DESKTOP_PHASES
from ui.security_settings import SecuritySettings, security_badge, current_policy, mode_available, MODES as TOOL_MODES
from core.inference_config import DEEPSEEK_MODELS, load_inference, save_inference, stage_vision, CONFIG_PATH as INFERENCE_CONFIG_PATH, DEFAULT_PATH as INFERENCE_DEFAULT_PATH
from core.quality_config import QUALITY_MODES, config_path as quality_config_path, load_quality_config

# ---------- 对话线程（避免阻塞 UI） ----------
def desktop_settings():
    filename=os.environ.get('ASUKA_SETTINGS_PATH')
    if filename:
        Path(filename).parent.mkdir(parents=True,exist_ok=True)
        return QSettings(filename,QSettings.Format.IniFormat)
    return QSettings('Feiniao','release-hardening')


class ChatThread(QThread):
    result = pyqtSignal(str, str)    # 分离后的台词与翻译
    failed = pyqtSignal(dict)
    prior_reply = pyqtSignal(dict)
    tts_data = pyqtSignal(dict)      # TTS 结构化数据（speech/pauses/speeds）
    status = pyqtSignal(str)         # 隐藏事件失败只更新状态，不生成气泡
    progress = pyqtSignal(dict)
    finished_tts = pyqtSignal(bool)
    def __init__(self, manager, message=None, images=None, client_event=None,
                 personality_mode="light",
                 personality_state_scope="conversation", voice_enabled=False,
                 voice_preset='natural',request_id=None,session_id=None,voice_turn=None,voice_planner=None,call_language=None):
        super().__init__()
        self.manager = manager
        self.message = message
        self.images = images or []
        self.client_event = client_event
        self.personality_mode = personality_mode
        self.personality_state_scope = personality_state_scope
        self.voice_enabled = bool(voice_enabled)
        self.voice_turn = voice_turn
        self.voice_planner = voice_planner
        self.call_language = call_language
        self.call_generation = None
        self.call_interrupted = False
        self.voice_preset = voice_preset
        self.reply_data = {}
        self.request_id=request_id or str(uuid.uuid4())
        self.session_id=session_id
        self.request_packet=None
        self.call_history_ready=None
        self.immediate_followup=False
        self.followup_turn=None
        self.turn_location={}
        self.restart_request_id=None
        self.pending_store=None
        self.user_row=None
        self.cancel_requested=False
        self.cancel_event=threading.Event()
        self.manual_retry=False
        self.previous_pending=None
        self.prior_request_id=None
    def _lookup_packet(self,packet):
        if not packet:return None
        try:
            found=self.manager.lookup_reply(**{k:packet[k] for k in ('message','images','personality_mode','personality_state_scope',
                'request_id','session_id','group_id','call_id','voice_enabled','voice_preset','voice_turn','voice_planner','call_language') if k in packet})
            return found if isinstance(found,dict) and not found.get('failure') and not found.get('error') else None
        except (OSError,ValueError):return None
    def _packet_for(self,request_id,fallback=None):
        if fallback and fallback.get('request_id')==request_id:return fallback
        if self.pending_store:
            try:return self.pending_store.find_request(self.session_id,request_id)
            except (OSError,ValueError):pass
        return None
    def _cancel_status(self,request_id,session_id):
        status=self.manager.brain.cancel_native(request_id,session_id,details=True)
        return status if isinstance(status,dict) else {'cancelled':status is True,'completed':False}
    def _emit_prior(self,data,request_id):
        self.prior_request_id=request_id
        packet = self._packet_for(request_id,self.previous_pending)
        self.prior_reply.emit({**data,'surface':'call'} if packet and packet.get('call_language') else data)
    def run(self):
        # 统一走 Pi 脑层：整段返回，不分段 emit（保持完整回复）
        succeeded = False
        try:
            if self.call_history_ready is not None:
                deadline = timer() + 25
                while not self.call_history_ready.wait(.08):
                    if self.cancel_event.is_set():
                        self.failed.emit(chat_failure('用户取消',code='CHAT_CANCELLED')['failure'])
                        return
                    if timer() >= deadline:
                        self.failed.emit(chat_failure('通话事件仍在等待后台确认',code='CALL_HISTORY_PENDING')['failure'])
                        return
                if self.call_history_ready.rejected:
                    self.failed.emit(chat_failure('原通话无法接收这一轮',code='CALL_REQUEST_UNBOUND',retryable=False)['failure'])
                    return
            if self.cancel_requested:
                self.failed.emit(chat_failure('用户取消',code='CHAT_CANCELLED')['failure']);return
            if self.previous_pending:
                previous=self.previous_pending
                target=previous.get('recovery_request_id') or previous['request_id']
                packet=self._packet_for(target,previous);found=self._lookup_packet(packet)
                if found is not None:self._emit_prior(found,target)
                elif target!=previous['request_id'] or not previous.get('failure_closed'):
                    status=self._cancel_status(target,previous.get('session_id'))
                    if status.get('completed'):
                        found=self._lookup_packet(packet)
                        if found is not None:self._emit_prior(found,target)
                    elif not status.get('cancelled') and not status.get('inactive'):
                        self.failed.emit(chat_failure('Previous request has not settled',code='PREVIOUS_REQUEST_PENDING',recovery_request_id=status.get('recovery_request_id') or target)['failure']);return
            data=None
            if self.manual_retry and self.client_event is None:
                try:data=self.manager.lookup_reply(message=self.message,images=self.images,
                    **{k:v for k,v in (self.request_packet or {}).items() if k in ('group_id','call_id') and v},
                    personality_mode=self.personality_mode,personality_state_scope=self.personality_state_scope,
                    request_id=self.request_id,session_id=self.session_id,voice_enabled=self.voice_enabled,voice_preset=self.voice_preset,
                    **({'voice_planner':self.voice_planner} if self.voice_planner is not None else {}), **({'call_language':self.call_language} if self.call_language else {}),
                    **({'voice_turn':self.voice_turn} if self.voice_turn else {}))
                except (OSError,ValueError):pass
            if data is None and self.restart_request_id:
                target=self.restart_request_id
                status=self._cancel_status(target,self.session_id)
                if status.get('completed'):
                    found=self._lookup_packet(self._packet_for(target,self.request_packet))
                    if target==self.request_id:
                        if found is None:
                            self.failed.emit(chat_failure('Completed result is not yet readable',code='REQUEST_UNCERTAIN',retryable=False)['failure']);return
                        data=found
                    elif found is not None:self._emit_prior(found,target)
                elif status.get('inactive'):
                    if target==self.request_id:
                        self.failed.emit(chat_failure('Original request source is not readable',code='REQUEST_UNCERTAIN',retryable=False)['failure']);return
                elif not status.get('cancelled'):
                    self.failed.emit(chat_failure('Previous request has not settled',code='PREVIOUS_REQUEST_PENDING',recovery_request_id=status.get('recovery_request_id') or target)['failure']);return
                elif target==self.request_id:
                    self.request_id=str(uuid.uuid4())
                    self.request_packet['request_id']=self.request_id
                    if self.pending_store:self.pending_store.save(self.request_packet)
            if self.cancel_requested:
                self.failed.emit(chat_failure('用户取消',code='CHAT_CANCELLED')['failure']);return
            self.progress.emit({'stage':'requesting','text':'正在请求回复'})
            if data is None:data = self.manager.chat(
                self.message, images=self.images,
                **({'immediate_followup':True} if self.immediate_followup and self.followup_turn is not None
                   and not self.followup_turn.stop.is_set() else {}),
                **{k:v for k,v in (self.request_packet or self.turn_location).items() if k in ('group_id','call_id') and v},
                client_event=self.client_event,
                personality_mode=self.personality_mode,
                personality_state_scope=self.personality_state_scope,
                on_progress=self.progress.emit,
                request_id=self.request_id,session_id=self.session_id,cancel_event=self.cancel_event,
                **({'manual_retry':True} if self.manual_retry else {}),
                **({'voice_turn':self.voice_turn} if self.voice_turn else {}),
                **({'voice_planner':self.voice_planner} if self.voice_planner is not None else {}), **({'call_language':self.call_language} if self.call_language else {}),
                **({'voice_enabled': self.voice_enabled, 'voice_preset': self.voice_preset}
                   if self.voice_turn or self.personality_mode in QUALITY_MODES else {}))
            if self.cancel_requested:
                if not data.get('reply_saved') and self.client_event is None:
                    saved=self._lookup_packet(self.request_packet)
                    if saved and saved.get('reply_saved'):data=saved
                if not data.get('reply_saved'):
                    self.failed.emit(chat_failure('用户取消',code='CHAT_CANCELLED')['failure']);return
                # The backend already published this exact reply. Keep it in
                # sync with history, while honoring the request to stop audio.
                self.cancel_requested=False
                data={**data,'voice_preset':None,'voice_expression':None}
                data.pop('voice_error',None)
            if data.get('failure') or 'error' in data:
                problem=data.get('failure') or chat_failure(data.get('error'),code=data.get('code'),
                    analysis_complete=data.get('analysis_complete') is True)['failure']
                self.failed.emit(problem)
                return
            if data.get('silence'):
                self.tts_data.emit(data)
                succeeded = True
                return
            personality_warning = str(
                (data.get("personality") or {}).get("warning") or "")
            if personality_warning:
                record_failure({'code':'REPLY_ADAPTATION','detail':personality_warning},stage='reply-adaptation')
            if (self.client_event is not None
                    and (not data or not data.get("speech"))):
                self.status.emit(str(
                    (data or {}).get("text")
                    or "麦克风状态事件没有生成角色回复"))
            elif data and isinstance(data.get('speech'),str) and data['speech'].strip():
                succeeded = True
                self.reply_data = data
                self.result.emit(
                    data['speech'],
                    str(data.get("translation") or ""))
                self.tts_data.emit(data)
            elif self.client_event is None:
                self.failed.emit(chat_failure(data.get('text','Empty result'),code='EMPTY_OUTPUT')['failure'])
        except Exception as e:
            self.failed.emit(failure_from_exception(e))
        finally:
            self.finished_tts.emit(succeeded)

# ---------- TTS 朗读线程 ----------
class SpeakThread(QThread):
    diagnostic_ready = pyqtSignal(object)
    playback_error = pyqtSignal(object)
    audio_saved = pyqtSignal(str)
    segments_ready = pyqtSignal(object)
    segment_playing = pyqtSignal(int)
    audio_drained = pyqtSignal()
    voice_generated = pyqtSignal(object)

    def __init__(self, tts, text, pauses=None,
                 diagnostic_context=None,
                 on_play_start=None, on_play_end=None, language=None,
                 voice_preset=None, voice_expression=None, playback_id=None, replay=False):
        super().__init__()
        self.tts = tts
        self.text = text
        self.pauses = pauses or []
        self.diagnostic_context = diagnostic_context or {}
        self.language = language
        self.voice_preset = voice_preset
        self.voice_expression = voice_expression
        self.playback_id, self.replay = playback_id, replay
        self.on_play_start = on_play_start
        self.on_play_end = on_play_end
        self.call_stop = None
        self.call_render = None
        self.progress = PlaybackProgress(text)
        self.output_drained = False
        self.drained_at = None
        self.parent_followup = None
        self.child_followup = None
        self.child_start_allowed = None

    def _device_drained(self):
        self.drained_at = time.perf_counter()
        self.output_drained = True
        self.audio_drained.emit()

    def _plan_playback(self, segments):
        self.progress.set_segments(segments)
        self.segments_ready.emit(segments)

    def _start_segment(self, index):
        self.progress.segment_started(index)
        self.segment_playing.emit(index)

    def run(self):
        try:
            if self.call_stop is not None and self.call_stop.is_set():
                return
            if self.on_play_start:
                self.on_play_start()
            if self.child_followup is not None:
                job = self.child_followup
                prepared = job.audio
                self.progress.use_recording({'sample_rate':prepared.sample_rate,'samples':len(prepared.audio),
                                             'generation':{'segments':prepared.segments},'actual_generation':prepared.generation})
                try:
                    saved = self.tts.play_prepared(prepared,self.playback_id,self.call_stop,on_segments=self._plan_playback,
                        on_segment=self._start_segment,on_render=self.call_render,on_drained=self._device_drained,
                        start_allowed=self.child_start_allowed)
                except (OSError,ValueError) as error:
                    if not self.output_drained: raise
                    self.playback_error.emit({'code':'AUDIO_SAVE_FAILED','detail':str(error)})
                    return
                if saved: self.audio_saved.emit(saved)
                return
            stored=(self.playback_id and self.tts.audio_replay.enabled and self.tts.audio_replay.record(self.playback_id))
            if self.replay or stored:
                self.progress.use_recording(stored)
                self.tts.play_saved(self.playback_id, on_segments=self._plan_playback, on_segment=self._start_segment,
                                    **({'cancel_event':self.call_stop,'on_render':self.call_render,
                                        'on_drained':self._device_drained} if self.call_stop is not None else {}))
                return
            options = {'pauses': self.pauses, 'diagnostic_context': self.diagnostic_context,
                       'on_segments': self._plan_playback, 'on_segment': self._start_segment}
            if self.call_stop is not None:
                options.update(cancel_event=self.call_stop,on_render=self.call_render,on_drained=self._device_drained)
            if self.language:
                options['language'] = self.language
            if self.voice_preset is not None:
                options.update(voice_preset=self.voice_preset, voice_expression=self.voice_expression)
            if self.playback_id: options['playback_id'] = self.playback_id
            if self.parent_followup is not None: options['on_generated']=self.voice_generated.emit
            diagnostic = self.tts.speak_structured(self.text, **options)
            if getattr(self.tts, 'last_saved_audio', None):
                self.audio_saved.emit(self.tts.last_saved_audio)
            if getattr(self.tts, 'last_audio_save_error', ''):
                self.playback_error.emit({'code':'AUDIO_SAVE_FAILED','detail':self.tts.last_audio_save_error})
            if diagnostic:
                self.diagnostic_ready.emit(diagnostic)
        except Exception as error:
            if self.call_stop is None or not self.call_stop.is_set():
                self.playback_error.emit({'code':'AUDIO_REPLAY_FAILED' if self.replay else 'AUDIO_GENERATION_FAILED','detail':str(error)})
        finally:
            if self.on_play_end:
                self.on_play_end()


class LocalModelThread(QThread):
    """后台启动/停止本地模型，避免 35B 加载阻塞 Qt 主线程。"""
    result = pyqtSignal(object)

    def __init__(self, manager, action, model_file=None,
                 context_size=65536, use_vision=False):
        super().__init__()
        self.manager = manager
        self.action = action
        self.model_file = model_file
        self.context_size = context_size
        self.use_vision = use_vision

    def run(self):
        try:
            if self.action == "stop":
                ok, message = self.manager.stop()
                self.result.emit({
                    "action": "stop", "server_ok": ok,
                    "route_ok": False, "message": message,
                })
                return
            ok, message = self.manager.start(
                self.model_file, self.context_size, self.use_vision)
            route_ok = False
            if ok:
                pi_ok, pi_message = self.manager.pi_start()
                if pi_ok:
                    route_ok, route_message = self.manager.pi_set_model(
                        "local", "qwen", vision=self.use_vision,
                        context_window=self.context_size)
                    message = f"{message}；{route_message}"
                else:
                    message = f"{message}；Pi 未就绪：{pi_message}"
            self.result.emit({
                "action": "start", "server_ok": ok,
                "route_ok": route_ok, "message": message,
            })
        except Exception as exc:
            self.result.emit({
                "action": self.action, "server_ok": False,
                "route_ok": False,
                "message": f"本地模型操作失败：{exc}",
            })

# ---------- 主窗口 ----------
class MainWindow(ThemedMainWindow):
    # 语音输入信号（ASR 后台线程 → 主线程）
    asr_state_sig = pyqtSignal(str)
    asr_result_sig = pyqtSignal(str)
    asr_level_sig = pyqtSignal(float)  # 用户说话实时电平
    tts_level_sig = pyqtSignal(float)  # 明日香播放实时电平
    asr_spectrum_sig = pyqtSignal(object)  # 用户语音 FFT 频带
    tts_spectrum_sig = pyqtSignal(object)  # TTS 输出 FFT 频带
    tts_playback_end_sig = pyqtSignal(object)
    startup_status_sig = pyqtSignal(str)
    brain_ready_sig = pyqtSignal()
    brain_failed_sig = pyqtSignal(str)
    voice_task_sig = pyqtSignal(object)
    call_input_sig = pyqtSignal(object)
    call_tone_finished_sig = pyqtSignal(str, int)

    def __init__(self, *, development=False):
        super().__init__()
        self.development = bool(development)
        self.setAcceptDrops(True)
        self.manager = LlamaManager()
        self.tts = TTSManager(diagnostics_enabled=self.development)
        # 语音输入引擎（麦克风 → CPU VAD → 可切换 ASR Provider）
        from core.asr_manager import ASRManager
        self.asr = ASRManager(
            on_result=self._on_asr_result_raw,
            on_state=self._on_asr_state_raw,
            on_level=self._on_asr_level_raw,
            on_spectrum=self._on_asr_spectrum_raw,
        )
        # 信号桥：ASR 线程 → 主线程（PyQt 控件跨线程不安全）
        self.asr_state_sig.connect(self._on_asr_state)
        self.asr_result_sig.connect(self._on_asr_result)
        self.asr_level_sig.connect(self._on_asr_level)
        self.tts_level_sig.connect(self._on_tts_level)
        self.asr_spectrum_sig.connect(self._on_asr_spectrum)
        self.tts_spectrum_sig.connect(self._on_tts_spectrum)
        self.tts_playback_end_sig.connect(self._on_tts_playback_end)
        self.startup_status_sig.connect(self.append_status)
        self.brain_ready_sig.connect(self._on_brain_ready)
        self.voice_task_sig.connect(self._on_voice_task_result)
        self.call_input_sig.connect(self._on_call_input)
        self.call_tone_finished_sig.connect(self._on_call_tone_finished)
        self._active_tts_row = None
        self._asr_visual_active = False
        self._tts_visual_active = False
        self._chat_started_at = None
        self._chat_busy = False
        self._reply_failure = False
        self._local_model_thread = None
        self._local_model_busy = False
        self._call_state = VoiceCallState.IDLE
        self.dictation = DictationController(self.asr, self)
        self.dictation.text_ready.connect(self._insert_dictation)
        self.dictation.changed.connect(self._on_dictation_state)
        self.dictation.failed.connect(lambda text: self._voice_problem('dictation',text))
        self._context_thread = None
        self._context_generation = 0
        self._context_key = None
        self._context_timer = QTimer(self)
        self._context_timer.setInterval(15000)
        self._context_timer.timeout.connect(self._request_context_usage)
        self._call_generation = 0
        self._read_aloud_started_call = False
        self._resume_read_aloud = False
        self._upgrade_after_prime = False
        self._active_call_id = None
        self._relationship_group_id = None
        self._relationship_call_group_id = None
        self.relationship_view = None
        self.immediate_followup = None
        self._call_started = False
        self._interrupted_call_reply = None
        self._reveal_timer = QTimer(self)
        self._reveal_timer.setInterval(65)
        self._reveal_timer.timeout.connect(self._tick_voice_reveal)
        self._call_audio = None
        self._call_duck_span = None
        self._reply_caption = ''
        self._initial_mic = False
        self._mic_lifecycle = threading.Lock()
        self._mic_generation = 0
        self._asr_release_generation = None
        self._voice_task_thread = None
        self._dial_resources_ready = False
        self._mic_resources_ready = False
        self._call_audio_ready = False
        self._tts_queue = deque()
        self._replay_active = False
        self._pending_client_event = None
        self._pending_mic_event = None
        self._active_chat_kind = "user"
        self._mic_event_timer = QTimer(self)
        self._mic_event_timer.setSingleShot(True)
        self._mic_event_timer.timeout.connect(self._commit_microphone_event)
        self._call_tones = CallTonePlayer(
            on_error=lambda exc: self.startup_status_sig.emit(
                f"拨号提示音不可用，继续连接：{exc}"))
        self._pending_files = []
        self._file_worker = None
        self._attachment_generation = 0
        self._chat_user_row = None
        self._closing = False
        self._cancel_workers=set()
        self._voice_tasks=set()
        self._startup_thread=None
        self._delivery_threads=set()
        self._shutdown_cleanup=None
        self._shutdown_timer=QTimer(self)
        self._shutdown_timer.setInterval(80)
        self._shutdown_timer.timeout.connect(self.close)
        self.setWindowTitle(os.environ.get('ASUKA_WINDOW_TITLE') or
                            ("ASKA · 开发客户端" if self.development else "ASKA"))
        self.setMinimumSize(760, 510)
        available = self.screen().availableGeometry()
        self.resize(min(1280,available.width()), min(760,available.height()))
        # 头像/背景资源路径
        assets = str(ASSETS_DIR)
        self._assets_dir = assets
        default_avatar = os.path.join(assets, "asuka_avatar.png")
        self._asuka_avatar = default_avatar if os.path.exists(default_avatar) else None
        default_user_avatar = os.path.join(assets, "user_avatar.png")
        self._user_avatar = (
            default_user_avatar if os.path.exists(default_user_avatar) else None)
        default_bg = os.path.join(assets, "chat_background.png")
        self._chat_bg = default_bg if os.path.exists(default_bg) else None
        self._settings = desktop_settings()
        pending_root=(Path(self._settings.fileName()).parent/'pending-chat') if self._settings.format()==type(self._settings).Format.IniFormat else None
        self._pending_store=PendingChatStore(os.environ.get('ASUKA_PENDING_CHAT_DIR') or pending_root)
        self._failed_packet=None
        self._failed_row=None
        self._failed_chat=None
        self._failed_problem={}
        self._waiting_for_backend=False
        self._chat_thread=None
        self._current_session=None
        self._pending_session_id=None
        self._navigation_worker=None
        self._queued_navigation=None
        self._delete_worker=None
        self._export_worker=None
        self._list_workers=set()
        self._list_generation=0
        self._navigation_blocked=False
        self._startup_navigation=False
        self._backend_connecting=False
        self._queued_asr=None
        self._draft_loading=False
        self.brain_failed_sig.connect(self._on_backend_failed)
        self._theme_id = theme_id(self._settings.value('appearance/theme', 'night'))
        apply_theme(self._theme_id)
        self._custom_api_profile = load_custom_api_profile()
        self._background_opacity = int(
            self._settings.value("chat/background_opacity", 48))
        self._background_opacity = max(10, min(100, self._background_opacity))
        self.setup_ui()
        if os.environ.get('ASUKA_RELATIONSHIP_DIR'):
            from ui.relationship_view import RelationshipView
            from core.immediate_followup import ImmediateFollowup
            self.relationship_view = RelationshipView(self,self.chat_sidebar_layout,self.session_heading)
            self.immediate_followup = ImmediateFollowup(self)
        self.input_box.textChanged.connect(self._save_draft)
        self._wheel_guard = WheelGuard(self)
        self.chat_display.set_background_opacity(self._background_opacity / 100.0)
        if self._chat_bg:
            self.chat_display.set_background(self._chat_bg)
        self.apply_dark_style()
        # TTS 播放电平回调（明日香说话时波形）——桥接到主线程
        self.tts._on_level = self.tts_level_sig.emit
        self.tts._on_spectrum = self.tts_spectrum_sig.emit
        self._sessions = []
        self._current_session = None
        self._initiative_controller = None
        self._initiative_typing_at = float('-inf')
        self._initiative_asr_state = 'idle'
        if os.environ.get('ASUKA_RELATIONSHIP_DIR'):
            self._initiative_controller = InitiativeController(
                self.manager.brain, self._initiative_availability, self._receive_initiative, self)
            self.input_box.textChanged.connect(self._initiative_input_changed)
            self._initiative_controller.start()
        self.auto_start()

    def _initiative_input_changed(self):
        if not self._draft_loading and self.input_box.text().strip():
            self._initiative_typing_at = time.monotonic()

    def _initiative_availability(self):
        session_id = (self._current_session or {}).get('id')
        view = getattr(self, 'relationship_view', None)
        if self.immediate_followup and self.immediate_followup.current is not None:
            return None
        if (not session_id or view is None or not view.ready or view.erasing or self._closing or
                self._navigation_blocked or self._startup_navigation or self._backend_connecting or
                self._chat_busy or self._waiting_for_backend or self._queued_asr or self._cancel_workers or
                self._delete_worker or self.dictation.active or self._pending_files or
                self.input_box._ime_active or time.monotonic() - self._initiative_typing_at < 6 or
                self._tts_queue or self.tts.is_speaking or getattr(self, '_pending_tts', False) or
                QApplication.activeModalWidget() is not None):
            return None
        for worker in (self._local_model_thread, self._file_worker, getattr(self, 'speak_thread', None)):
            if worker is not None and worker.isRunning():
                return None
        if self._call_state in {VoiceCallState.DIALING, VoiceCallState.DISCONNECTING, VoiceCallState.RESTORING_MIC}:
            return None
        route = {'relationship_id':session_id, 'group_id':self._relationship_group_id,
                 'reminders_only':bool(getattr(self, '_api_config_pending', False))}
        if self._call_audio is not None:
            if (not self._call_started or not self._active_call_id or self._call_audio.target or
                    self._initiative_asr_state in {'recording', 'transcribing'} or getattr(self.asr, '_current_speech', False)):
                return None
            route.update(call_id=self._active_call_id, call_language=self.call_language.currentData())
        return route

    def _receive_initiative(self, item):
        route = self._initiative_availability()
        if not route:
            return False
        behavior = item.get('behavior') or {}
        request = item.get('request_id')
        speech = behavior.get('speech')
        if request != 'initiative:' + str(item.get('id', '')) or not isinstance(speech, str) or not speech.strip():
            return False
        receipt_key = 'initiative/last_shown/' + route['relationship_id']
        from ui.widgets import ChatMessageRow
        if self._settings.value(receipt_key) == request:
            return True

        group = item.get('groupId')
        call_id = item.get('call_id')
        same_call = bool(call_id and call_id == route.get('call_id'))
        if route.get('call_id') and not same_call:
            return False
        area = self.relationship_view.shown
        if (not same_call and area.isVisibleTo(self) and
                any(not row.is_user and getattr(row,'request_id',None)==request and row.isVisibleTo(area)
                    for row in area.widget().findChildren(ChatMessageRow))):
            self._settings.setValue(receipt_key,request)
            self._settings.sync()
            return True
        row = None
        if same_call:
            chinese = behavior.get('language') == 'zh'
            self.voice_call_panel.set_caption(speech if chinese else behavior.get('translation', ''), '' if chinese else speech)
        elif (not call_id and area.isVisibleTo(self)
              and (self._relationship_group_id is None or self._relationship_group_id == group)):
            row = self._add_history_message({**behavior, 'role':'assistant', 'content':speech, 'request_id':request,
                                             'playback_id':item.get('playback_id')})
            if row is None:
                return False
            self.relationship_view.attach_row(row)
        else:
            if not self.relationship_view.arrival(group,notice='通话记录，展开后可查看' if call_id else '消息'):
                return False
        self._settings.setValue(receipt_key, request)
        self._settings.sync()
        background = self.isMinimized() or not self.isActiveWindow()
        if same_call or (not call_id and not background and self._read_aloud_started_call):
            self._read_initiative(item, row, route)
        elif not route.get('call_id') and background:
            # Short, low-volume chirp. With no continuation it only notifies.
            self._call_tones.play_connected()
        return True

    def _read_initiative(self, item, row, route):
        if not self.voice_check.isChecked() or not self.tts.enabled or not self._call_audio_ready:
            return
        behavior = item['behavior']
        speech, language = behavior['speech'], behavior['language']
        preset = self._personality_options().get('voice_preset') if language == 'ja' else None
        diagnostic = {}
        if preset:
            try:
                diagnostic['initiative_ticket'] = self.tts.bind_initiative_voice(item,route['relationship_id'],preset)
            except (OSError, ValueError, KeyError) as error:
                self._voice_problem('preparation', str(error))
                return
        request = item['request_id'] if route.get('call_id') else None
        if request:
            self._call_audio.expect(request)
        self._tts_queue.append({'text':speech, 'row':row, 'pauses':[], 'language':language, 'voice_preset':preset,
                                'voice_expression':None, 'playback_id':item.get('playback_id'), 'diagnostic_context':diagnostic,
                                'generation':self._call_generation, 'call_reply':request, 'subtitle':behavior.get('translation', '')})
        self._play_next_tts()

    def on_temp_change(self, val):
        self.tts.temperature = val / 100.0
        self.temp_label.setText(f"{self.tts.temperature:.1f}")
        self._settings.setValue("voice/temperature", val)

    def _on_backend_change(self, idx):
        import core.llama_manager as lm
        requested_mode = self.backend_combo.currentData()
        mode = "API 模型" if requested_mode == "api" else "本地模型"
        self._update_model_controls()
        if requested_mode == "local":
            if not self.manager.owns_server:
                # “当前对话路由”不能指向尚未运行的服务。本地模型配置栏
                # 始终可用，用户直接点击“启动本地”即可，成功后自动切换。
                self.backend_combo.blockSignals(True)
                self.backend_combo.setCurrentIndex(
                    self.backend_combo.findData("api"))
                self.backend_combo.blockSignals(False)
                lm.BACKEND_MODE = "api"
                self._update_model_controls()
                self.append_status("🟡 请先在设置 → 模型服务中配置并启动本地模型")
                return
            ok, msg = self.manager.pi_set_model(
                *lm.LOCAL_MODEL, vision=self.manager.use_vision,
                context_window=self.manager.context_size)
        else:
            ok, msg = self._apply_selected_api_route()
        if ok:
            lm.BACKEND_MODE = requested_mode
            self.append_status(f"后端切换为: {mode} ({msg})")
        else:
            self.append_status(f"⚠️ 后端切换失败: {msg}")

    def _populate_api_models(self, provider, preferred=None):
        self.api_model_combo.blockSignals(True)
        self.api_model_combo.clear()
        if provider == "deepseek":
            for model in DEEPSEEK_MODELS:
                self.api_model_combo.addItem(model['name'], model['id'])
            selected = preferred or str(self._settings.value(
                "api/deepseek_model", "deepseek-v4-pro"))
            index = self.api_model_combo.findData(selected)
            self.api_model_combo.setCurrentIndex(index if index >= 0 else 1)
        elif provider == CUSTOM_API_PROVIDER and self._custom_api_profile:
            profile = self._custom_api_profile
            suffix = " · 视觉" if profile["supports_vision"] else ""
            self.api_model_combo.addItem(
                f"{profile['name']} · {profile['model_id']}{suffix}",
                profile["model_id"],
            )
        else:
            self.api_model_combo.addItem("待配置模型连接", None)
        self.api_model_combo.blockSignals(False)

    def _selected_api_route(self):
        provider = self.api_provider_combo.currentData()
        if provider == CUSTOM_API_PROVIDER:
            profile = self._custom_api_profile
            if not profile:
                return None
            return {
                "provider": CUSTOM_API_PROVIDER,
                "model": profile["model_id"],
                "vision": profile["supports_vision"],
                "context_window": profile["context_window"],
                "profile": profile,
            }
        if provider!='deepseek' or not self.api_model_combo.currentData():
            return None
        model = self.api_model_combo.currentData()
        return {
            "provider": "deepseek", "model": model,
            "vision": any(m['id']==model and m['vision'] for m in DEEPSEEK_MODELS), "context_window": None, "profile": None,
        }

    def _set_api_runtime_route(self, route=None):
        import core.llama_manager as lm
        if route is None:route = self._selected_api_route()
        if route is None:
            lm.API_PROVIDER = lm.API_MODEL = lm.API_CONTEXT_WINDOW = None
            lm.API_VISION = False
            return None
        lm.API_PROVIDER = route["provider"]
        lm.API_MODEL = route["model"]
        lm.API_VISION = route["vision"]
        lm.API_CONTEXT_WINDOW = route["context_window"]
        return route

    def _apply_selected_api_route(self):
        route = self._selected_api_route()
        if route is None:
            result=self.manager.brain.request('POST','/configureApi',{'disabled':True},timeout=8)
            ok,message=bool(result.get('ok')),result.get('error','当前未启用模型连接')
        elif route["provider"] == CUSTOM_API_PROVIDER:
            # /configureApi 同时注册并应用模型，避免先 setModel 找不到模型。
            ok,message=self.manager.pi_configure_api(route["profile"])
        else:
            ok,message=self.manager.pi_set_model(route["provider"],route["model"])
        if ok:self._set_api_runtime_route(route)
        return ok,message

    def _on_api_provider_change(self, _idx):
        provider = self.api_provider_combo.currentData()
        if provider == CUSTOM_API_PROVIDER and not self._custom_api_profile:
            self._settings.setValue('api/provider',CUSTOM_API_PROVIDER)
            self._populate_api_models(provider)
            if getattr(self,'_chat_busy',False):
                self._api_config_pending=True
            else:
                self._set_api_runtime_route()
            self._refresh_header_model()
            self._update_model_controls()
            self.append_status("请先填写并保存模型连接")
            return
        self._settings.setValue("api/provider", provider)
        self._populate_api_models(provider)
        if getattr(self,'_chat_busy',False):
            self._api_config_pending=True
            self._refresh_header_model()
            self._update_model_controls()
            return
        self._refresh_header_model()
        self._update_model_controls()
        if (self.backend_combo.currentData() == "api"
                and self.manager.pi_is_running
                and self.manager.brain.is_compatible):
            self._api_config_pending=True
            self._apply_pending_api()
        else:self._set_api_runtime_route()

    def _on_api_model_change(self, idx):
        if getattr(self,'_chat_busy',False):
            self._api_config_pending=True
            model=self.api_model_combo.currentData()
            if model and self.api_provider_combo.currentData()=='deepseek':
                self._settings.setValue('api/deepseek_model',model)
                self._settings.setValue('api/shared_model',model)
            return
        route = self._selected_api_route()
        if route is None:
            return
        if route["provider"] == "deepseek":
            self._settings.setValue("api/deepseek_model", route["model"])
            self._settings.setValue('api/shared_model', route['model'])
            # 兼容旧版本配置键。
            self._settings.setValue("api/model", route["model"])
        self._refresh_header_model()
        if (self.backend_combo.currentData() == "api"
                and self.manager.pi_is_running
                and self.manager.brain.is_compatible):
            import core.llama_manager as lm
            lm.BACKEND_MODE = "api"
            self._api_config_pending=True
            self._apply_pending_api()
        else:
            self._set_api_runtime_route(route)
            self.append_status(f"API 模型已选择: {route['model']}")

    @staticmethod
    def _profile_id(profile):
        return (profile.get('connection_id') or LEGACY_ID) if profile else None

    def _refresh_api_picker(self):
        self.saved_api_combo.clear()
        try:
            book = load_api_connections()
        except (OSError,ValueError) as error:
            self.custom_api_state_label.setText(f'读取连接失败：{error}')
            self.saved_api_combo.setEnabled(False)
            self.save_custom_api_btn.setEnabled(False)
            return
        profiles = dict(book.profiles)
        if self._custom_api_profile:
            profiles.setdefault(self._profile_id(self._custom_api_profile),self._custom_api_profile)
        labels = {k:f'{p["name"]} · {p["model_id"]}' if p['name']!=p['model_id'] else p['name'] for k,p in profiles.items()}
        counts=Counter(labels.values())
        for key in sorted(labels,key=lambda k:(labels[k].casefold(),k)):
            label = labels[key]
            if counts[label]>1:
                label += ' · ' + key[:6]
            self.saved_api_combo.addItem(label,key)
        if deepseek_api_key():
            self.saved_api_combo.addItem('DeepSeek（原有连接）','@deepseek')
        if self._editing_api_id is None:
            self.saved_api_combo.addItem('新连接',None)
        self.saved_api_combo.setCurrentIndex(self.saved_api_combo.findData(self._editing_api_id))
        self.remove_api_button.setEnabled(self._editing_api_id in profiles)

    def _can_leave_api_editor(self):
        if self.api_editor.values()==self.api_editor.initial:
            return True
        return QMessageBox.question(self,'未保存的连接','放弃当前表单的编辑？',
            QMessageBox.StandardButton.Discard | QMessageBox.StandardButton.Cancel,
            QMessageBox.StandardButton.Cancel)==QMessageBox.StandardButton.Discard

    def _new_api_connection(self):
        if self._editing_api_id is None or not self._can_leave_api_editor():
            return
        self._editing_api_id = None
        self.api_editor.load({})
        self._refresh_api_picker()
        self.custom_api_state_label.setText('填写新连接，保存后启用。')
        self.api_editor.name.setFocus()

    def _select_saved_api(self,index):
        key = self.saved_api_combo.itemData(index)
        if key==self._editing_api_id:
            return
        if not self._can_leave_api_editor():
            self.saved_api_combo.setCurrentIndex(self.saved_api_combo.findData(self._editing_api_id))
            return
        if key=='@deepseek':
            self._editing_api_id=key
            self.api_provider_combo.setCurrentIndex(self.api_provider_combo.findData('deepseek'))
            self.api_editor.load(self._legacy_api_fields())
            self._refresh_api_picker()
            self.custom_api_state_label.setText('已选择原有 DeepSeek 连接。')
            return
        if key is None:
            self._new_api_connection()
            return
        try:
            profile=activate_api_connection(key)
        except (OSError,ValueError) as error:
            self.custom_api_state_label.setText(f'切换失败：{error}')
            self._refresh_api_picker()
            return
        self._use_custom_api(profile)

    def _legacy_api_fields(self):
        return {'name':'DeepSeek','base_url':'https://api.deepseek.com','api_key':deepseek_api_key(),
                'model_id':str(self._settings.value('api/deepseek_model','deepseek-v4-pro')),
                'api_type':'openai-completions','supports_vision':True,'supports_reasoning':True,
                'context_window':1000000,'max_tokens':196608}

    def _remove_api_connection(self):
        key=self._editing_api_id
        if key in (None,'@deepseek'):
            return
        if QMessageBox.question(self,'移除连接',f'从本机移除「{self.saved_api_combo.currentText()}」？',
                QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.Cancel,
                QMessageBox.StandardButton.Cancel)!=QMessageBox.StandardButton.Yes:
            return
        try:
            book=remove_api_connection(key)
        except (OSError,ValueError) as error:
            self.custom_api_state_label.setText(f'移除失败：{error}')
            return
        if self.immediate_followup and self._custom_api_profile!=book.active:
            self.immediate_followup.cancel('route_changed')
        self._custom_api_profile=book.active
        self._editing_api_id=book.active_id
        self.api_editor.load(book.active or {})
        if book.active is None:
            self.api_provider_combo.setCurrentIndex(self.api_provider_combo.findData('none'))
            self._settings.setValue('api/provider','none')
        self._refresh_api_picker()
        self.custom_api_state_label.setText('连接已移除。')

    def _save_custom_api(self):
        try:
            key=self._editing_api_id
            profile=save_custom_api_profile(self.api_editor.values(),
                connection_id=key if key not in (None,'@deepseek') else None,
                new=key in (None,'@deepseek'))
        except (OSError,ValueError) as error:
            self.custom_api_state_label.setText(f'配置未保存：{error}')
            return
        self._use_custom_api(profile)

    def _use_custom_api(self,profile):
        if self.immediate_followup and self._custom_api_profile!=profile:
            self.immediate_followup.cancel('route_changed')
        self._custom_api_profile=profile
        self._editing_api_id=self._profile_id(profile)
        self.api_editor.load(profile)
        self._refresh_api_picker()
        self.api_provider_combo.blockSignals(True)
        self.api_provider_combo.setCurrentIndex(self.api_provider_combo.findData(CUSTOM_API_PROVIDER))
        self.api_provider_combo.blockSignals(False)
        self._settings.setValue('api/provider',CUSTOM_API_PROVIDER)
        self._populate_api_models(CUSTOM_API_PROVIDER)
        self._update_model_controls()
        self._refresh_header_model()
        self._api_config_pending=True
        if self._chat_busy:
            self.custom_api_state_label.setText(f'当前回复结束后启用「{profile["name"]}」。')
            return
        if self.manager.pi_is_running and self.manager.brain.is_compatible:
            self._apply_pending_api()
        else:
            self._set_api_runtime_route()
            self.custom_api_state_label.setText(f'已选择「{profile["name"]}」，后台启动时应用。')

    def _apply_pending_api(self):
        if not getattr(self,'_api_config_pending',False):return True
        try:
            ok,message=self._apply_selected_api_route()
        except (OSError,RuntimeError,ValueError):
            ok,message=False,'后台暂时未连接，可稍后重试。'
        self._api_config_pending=not ok
        route=self._selected_api_route() if ok else None
        if ok and route and route.get('profile'):
            message=f'当前使用「{route["profile"]["name"]}」 · {route["model"]}'
        self.custom_api_state_label.setText(message if ok else '模型连接尚未生效：'+message)
        self.append_status(self.custom_api_state_label.text())
        return ok

    def _connection_ref(self,route):
        if not route:return None
        if route['provider']=='deepseek':
            profile={**self._legacy_api_fields(),'model_id':route['model']}
            key='@deepseek'
        else:
            profile=route.get('profile')
            key=self._profile_id(profile)
        if not profile:return None
        revision=profile.get('connection_revision')
        if not revision:
            salt=self._settings.value('api/legacy_binding_salt','')
            if not salt:
                salt=os.urandom(32).hex()
                self._settings.setValue('api/legacy_binding_salt',salt)
                self._settings.sync()
            revision=connection_revision(profile,salt)
        return {'id':key,'model':profile['model_id'],'revision':revision,'endpoint':profile['base_url']}

    def _prepare_request_route(self,packet):
        original=packet.get('api_connection')
        current=self._connection_ref(self._selected_api_route())
        if not original or original==current:
            return self._apply_pending_api()
        try:
            key=original['id']
            if key=='@deepseek' and deepseek_api_key():
                model=original['model']
                route={'provider':'deepseek','model':model,'context_window':None,
                       'vision':any(m['id']==model and m['vision'] for m in DEEPSEEK_MODELS)}
                if self._connection_ref(route)!=original:
                    raise ValueError('原连接的配置已变化')
                ok,message=self.manager.pi_set_model('deepseek',model)
            else:
                profile=load_api_connections().routed(key)
                route={'provider':CUSTOM_API_PROVIDER,'model':profile['model_id'],'profile':profile,
                       'context_window':profile['context_window'],'vision':profile['supports_vision']}
                if self._connection_ref(route)!=original:
                    raise ValueError('原连接的配置已变化')
                ok,message=self.manager.pi_configure_api(profile)
            if not ok:raise ValueError(message)
        except (KeyError,OSError,ValueError,TypeError):
            self.chat_display.show_system_notice('这条消息原先使用的连接已变化，请恢复原连接后重试。')
            return False
        self._set_api_runtime_route(route)
        self._api_config_pending=True
        return True

    def _on_api_url_edited(self,address):
        self.api_editor.address_edited(address)

    def _refresh_local_models(self):
        selected = self.model_combo.currentData()
        saved = self._settings.value("local/model_file", "")
        preferred = selected or saved
        models = self.manager.available_models()
        self.model_combo.blockSignals(True)
        self.model_combo.clear()
        selected_index = -1
        for index, item in enumerate(models):
            vision = " · 视觉" if item["supports_vision"] else ""
            label = f"{item['name']} · {item['size_gb']:.2f} GB{vision}"
            self.model_combo.addItem(label, item["filename"])
            if item["filename"] == preferred:
                selected_index = index
        if not models:
            self.model_combo.addItem("未找到 GGUF 模型", None)
        elif selected_index >= 0:
            self.model_combo.setCurrentIndex(selected_index)
        self.model_combo.blockSignals(False)
        self._on_local_model_change(self.model_combo.currentIndex())
        self.append_status(f"已发现 {len(models)} 个本地模型")

    def _on_local_model_change(self, _idx):
        model_file = self.model_combo.currentData()
        info = self.manager.model_info(model_file) if model_file else None
        if model_file:
            self._settings.setValue("local/model_file", model_file)
        supports_vision = bool(info and info["supports_vision"])
        if not supports_vision:
            self.vision_check.setChecked(False)
        self.vision_check.setToolTip(
            "启动时加载 mmproj；启动成功后可在消息框旁上传图片"
            if supports_vision else "所选模型没有可用的视觉投影文件")
        self._update_model_controls()

    def _update_model_controls(self):
        if not hasattr(self, "backend_combo"):
            return
        local_selected = self.backend_combo.currentData() == "local"
        running = self.manager.owns_server
        model_file = self.model_combo.currentData()
        info = self.manager.model_info(model_file) if model_file else None
        # 本地模型是独立的可管理服务，不应因为当前在使用 API 就锁死。
        editable = not running and not self._local_model_busy
        self.model_combo.setEnabled(editable)
        self.refresh_model_btn.setEnabled(editable)
        self.ctx_spin.setEnabled(editable)
        self.vision_check.setEnabled(
            editable and bool(info and info["supports_vision"]))
        self.start_btn.setEnabled(
            not self._local_model_busy and (running or bool(model_file)))
        self.start_btn.setText("停止本地" if running else "启动本地")
        self.api_provider_combo.setEnabled(not self._local_model_busy)
        self.api_model_combo.setEnabled(not self._local_model_busy)
        self.backend_combo.setEnabled(not self._local_model_busy)
        if hasattr(self, "attach_image_btn"):
            api_route = self._selected_api_route()
            local_vision = bool(
                local_selected and running and self.manager.use_vision)
            api_vision = bool(
                not local_selected and api_route and api_route["vision"])
            try:
                vision = stage_vision(load_inference(), 'light',
                    local_vision or api_vision, self._custom_api_profile,
                    running and self.manager.use_vision)
            except (OSError, ValueError, KeyError):
                vision = False
            self._attachment_vision = bool(vision)
            can_attach = not self._local_model_busy
            self.attach_image_btn.setEnabled(can_attach)
            self.attach_image_btn.setToolTip(
                "上传文件：图片、PDF、Office、文本或代码；图片需要视觉模型")
        self._refresh_header_model()

    def _refresh_header_model(self):
        """独立显示实际对话路由，不让瞬时状态文字冒充模型状态。"""
        if not hasattr(self, "active_model_label"):
            return
        local_active = (
            self.backend_combo.currentData() == "local"
            and self.manager.owns_server)
        if local_active:
            model_name = self.model_combo.currentText().split(" · ", 1)[0]
            self.active_model_label.setText(f"模型：{model_name}")
        else:
            route = self._selected_api_route()
            model_name = route['model'] if route else '未配置'
            self.active_model_label.setText(f'模型：{model_name}')
        self.active_model_label.setToolTip(model_name)
        if hasattr(self, "local_state_label"):
            if self._local_model_busy:
                state = "正在切换本地服务…"
            elif self.manager.owns_server:
                model_name = self.model_combo.currentText().split(" · ", 1)[0]
                route = "当前对话正在使用" if local_active else "后台运行，当前对话仍使用 API"
                state = f"本地服务：{model_name} · {route}"
            else:
                state = "本地服务：未启动"
            self.local_state_label.setText(state)
        self._sync_composer_labels()

    def _sync_composer_labels(self):
        if not hasattr(self, 'permission_menu_btn'):
            return
        model=self.active_model_label.text().removeprefix('模型：')
        mode='light'
        try: policy=current_policy()
        except (OSError,ValueError): policy={}
        label=TOOL_MODES.get(policy.get('mode'),'无权限')
        note='工具权限与工作目录可在设置中修改。'
        self.composer_surface.set_permission_label(label);self.permission_menu_btn.setToolTip(note)
        route=self._selected_api_route() or {};profile=route.get('profile') or {}
        key=(mode,model,route.get('context_window'),profile.get('base_url'),(getattr(self,'_current_session',None) or {}).get('id'))
        if key!=self._context_key:
            self._context_key=key;self._context_generation+=1;self.context_indicator.set_usage(None)
            self._request_context_usage()
        self._update_composer_actions()

    def _open_settings_section(self, title):
        title = {'对话':'角色与关系', '角色设定':'角色与关系', '语音':'语音与通话',
                 '聊天与语音':'语音与通话', '生成参数':'模型服务'}.get(title, title)
        self._switch_page(1)
        for i in range(self.settings_page.tabs.count()):
            if self.settings_page.tabs.tabText(i)==title:
                self.settings_page.tabs.setCurrentIndex(i);break

    def _show_permission_menu(self):
        menu=QMenu(self)
        try: policy=current_policy()
        except (OSError,ValueError): policy={}
        for key,label in TOOL_MODES.items():
            action=menu.addAction(label);action.setCheckable(True);action.setChecked(policy.get('mode','chat')==key)
            action.setEnabled(not getattr(self,'_chat_busy',False) and mode_available(policy,key))
            action.triggered.connect(lambda _checked,mode=key:self._choose_tool_mode(mode))
        menu.addSeparator();menu.addAction('工具权限设置…',lambda:self._open_settings_section('工具权限'))
        menu.exec(self.permission_menu_btn.mapToGlobal(QPoint(0,-menu.sizeHint().height())))

    def _choose_tool_mode(self, mode):
        if getattr(self,'_chat_busy',False):return
        settings=self.security_settings
        if settings.worker and settings.worker.isRunning():return
        try: policy=current_policy()
        except (OSError,ValueError):
            self.append_status('当前权限配置无法读取，未修改权限');return
        # Quick actions use the saved scope, never an unrelated unsaved draft
        # left in the settings page.
        if not mode_available(policy,mode):return
        root=policy.get('root','')
        if mode in {'workspace','read_only'} and not root:
            from PyQt6.QtWidgets import QFileDialog
            root=QFileDialog.getExistingDirectory(self,'选择允许访问的项目文件夹')
            if not root:return
        settings.select_mode(mode,root)

    def _request_context_usage(self):
        if self._closing or not hasattr(self,'context_indicator'):return
        session_id=(getattr(self,'_current_session',None) or {}).get('id')
        if not session_id or not self.manager.brain.is_compatible:return
        if self._context_thread is not None:
            self._context_pending=True;return
        self._context_pending=False
        worker=ContextUsageThread(self.manager.brain,session_id,'light',self._context_generation,self)
        self._context_thread=worker
        worker.result.connect(lambda data,owner=worker:self._context_usage_received(data,owner))
        worker.finished.connect(lambda owner=worker:self._context_usage_finished(owner))
        worker.start()
        if not self._context_timer.isActive():self._context_timer.start()

    def _context_usage_received(self,data,owner):
        if (self._closing or owner is not self._context_thread or owner.generation!=self._context_generation
            or owner.session_id!=(self._current_session or {}).get('id') or owner.mode!='light'):return
        if data.get('session_id')!=owner.session_id or data.get('mode')!=owner.mode or data.get('stale') or data.get('error'):
            self.context_indicator.set_usage(None);return
        self.context_indicator.set_usage(data)

    def _context_usage_finished(self,owner):
        if self._context_thread is owner:self._context_thread=None
        owner.deleteLater()
        if getattr(self,'_context_pending',False) and not self._closing:self._request_context_usage()

    def _show_context_usage(self):
        from PyQt6.QtWidgets import QToolTip
        QToolTip.showText(self.context_indicator.mapToGlobal(QPoint(0,-8)),self.context_indicator.toolTip(),self.context_indicator)

    def _update_composer_actions(self):
        if not hasattr(self,'composer_surface'):return
        text=bool(self.input_box.text().strip() or self._pending_files)
        busy=getattr(self,'_chat_busy',False) or self._waiting_for_backend
        calling=self._call_state not in {VoiceCallState.IDLE,VoiceCallState.FAILED}
        self.send_btn.setVisible(text and not busy)
        self.send_btn.setEnabled(text and not busy and not self._navigation_blocked and self._queued_asr is None and not self.dictation.active)
        self.voice_input_btn.setVisible(True)
        self.voice_input_btn.setEnabled(self._call_state!=VoiceCallState.DISCONNECTING and not self.dictation.active and not self._navigation_blocked)
        self.voice_input_btn.setText('')
        self.voice_input_btn.setIcon(composer_icon('phone'))
        reading = self._read_aloud_started_call and self._call_state in ACTIVE_CALL_STATES
        action = '进入语音通话' if reading else '开启回复朗读'
        self.voice_input_btn.setAccessibleName(action)
        self.call_action_label.setText(action)
        self.voice_input_btn.setToolTip('再次点击进入通话并打开麦克风' if reading else '先开启朗读，再次点击可通话')
        self.voice_input_btn.setProperty('readAloud', reading)
        self.voice_input_btn.style().unpolish(self.voice_input_btn)
        self.voice_input_btn.style().polish(self.voice_input_btn)
        self.audio_stop_btn.setVisible(reading or self._replay_active)
        self.voice_call_panel.stop_audio.setVisible(self.voice_call_panel.speaker.isChecked())
        self.cancel_native_btn.setVisible(busy)
        self.cancel_native_btn.setEnabled(busy)
        self.mic_toggle_btn.setText('')
        if not calling or reading:
            active=self.dictation.active
            self.mic_toggle_btn.setEnabled(self.dictation.state!='releasing' and self._asr_release_generation is None)
            self.mic_toggle_btn.setIcon(composer_icon('stop' if active else 'mic'))
            self.mic_toggle_btn.setToolTip({'loading':'正在准备听写；点击取消','finishing':'正在完成听写；再次点击取消',
                'releasing':'正在释放麦克风','release_failed':'重试释放语音资源'}.get(self.dictation.state,'结束听写' if active else '语音输入：转写到输入框后发送'))
            self.mic_action_label.setText('结束听写' if active else '听写')
        else:
            self.mic_toggle_btn.setIcon(composer_icon('mic' if self._call_state==VoiceCallState.CONNECTED else 'mic-off'))
        self.mic_toggle_btn.setProperty('recording',self.dictation.active or self._call_state==VoiceCallState.CONNECTED)
        self.mic_toggle_btn.setAccessibleName(self.mic_toggle_btn.toolTip())
        self.mic_toggle_btn.style().unpolish(self.mic_toggle_btn);self.mic_toggle_btn.style().polish(self.mic_toggle_btn)

    def _insert_dictation(self,text):
        # Append at the end without replacing typed text or pending attachments.
        cursor=self.input_box.textCursor();cursor.movePosition(cursor.MoveOperation.End)
        cursor.insertText((' ' if self.input_box.text().strip() else '')+text)
        self.input_box.setTextCursor(cursor)

    def _on_dictation_state(self,state):
        self._update_composer_actions()
        if hasattr(self,'asr_engine_combo'):
            idle=not self.dictation.active and self._call_state in {VoiceCallState.IDLE,VoiceCallState.FAILED}
            self.asr_engine_combo.setEnabled(idle);self.asr_lang_combo.setEnabled(idle)
        if state=='idle':
            self.input_box.setFocus()
            self._play_next_tts()

    def _set_local_model_busy(self, busy, message):
        self._local_model_busy = busy
        self.append_status(message)
        self._update_model_controls()

    def _on_local_model_result(self, result):
        import core.llama_manager as lm
        self._local_model_busy = False
        action = result.get("action")
        server_ok = bool(result.get("server_ok"))
        route_ok = bool(result.get("route_ok"))
        message = result.get("message", "本地模型操作完成")
        if action == "start" and server_ok:
            if route_ok:
                lm.BACKEND_MODE = "local"
                self.backend_combo.blockSignals(True)
                self.backend_combo.setCurrentIndex(
                    self.backend_combo.findData("local"))
                self.backend_combo.blockSignals(False)
                status = f"🟢 {message}"
            else:
                status = f"🟡 {message}"
        elif action == "stop" and server_ok:
            if self.backend_combo.currentData() == "local":
                self.backend_combo.setCurrentIndex(
                    self.backend_combo.findData("api"))
            status = f"⚪ {message}"
        else:
            status = f"⚠️ {message}"
        self._update_model_controls()
        self.append_status(status)

    def setup_ui(self):
        central = QWidget()
        self.setCentralWidget(central)
        outer = QHBoxLayout(central)
        outer.setContentsMargins(0, 0, 0, 0)
        outer.setSpacing(0)

        splitter = QSplitter(Qt.Orientation.Horizontal)
        splitter.setChildrenCollapsible(False)
        splitter.setHandleWidth(1)
        outer.addWidget(splitter)

        # ===== 左侧：会话与一级导航 =====
        sidebar = QVBoxLayout()
        sidebar.setContentsMargins(13,10,13,13)
        sidebar.setSpacing(10)
        self.sidebar_pages=QStackedWidget()
        self.sidebar_pages.setObjectName('sidebarPages')
        chat_sidebar=QWidget()
        self.chat_sidebar_layout=QVBoxLayout(chat_sidebar)
        self.chat_sidebar_layout.setContentsMargins(0,3,0,0)
        self.chat_sidebar_layout.setSpacing(8)
        self.sidebar_pages.addWidget(chat_sidebar)
        sidebar.addWidget(self.sidebar_pages,1)
        self.new_conv_btn = QPushButton("＋  新对话")
        self.new_conv_btn.setObjectName("primaryButton")
        self.new_conv_btn.clicked.connect(self.new_conversation)
        self.chat_sidebar_layout.addWidget(self.new_conv_btn)
        session_title = QLabel("最近对话")
        self.session_heading = session_title
        session_title.setObjectName("sectionLabel")
        self.chat_sidebar_layout.addWidget(session_title)
        self.session_list = QListWidget()
        self.session_list.setObjectName("sessionList")
        self.session_list.setItemDelegate(SidebarTitleDelegate(self.session_list))
        self.session_list.setTextElideMode(Qt.TextElideMode.ElideRight)
        self.session_list.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self.session_list.itemClicked.connect(self._on_session_click)
        self.session_list.setContextMenuPolicy(
            Qt.ContextMenuPolicy.CustomContextMenu)
        self.session_list.customContextMenuRequested.connect(
            self._show_session_context_menu)
        self.chat_sidebar_layout.addWidget(self.session_list, stretch=1)
        sidebar.addWidget(self._sidebar_separator())
        self.chat_nav_btn = QPushButton("对话")
        self.settings_nav_btn = QPushButton("设置")
        self.chat_nav_btn.setIcon(composer_icon('chat'))
        self.settings_nav_btn.setIcon(composer_icon('settings'))
        QShortcut(QKeySequence('Ctrl+,'),self).activated.connect(self.settings_nav_btn.click)
        self.settings_nav_btn.setToolTip('设置 (Ctrl+,)')
        self.diagnostics_nav_btn = None
        self._nav_buttons = [self.chat_nav_btn, self.settings_nav_btn]
        if self.development:
            self.diagnostics_nav_btn = QPushButton("异常样本")
            self._nav_buttons.append(self.diagnostics_nav_btn)
            self.diagnostics_nav_btn.clicked.connect(lambda: self._switch_page(2))
        for button in self._nav_buttons:
            button.setObjectName("navButton")
            button.setIconSize(QSize(18,18))
            button.setCheckable(True)
            sidebar.addWidget(button)
        self.chat_nav_btn.clicked.connect(lambda: self._switch_page(0))
        self.settings_nav_btn.clicked.connect(lambda: self._switch_page(1))
        sidebar_widget = QWidget()
        self.conversation_sidebar = sidebar_widget
        sidebar_widget.setObjectName("conversationSidebar")
        sidebar_widget.setLayout(sidebar)
        sidebar_widget.setMinimumWidth(160)
        sidebar_widget.setMaximumWidth(255)
        splitter.addWidget(sidebar_widget)

        self.page_stack = QStackedWidget()
        self.page_stack.setObjectName("pageStack")
        splitter.addWidget(self.page_stack)
        splitter.setStretchFactor(0, 0)
        splitter.setStretchFactor(1, 1)
        splitter.setSizes([212, 1188])
        self.sidebar_action = QAction(self)
        self.sidebar_action.setCheckable(True)
        self.sidebar_action.setChecked(self._setting_bool('appearance/sidebar_visible', True))
        self.sidebar_action.setShortcut(QKeySequence('Ctrl+B'))
        self.addAction(self.sidebar_action)
        self.sidebar_action.toggled.connect(self._set_sidebar_preference)

        # ===== 对话页 =====
        chat_page = QWidget()
        chat_page.setObjectName("chatPage")
        layout = QVBoxLayout(chat_page)
        layout.setContentsMargins(14, 10, 14, 12)
        layout.setSpacing(10)
        top = QHBoxLayout()
        self.chat_sidebar_toggle = SidebarToggle(self.sidebar_action)
        top.addWidget(self.chat_sidebar_toggle)
        self.chat_header = QHBoxLayout()
        self.chat_header.setSpacing(10)
        top.addLayout(self.chat_header)
        top.setContentsMargins(2,1,2,2)
        top.setSpacing(10)
        self.backend_combo = QComboBox()
        self.backend_combo.setObjectName("routeSelector")
        self.backend_combo.addItem("API 模型", "api")
        self.backend_combo.addItem("本地模型", "local")
        self.backend_combo.setParent(chat_page)
        self.backend_combo.hide()
        self.active_model_label = QLabel("模型：初始化中")
        self.active_model_label.setObjectName("modelChip")
        self.active_model_label.setParent(chat_page)
        self.active_model_label.hide()
        self.security_label = QLabel(security_badge())
        self.security_label.setToolTip('安全等级在设置页修改；完全权限不受项目目录限制。')
        self.security_label.hide()
        self.waveform_toggle_btn = SettingsSwitch('通话时显示头像与频谱')
        top.addStretch()
        self.status_label = QLabel("⚪ 未运行")
        self.status_label.setObjectName("statusPill")
        self.status_label.setToolTip("最近一次系统状态")
        self.status_label.setMaximumWidth(300)
        self.status_label.setMinimumWidth(0)
        top.addWidget(self.status_label)
        layout.addLayout(top)

        from ui.widgets import ChatScrollArea
        chat_container = QHBoxLayout()
        chat_container.setSpacing(14)
        self.chat_display = ChatScrollArea()
        self.chat_display.earlier_message.connect(self._add_history_message)
        self.chat_display.setAcceptDrops(True)
        self.chat_display.installEventFilter(self)
        self.chat_display.viewport().setAcceptDrops(True)
        self.chat_display.viewport().installEventFilter(self)
        self.chat_surface = FloatingChatSurface(self.chat_display)
        chat_container.addWidget(self.chat_surface, stretch=1)
        self.voice_call_panel = VoiceCallPage(self._settings, self._asuka_avatar, self._user_avatar,self._chat_bg)
        self.waveform = self.voice_call_panel.waveform
        self.panel_call_btn = self.voice_call_panel.hangup
        self.panel_call_btn.clicked.connect(self._panel_voice_call)
        self.call_language = self.voice_call_panel.language
        self.call_caption = self.voice_call_panel.caption
        self.voice_call_panel.microphone.clicked.connect(self.toggle_microphone)
        self.voice_call_panel.stop_audio.clicked.connect(self._stop_audio)

        self.mic_toggle_btn = QPushButton("麦克风")
        self.mic_toggle_btn.setObjectName("micCallButton")
        self.mic_toggle_btn.setFixedHeight(34)
        self.mic_toggle_btn.setEnabled(False)
        self.mic_toggle_btn.clicked.connect(self.toggle_microphone)
        self.mic_toggle_btn.setParent(chat_page)
        self.mic_action_label = QLabel("麦克风", chat_page)
        self.mic_action_label.setObjectName("callControlLabel")
        self.mic_action_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.mic_action_label.hide()
        self.voice_input_btn = QPushButton("拨号")
        self.voice_input_btn.setObjectName("phoneCallButton")
        self.voice_input_btn.setFixedHeight(34)
        self.voice_input_btn.clicked.connect(self._composer_phone)
        self.voice_input_btn.setParent(chat_page)
        self.audio_stop_btn = QPushButton()
        self.audio_stop_btn.setObjectName('stopAudioButton')
        self.audio_stop_btn.setAccessibleName('停止音频')
        self.audio_stop_btn.setToolTip('停止播放和待播语音，并关闭自动朗读')
        self.audio_stop_btn.setIcon(composer_icon('speaker-off'))
        self.audio_stop_btn.clicked.connect(self._stop_audio)
        self.call_action_label = QLabel("拨号", chat_page)
        self.call_action_label.setObjectName("callControlLabel")
        self.call_action_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.call_action_label.hide()
        layout.addLayout(chat_container, stretch=1)

        self.thinking_panel = None
        self.attach_image_btn = QPushButton("＋")
        self.attach_image_btn.setObjectName("compactButton")
        self.attach_image_btn.clicked.connect(self._select_chat_image)
        self.attachment_label = QLabel("")
        self.attachment_label.setMaximumWidth(150)
        self.attachment_label.setVisible(False)
        self.clear_attachment_btn = QPushButton("×")
        self.clear_attachment_btn.setFixedWidth(30)
        self.clear_attachment_btn.setToolTip("移除待发送文件")
        self.clear_attachment_btn.clicked.connect(self._remove_chat_file)
        self.clear_attachment_btn.setVisible(False)
        self.input_box = MessageComposer()
        # 文件拖放沿用附件流程，不能作为路径文字插入输入框。
        self.input_box.setAcceptDrops(True)
        self.input_box.installEventFilter(self)
        self.input_box.viewport().setAcceptDrops(True)
        self.input_box.viewport().installEventFilter(self)
        self.input_box.setPlaceholderText('在此输入文本')
        self.input_box.setToolTip('Enter 发送，Shift+Enter 换行')
        self.input_box.returnPressed.connect(self.send_message)
        self.send_btn = QPushButton("发送")
        self.send_btn.clicked.connect(self.send_message)
        self.send_btn.setToolTip('发送消息')
        self.cancel_native_btn = QPushButton("取消回复")
        self.cancel_native_btn.setEnabled(False)
        self.cancel_native_btn.clicked.connect(self._cancel_native_reply)
        self.cancel_native_btn.setToolTip('停止回复')
        self.permission_menu_btn = MenuButton('工具关闭')
        self.permission_menu_btn.clicked.connect(self._show_permission_menu)
        self.context_indicator = ContextIndicator()
        self.context_indicator.clicked.connect(self._show_context_usage)
        self.composer_surface = ComposerSurface(self.input_box,self.attach_image_btn,self.attachment_label,
            self.clear_attachment_btn,self.permission_menu_btn,self.context_indicator,
            self.mic_toggle_btn,self.send_btn,self.cancel_native_btn)
        self.chat_surface.set_composer(self.composer_surface, (self.voice_input_btn, self.audio_stop_btn))
        self.input_box.textChanged.connect(self._update_composer_actions)

        self.page_stack.addWidget(chat_page)

        # ===== 设置页 =====
        self.settings_page = SettingsPage(sidebar_action=self.sidebar_action)
        sidebar_settings=QWidget()
        categories=QVBoxLayout(sidebar_settings)
        categories.setContentsMargins(0,3,0,0)
        categories.setSpacing(8)
        category_label=QLabel('设置')
        category_label.setObjectName('sectionLabel')
        categories.addWidget(category_label)
        categories.addWidget(self.settings_page.navigation,1)
        self.sidebar_pages.addWidget(sidebar_settings)
        role_layout = self.settings_page.add_section('角色与关系','profile')
        voice_layout = self.settings_page.add_section('语音与通话','wave')
        self.role_settings=RoleSettingsCard(self.settings_page)
        self.role_settings.saved.connect(lambda:self.append_status('角色设定已保存'))
        role_layout.addWidget(self.role_settings)
        service_layout = self.settings_page.add_section("模型服务",'service')
        appearance_layout = self.settings_page.add_section("外观",'palette')
        security_layout = self.settings_page.add_section("工具权限",'shield')
        self.dialogue_settings=DialogueSettingsCard(self.settings_page)
        self.dialogue_settings.saved.connect(lambda _value:self.append_status('已保存新对话设定'))
        role_layout.addWidget(self.dialogue_settings)
        # The composer owns mode selection; don't repeat an otherwise empty tab.
        self.open_light_persona_btn = QPushButton('轻量模式提示词')
        self.open_light_persona_btn.setObjectName('configFileLink')
        self.open_light_persona_btn.setToolTip('打开轻量模式的提示词底稿。本轮还会使用「角色设定」里保存的内容及相关回忆。')
        self.open_character_memory_btn = QPushButton('内置角色记忆')
        self.open_character_memory_btn.setObjectName('configFileLink')
        memory_root=Path(os.environ.get('ASUKA_CHARACTER_MEMORY_ROOT') or PROJECT_ROOT/'brain/personality/character-memory')
        self.open_character_memory_btn.clicked.connect(lambda:self._open_personality_file(str(memory_root/'CURRENT.md')))
        self.open_light_persona_btn.clicked.connect(self._open_light_personality_file)

        appearance_card = SettingsCard("配色与背景")
        appearance_form = settings_form()
        self.theme_combo = QComboBox()
        self.theme_combo.setObjectName('appearanceTheme')
        self.theme_combo.setAccessibleName('整体配色')
        self.theme_combo.setToolTip('立即应用并记住选择')
        for key, name in THEME_NAMES.items():
            self.theme_combo.addItem(name, key)
        self.theme_combo.setCurrentIndex(self.theme_combo.findData(self._theme_id))
        self.theme_combo.currentIndexChanged.connect(self._on_theme_changed)
        self.theme_combo.setMaximumWidth(300)
        appearance_form.addRow('整体配色',self.theme_combo)
        avatar_row = QHBoxLayout()
        self.import_avatar_btn = QPushButton("更换明日香头像")
        self.import_avatar_btn.clicked.connect(self.import_avatar)
        avatar_row.addWidget(self.import_avatar_btn)
        self.import_user_avatar_btn = QPushButton("更换我的头像")
        self.import_user_avatar_btn.clicked.connect(self.import_user_avatar)
        avatar_row.addWidget(self.import_user_avatar_btn)
        self.import_bg_btn = QPushButton("更换聊天背景")
        self.import_bg_btn.clicked.connect(self.import_background)
        avatar_row.addStretch()
        appearance_form.addRow('聊天头像',avatar_row)
        background_row=QHBoxLayout()
        background_row.addWidget(self.import_bg_btn);background_row.addStretch()
        appearance_form.addRow('背景图片',background_row)
        self.bg_opacity_label = QLabel(
            f"背景可见度  {self._background_opacity}%")
        self.bg_opacity_slider = QSlider(Qt.Orientation.Horizontal)
        self.bg_opacity_slider.setObjectName("backgroundOpacitySlider")
        self.bg_opacity_slider.setRange(10, 100)
        self.bg_opacity_slider.setValue(self._background_opacity)
        self.bg_opacity_slider.setToolTip("调节聊天背景图片的不透明度")
        self.bg_opacity_slider.setAccessibleName('背景可见度')
        self.bg_opacity_label.setBuddy(self.bg_opacity_slider)
        appearance_form.addRow(self.bg_opacity_label,self.bg_opacity_slider)
        appearance_card.content.addLayout(appearance_form)
        appearance_card.content.addWidget(self.waveform_toggle_btn)
        appearance_layout.addWidget(appearance_card)

        model_card = SettingsCard(
            "对话服务", "选择 API 服务与模型。当前使用的服务和模型显示在对话页顶部。")
        source_row = QHBoxLayout()
        source_row.addWidget(QLabel('模型来源'))
        source_row.addWidget(self.backend_combo)
        source_row.addStretch()
        model_card.content.addLayout(source_row)
        self.backend_combo.show()
        api_row = QHBoxLayout()
        api_row.addWidget(QLabel("API 服务"))
        self.api_provider_combo = QComboBox()
        self.api_provider_combo.addItem("待配置", "none")
        self.api_provider_combo.addItem("DeepSeek", "deepseek")
        self.api_provider_combo.addItem("自定义 API", CUSTOM_API_PROVIDER)
        api_row.addWidget(self.api_provider_combo)
        api_row.addWidget(QLabel("对话模型"))
        self.api_model_combo = QComboBox()
        self.api_model_combo.setMinimumWidth(260)
        api_row.addWidget(self.api_model_combo)
        api_row.addStretch()
        model_card.content.addLayout(api_row)
        self.inference_settings = InferenceSettings(phases=('light',))
        self.inference_settings.saved.connect(self._update_model_controls)
        self.request_config_link = QPushButton('定位当前模式请求配置文件')
        self.request_config_link.setFlat(True)
        self.request_config_link.setObjectName('configFileLink')
        self.request_config_link.clicked.connect(lambda: self._reveal_config('request'))
        self.security_settings = SecuritySettings()
        self.security_settings.policy_changed.connect(lambda _p:self.security_label.setText(security_badge()))
        self.security_settings.policy_changed.connect(lambda _p:self._sync_composer_labels())
        self.security_settings.policy_error.connect(lambda text:self.append_status('权限未更改：'+text))
        security_card = SettingsCard("本地工具权限", "控制文件与命令访问。模型内置搜索在模型服务的请求配置中单独设置。")
        security_card.content.addWidget(self.security_settings)
        security_layout.addWidget(security_card)
        model_card.setParent(self.settings_page)
        model_card.hide()

        custom_api_card = SettingsCard('模型连接', '选择已存连接即可切换；新连接在保存后启用。')
        saved_row = QHBoxLayout()
        self.saved_api_combo = QComboBox()
        self.saved_api_combo.setAccessibleName('已保存的 API 连接')
        self.saved_api_combo.setMinimumContentsLength(13)
        self.new_api_button = QPushButton('新建连接')
        self.remove_api_button = QPushButton('移除')
        saved_row.addWidget(QLabel('已保存连接'))
        saved_row.addWidget(self.saved_api_combo,1)
        saved_row.addWidget(self.new_api_button)
        saved_row.addWidget(self.remove_api_button)
        custom_api_card.content.addLayout(saved_row)
        self.api_editor = ApiConnectionFields(custom_api_card)
        custom_api_card.content.addWidget(self.api_editor)
        self.custom_api_name_edit = self.api_editor.name
        self.custom_api_url_edit = self.api_editor.address
        self.custom_api_key_edit = self.api_editor.key
        self.custom_api_model_edit = self.api_editor.model
        self.custom_api_protocol_combo = self.api_editor.protocol
        self.custom_api_context_spin = self.api_editor.context
        self.custom_api_max_tokens_spin = self.api_editor.max_output
        self.custom_api_vision_check = self.api_editor.vision
        self.custom_api_reasoning_check = self.api_editor.reasoning
        self.api_advanced_panel = self.api_editor.advanced_panel
        self.api_advanced_btn = self.api_editor.advanced_button
        self.save_custom_api_btn = QPushButton('保存并启用')
        self.save_custom_api_btn.setObjectName('primaryButton')
        self.custom_api_state_label = QLabel(
            '密钥仅保存到本机配置。')
        self.custom_api_state_label.setObjectName("mutedLabel")
        self.custom_api_state_label.setWordWrap(True)
        self.connection_config_link = QPushButton('定位连接配置文件')
        self.connection_config_link.setFlat(True)
        self.connection_config_link.setObjectName('configFileLink')
        self.connection_config_link.setToolTip(str(LOCAL_CONFIG_PATH))
        self.connection_config_link.clicked.connect(lambda: self._reveal_config('connection'))
        api_actions=QHBoxLayout()
        api_actions.addWidget(self.custom_api_state_label,1)
        api_actions.addWidget(self.connection_config_link)
        api_actions.addWidget(self.save_custom_api_btn)
        custom_api_card.content.addLayout(api_actions)
        service_layout.addWidget(custom_api_card)
        generation_card = SettingsCard('生成参数',collapsible=True)
        generation_card.content.addWidget(self.inference_settings)
        self.request_guide_link = QPushButton('高级请求配置说明')
        self.request_guide_link.setObjectName('configFileLink')
        self.request_guide_link.clicked.connect(lambda: self._open_personality_file(
            str(PROJECT_ROOT / 'client' / 'REQUEST_SETTINGS.md')))
        generation_card.add_resource_menu('配置与说明',(self.request_config_link,self.request_guide_link))
        service_layout.addWidget(generation_card)
        self.role_settings.add_resource_menu('角色资料',(self.open_light_persona_btn,self.open_character_memory_btn,
                                                       self.role_settings.locate))
        # Historical controller retained for existing tools only: not in Settings,
        # and not scanned on startup. Ordinary local models use the same API form.
        local_card = SettingsCard("本地模型", "扫描并启动本机 GGUF 模型；启动成功后切换到本地对话。")
        self.local_state_label = QLabel("本地服务：未启动")
        self.local_state_label.setObjectName("mutedLabel")
        local_card.content.addWidget(self.local_state_label)
        model_row = QHBoxLayout()
        model_row.addWidget(QLabel("GGUF 模型"))
        self.model_combo = QComboBox()
        self.model_combo.setMinimumWidth(360)
        model_row.addWidget(self.model_combo, stretch=1)
        self.refresh_model_btn = QPushButton("重新扫描")
        self.refresh_model_btn.setToolTip("重新扫描模型目录中的 GGUF 文件")
        model_row.addWidget(self.refresh_model_btn)
        local_card.content.addLayout(model_row)
        local_options = QHBoxLayout()
        local_options.addWidget(QLabel("上下文"))
        self.ctx_spin = QSpinBox()
        self.ctx_spin.setRange(4096, 131072)
        self.ctx_spin.setSingleStep(4096)
        local_options.addWidget(self.ctx_spin)
        self.vision_check = QCheckBox("加载视觉投影")
        local_options.addWidget(self.vision_check)
        local_options.addStretch()
        self.start_btn = QPushButton("启动本地")
        self.start_btn.setObjectName("primaryButton")
        local_options.addWidget(self.start_btn)
        local_card.content.addLayout(local_options)
        local_card.setParent(self.settings_page)
        local_card.hide()

        voice_card = SettingsCard('回复朗读')
        voice_call_hint = QLabel(
            '开启后准备语音线路，朗读接下来的回复；麦克风仍默认关闭。')
        voice_call_hint.setObjectName("mutedLabel")
        voice_call_hint.setWordWrap(True)
        voice_card.content.addWidget(voice_call_hint)
        read_row = QHBoxLayout()
        self.settings_read_aloud_btn = QPushButton('开启朗读')
        self.settings_read_aloud_btn.clicked.connect(self._toggle_read_aloud)
        self.settings_read_aloud_btn.setObjectName('primaryButton')
        read_row.addWidget(self.settings_read_aloud_btn)
        self.voice_state_label = QLabel()
        self.voice_state_label.setObjectName('mutedLabel')
        read_row.addWidget(self.voice_state_label)
        read_row.addStretch()
        voice_card.content.addLayout(read_row)
        self.voice_reveal_check = SettingsSwitch('朗读时逐字显示消息')
        self.voice_reveal_check.setChecked(self._setting_bool('voice/progressive_text', True))
        self.voice_reveal_check.toggled.connect(self._change_voice_reveal)
        voice_card.content.addWidget(self.voice_reveal_check)
        self.immediate_speech_check = SettingsSwitch('允许自然续话')
        self.immediate_speech_check.setToolTip('有自然的下文时，会用当前模型连接准备一句。关闭后，每轮仍可朗读原来的回复。')
        self.immediate_speech_check.setChecked(self._setting_bool('voice/immediate_followup',True))
        self.immediate_speech_check.toggled.connect(self._change_immediate_followup)
        voice_card.content.addWidget(self.immediate_speech_check)
        self.immediate_speech_check.setVisible(bool(os.environ.get('ASUKA_RELATIONSHIP_DIR')))
        self.voice_check = QCheckBox('语音线路接通后朗读回复')
        self.voice_call_panel.speaker.toggled.connect(self.voice_check.setChecked)
        self.voice_check.toggled.connect(self.voice_call_panel.speaker.setChecked)
        self.voice_check.setToolTip('关闭可静音；挂断会同时释放语音资源。')
        voice_card.content.addWidget(self.voice_check)

        voice_settings_panel = QFrame()
        voice_settings_panel.setObjectName("voiceSettingsPanel")
        voice_settings_layout = settings_form(voice_settings_panel)
        self.asr_engine_combo = QComboBox()
        for provider in self.asr.provider_options():
            self.asr_engine_combo.addItem(
                provider.label, provider.provider_id)
            index = self.asr_engine_combo.count() - 1
            self.asr_engine_combo.setItemData(
                index, provider.resource_hint, Qt.ItemDataRole.ToolTipRole)
        self.asr_engine_combo.setMaximumWidth(400)
        self.asr_engine_combo.setToolTip(
            "切换本地语音识别模型；通话期间不可更改。")
        voice_settings_layout.addRow('语音识别模型',self.asr_engine_combo)

        self.asr_lang_label = QLabel("识别语言")
        self.asr_lang_combo = QComboBox()
        self.asr_lang_combo.addItem("中文", "zh")
        self.asr_lang_combo.addItem("日文", "ja")
        self.asr_lang_combo.addItem("英文", "en")
        self.asr_lang_combo.addItem("混合/自动", "mixed")
        self.asr_lang_combo.setMaximumWidth(400)
        self.asr_lang_combo.setToolTip(
            "短句建议明确选择语言；自动检测容易把中文、日文或英文短句判错")
        self.asr_lang_label.setBuddy(self.asr_lang_combo)
        voice_settings_layout.addRow(self.asr_lang_label,self.asr_lang_combo)
        self.audio_replay_check = SettingsSwitch('保存语音，点头像回放')
        self.audio_replay_check.setToolTip('保存原声学编码和生成条件，最近10条音频保留快速缓存。关闭后停止新增保存和回放，已有数据保留。')
        self.audio_replay_check.setChecked(self._setting_bool('voice/message_replay', True))
        self.tts.audio_replay.enabled = self.audio_replay_check.isChecked()
        self.audio_replay_check.toggled.connect(self._toggle_audio_replay)
        replay_card = SettingsCard('消息语音回放')
        replay_card.content.addWidget(self.audio_replay_check)

        temp_row = QHBoxLayout()
        temp_row.addWidget(QLabel('基础声线采样温度'))
        self.temp_slider = QSlider(Qt.Orientation.Horizontal)
        self.temp_slider.setRange(10, 100)
        temp_row.addWidget(self.temp_slider, stretch=1)
        self.temp_label = QLabel("0.9")
        temp_row.addWidget(self.temp_label)
        self.legacy_voice_parameters = QWidget()
        self.legacy_voice_parameters.setLayout(temp_row)
        voice_card.content.addWidget(self.legacy_voice_parameters)
        recognition_card = SettingsCard('语音输入')
        recognition_card.content.addWidget(voice_settings_panel)
        voice_layout.addWidget(voice_card)
        voice_layout.addWidget(recognition_card)
        voice_layout.addWidget(replay_card)
        self.page_stack.addWidget(self.settings_page)

        # ===== 异常中心 =====
        self.diagnostics_page = None
        if self.development:
            self.diagnostics_page = DiagnosticsPage(REPORTS_DIR)
            self.diagnostics_page.pending_count_changed.connect(
                self._update_diagnostics_badge)
            self.page_stack.addWidget(self.diagnostics_page)
        self.page_stack.addWidget(self.voice_call_panel)

        # 恢复低频设置后再接信号，避免启动时触发路由切换。
        saved_provider = saved_api_provider(self._settings.value('api/provider'),self._custom_api_profile)
        saved_mode = str(self._settings.value('personality/mode', 'general_auto'))
        previous_active_model = ('deepseek-v4-flash' if saved_mode in QUALITY_MODES or saved_mode not in {'light'}
                                 else str(self._settings.value('api/deepseek_model', 'deepseek-v4-pro')))
        original_model = str(self._settings.value('api/shared_model', previous_active_model))
        # Preserve the current route on first migration; later mode switches or
        # restarts must not silently restore a different mode-specific model.
        if saved_provider=='deepseek':self._settings.setValue('api/shared_model', original_model)
        if saved_provider == CUSTOM_API_PROVIDER:
            profile = self._custom_api_profile
        elif saved_provider == 'deepseek':
            profile = {'name':'DeepSeek','base_url':'https://api.deepseek.com','api_key':deepseek_api_key(),
                       'model_id':original_model,'api_type':'openai-completions','supports_vision':True,
                       'supports_reasoning':True,'context_window':1000000,'max_tokens':196608}
        else:
            profile = {'name':'','base_url':'','api_key':'','model_id':'','api_type':'openai-completions',
                       'supports_vision':False,'supports_reasoning':False,'context_window':128000,'max_tokens':8192}
        self._editing_api_id = (self._profile_id(self._custom_api_profile) if saved_provider == CUSTOM_API_PROVIDER
                                else '@deepseek' if saved_provider == 'deepseek' else None)
        self._refresh_api_picker()
        self.api_editor.load(profile)
        self.saved_api_combo.activated.connect(self._select_saved_api)
        self.new_api_button.clicked.connect(self._new_api_connection)
        self.remove_api_button.clicked.connect(self._remove_api_connection)
        previous_mode=self._settings.value('personality/mode','light')
        if previous_mode!='light':
            self._settings.setValue('personality/previous_mode',previous_mode)
            self._settings.setValue('personality/mode','light')
        provider_index = self.api_provider_combo.findData(saved_provider)
        self.api_provider_combo.setCurrentIndex(max(0, provider_index))
        legacy_model = original_model
        self._populate_api_models(saved_provider, preferred=legacy_model)
        self.ctx_spin.setValue(int(self._settings.value(
            "local/context_size", 65536)))
        self.vision_check.setChecked(self._setting_bool(
            "local/use_vision", False))
        self.voice_check.setChecked(self._setting_bool(
            "voice/call_speaker_enabled", True))
        # 启动和普通文字聊天都不建立通话，也不加载语音模型。
        self.tts.set_enabled(False)
        # Every launch starts as a plain chat page, regardless of older layout settings.
        self.waveform_toggle_btn.setChecked(self._setting_bool('voice/show_call_avatar',True))
        self.temp_slider.setValue(int(self._settings.value(
            "voice/temperature", 90)))
        asr_engine = str(self._settings.value(
            "voice/asr_engine", self.asr.default_engine))
        engine_index = self.asr_engine_combo.findData(asr_engine)
        self.asr_engine_combo.setCurrentIndex(max(0, engine_index))
        asr_language = str(self._settings.value("voice/asr_language", "zh"))
        if asr_language == "auto":
            asr_language = "mixed"
        asr_index = self.asr_lang_combo.findData(asr_language)
        self.asr_lang_combo.setCurrentIndex(max(0, asr_index))

        self.backend_combo.currentIndexChanged.connect(self._on_backend_change)
        self.api_provider_combo.currentIndexChanged.connect(
            self._on_api_provider_change)
        self.api_model_combo.currentIndexChanged.connect(
            self._on_api_model_change)
        self.save_custom_api_btn.clicked.connect(self._save_custom_api)
        self.model_combo.currentIndexChanged.connect(
            self._on_local_model_change)
        self.refresh_model_btn.clicked.connect(self._refresh_local_models)
        self.start_btn.clicked.connect(self.toggle_server)
        self.ctx_spin.valueChanged.connect(
            lambda value: self._settings.setValue(
                "local/context_size", value))
        self.vision_check.toggled.connect(
            lambda checked: self._settings.setValue(
                "local/use_vision", checked))
        self.voice_check.toggled.connect(self._sync_speaker_control)
        self.waveform_toggle_btn.toggled.connect(self._toggle_waveform)
        self.temp_slider.valueChanged.connect(self.on_temp_change)
        self.asr_lang_combo.currentIndexChanged.connect(
            self._on_asr_lang_change)
        self.asr_engine_combo.currentIndexChanged.connect(
            self._on_asr_engine_change)
        self.bg_opacity_slider.valueChanged.connect(
            self.on_background_opacity_change)

        self.on_temp_change(self.temp_slider.value())
        self._configure_reply_controls()
        self._on_asr_lang_change(self.asr_lang_combo.currentIndex())
        self._on_asr_engine_change(self.asr_engine_combo.currentIndex())
        self._toggle_waveform(self.waveform_toggle_btn.isChecked())
        self._set_call_state(VoiceCallState.IDLE)
        self._set_api_runtime_route()
        self._update_model_controls()
        if self.diagnostics_page is not None:
            self.diagnostics_page.refresh()
        self._switch_page(0)

    @staticmethod
    def _sidebar_separator():
        separator = QFrame()
        separator.setObjectName("sidebarSeparator")
        separator.setFrameShape(QFrame.Shape.HLine)
        return separator

    def _setting_bool(self, key, default=False):
        value = self._settings.value(key, default)
        if isinstance(value, bool):
            return value
        return str(value).strip().lower() in {"1", "true", "yes", "on"}

    def _personality_options(self):
        live=self._call_audio is not None and self._call_state in ACTIVE_CALL_STATES
        reading=self._call_state in ACTIVE_CALL_STATES and (self.voice_check.isChecked() or live)
        return {'personality_mode':'light','personality_state_scope':'conversation','voice_enabled':reading,
                **({'call_language':self.call_language.currentData()} if live else {}),
                **({'voice_turn':SINGLE_VOICE} if reading else {}),
                'voice_preset':'natural' if quality_config_path().is_file() else None}

    def _configure_reply_controls(self):
        has_voice=quality_config_path().is_file()
        self.legacy_voice_parameters.setVisible(not has_voice)
        self.tts.configure_quality(has_voice)
        self.cancel_native_btn.hide()
        self._set_api_runtime_route()
        self._update_model_controls()

    def _begin_reply_feedback(self):
        self.cancel_native_btn.setVisible(True)
        self.cancel_native_btn.setEnabled(True)
        self.thinking_panel=None
        self.chat_display.clear_typing()
        self.status_label.clear()
        self.status_label.hide()

    def _finish_reply_feedback(self, succeeded=True):
        self.cancel_native_btn.setEnabled(False)
        self.cancel_native_btn.hide()
        self.chat_display.clear_typing()
        if self.thinking_panel:
            self.thinking_panel.finish(succeeded)
            if self.chat_display.discard_thinking(self.thinking_panel):
                self.thinking_panel = None

    def _on_chat_progress(self, data, owner):
        if owner is not getattr(self, '_chat_thread', None) or owner.cancel_requested or not getattr(self, '_chat_busy', False):
            return
        complete = data.get('analysis_complete') is True
        if complete:
            self._mark_user_read()
            if owner.request_packet and not owner.request_packet.get('analysis_complete'):
                owner.request_packet['analysis_complete']=True
                try:self._pending_store.save(owner.request_packet)
                except (OSError,ValueError):pass
        if getattr(owner,'call_language',None):
            if self.voice_call_panel.active and self._call_voice_valid(owner) and data.get('stage')=='retrying':
                self.voice_call_panel.status.setText('正在重新连接…')
            return
        if data.get('stage')=='retrying':self.chat_display.show_system_notice('连接有点慢，正在恢复…')
        elif not getattr(self,'_reply_failure',False):self.chat_display.clear_system_notice()
        if data.get('stage') in {'failed','cancelled'}:
            self.chat_display.clear_typing()
        elif (complete or getattr(self._chat_user_row,'_read',False)) and not getattr(self,'_reply_received',False):
            self.chat_display.show_typing()

    def _mark_user_read(self):
        from PyQt6 import sip
        row=self._chat_user_row
        if row is not None and not sip.isdeleted(row):row.set_read(True)

    def _cancel_native_reply(self, *, interrupted=False):
        if self.immediate_followup: self.immediate_followup.cancel('user_speech' if interrupted else 'stop_reply')
        self._finish_message_delivery()
        self._pending_tts=False
        self._tts_queue.clear()
        if self._call_audio:
            self._call_audio.finish(self._call_audio.target)
            self.voice_call_panel.clear_caption()
            playing=getattr(self,'speak_thread',None)
            if getattr(playing,'call_stop',None) is not None:playing.call_stop.set()
        if interrupted:
            self.tts.request_stop()
            if not self._chat_busy and not self._waiting_for_backend:return
        else:
            self.tts.stop()
        if self._waiting_for_backend:
            self._waiting_for_backend=False
            if self._failed_packet:
                self._failed_packet['cancelled']=True
                try:self._pending_store.save(self._failed_packet)
                except (OSError,ValueError):pass
            self.chat_display.show_system_notice('已停止，输入已保留。',on_retry=self._retry_failed_reply)
            self._update_composer_actions();return
        owner=getattr(self,'_chat_thread',None)
        if owner:
            if interrupted: owner.call_interrupted=True
            owner.cancel_requested=True
            owner.cancel_event.set()
            if owner.request_packet:
                owner.request_packet['cancelled']=True
                try:self._pending_store.save(owner.request_packet)
                except (OSError,ValueError):pass
        self._cancel_request_in_background(owner)

    def _cancel_request_in_background(self,owner):
        if owner is None or not owner.request_id:return
        if any(w.request_id==owner.request_id for w in self._cancel_workers):return
        packet=getattr(owner,'request_packet',None)
        lookup=(lambda:owner._lookup_packet(packet)) if packet else None
        worker=CancelReply(self.manager.brain,owner.request_id,owner.session_id,self,lookup)
        self._cancel_workers.add(worker)
        worker.finished.connect(lambda:self._cancel_completed(worker,owner))
        worker.start()

    def _cancel_completed(self,worker,owner):
        self._cancel_workers.discard(worker)
        worker.deleteLater()
        if self._closing or owner is not self._chat_thread:return
        if worker.failure:
            record_failure(failure_from_exception(worker.failure),stage='cancel')
            self.append_status('正在确认停止，消息已保留。')
        elif worker.saved and worker.saved.get('reply_saved') and worker.saved.get('speech'):
            if owner.session_id!=(self._current_session or {}).get('id'):return
            from ui.widgets import ChatMessageRow
            exists=any(not r.is_user and getattr(r,'request_id',None)==owner.request_id for r in self.chat_display.widget().findChildren(ChatMessageRow))
            owner.saved_after_stop=True
            matching_group = not self.relationship_view or self.relationship_view.accepts(owner.request_packet or {})
            if not exists and matching_group and not getattr(owner,'call_language',None):
                self.show_reply(worker.saved['speech'],worker.saved.get('translation',''),data=worker.saved,voice_expected=False)
                self._last_reply_row.request_id=owner.request_id
            self._acknowledge_delivery(worker.saved.get('quality_receipt'))
            self.chat_display.clear_system_notice()
            try:self._pending_store.clear(owner.session_id,owner.request_id)
            except (OSError,ValueError) as error:record_failure(failure_from_exception(error),stage='pending-clear')
            if getattr(self,'_failed_packet',None) and self._failed_packet.get('request_id')==owner.request_id:
                self._failed_chat=None;self._failed_packet=None;self._failed_problem={}
        elif worker.outcome.get('cancelled'):self.append_status('已请求停止当前回复，消息内容已保留。')

    def _native_chat_pending(self):
        return bool(getattr(self,'_chat_busy',False))

    def _open_light_personality_file(self):
        try:
            from core import personality_library as library
            selected=library.selection().get('light')
            path=library.LIBRARY/(selected+'.json') if selected else PROJECT_ROOT/'brain/personality/default-light-prompt.md'
            self._open_personality_file(str(path))
        except (OSError,ValueError) as error:self.append_status('无法定位提示词：'+str(error))

    def _open_personality_file(self, path):
        if not os.path.isfile(path):
            self.append_status(f"⚠️ 人格文件不存在: {path}")
            return
        if not QDesktopServices.openUrl(QUrl.fromLocalFile(path)):
            self.append_status(f"⚠️ 无法打开人格文件: {path}")

    def _request_config_file(self):
        return Path(INFERENCE_CONFIG_PATH)

    def _reveal_config(self, kind):
        try:
            target = LOCAL_CONFIG_PATH if kind == 'connection' else self._request_config_file()
            if kind == 'request' and not target.is_file():
                save_inference(load_inference(), path=target)
                self.request_config_link.setText('定位请求配置文件')
            reveal_configuration(target)
        except (OSError, ValueError, KeyError) as error:
            self.append_status(str(error))

    def _set_sidebar_preference(self, visible):
        self._settings.setValue('appearance/sidebar_visible', visible)
        self._sync_sidebar()

    def _sync_sidebar(self):
        visible = self.sidebar_action.isChecked()
        in_call = self.voice_call_panel.active
        has_control = self.page_stack.currentIndex() in (0, 1)
        self.conversation_sidebar.setVisible(not in_call and (visible or not has_control))
        self.sidebar_action.setEnabled(has_control and not in_call)
        label = '收起侧栏' if visible else '展开侧栏'
        self.sidebar_action.setText(label)
        self.sidebar_action.setToolTip(label + ' (Ctrl+B)')
        self.sidebar_action.setIcon(composer_icon('sidebar-hide' if visible else 'sidebar-show', colors()['muted']))

    def _switch_page(self, index):
        if self.voice_call_panel.active:
            return
        if not 0 <= index < len(self._nav_buttons):
            return
        self.page_stack.setCurrentIndex(index)
        self.sidebar_pages.setCurrentIndex(1 if index==1 else 0)
        self._sync_sidebar()
        for button_index, button in enumerate(self._nav_buttons):
            button.setChecked(button_index == index)
        if index==1:
            target = self.settings_page.navigation if self.sidebar_action.isChecked() else self.settings_page.sidebar_toggle
            target.setFocus(Qt.FocusReason.OtherFocusReason)
        if index == 2:
            self.diagnostics_page.refresh()

    def _sync_speaker_control(self, checked):
        """角色语音只是通话内扬声器偏好，不再独立管理 TTS 生命周期。"""
        enabled = bool(checked)
        if not enabled and self.immediate_followup: self.immediate_followup.cancel('stop_audio')
        if self._call_audio is not None:
            self._settings.setValue("voice/call_speaker_enabled", enabled)
        if not enabled:
            self._record_call_interruption('stop_audio')
            self.voice_call_panel.finish_caption()
            if self._call_audio and not self._chat_busy:self._call_audio.finish(self._call_audio.target)
            player=getattr(self,'speak_thread',None)
            if getattr(player,'call_stop',None) is not None:player.call_stop.set()
            self._finish_message_delivery()
            self._pending_tts = False
            self._tts_queue.clear()
            self.tts.stop()
        else:
            self._play_next_tts()
        self._sync_read_aloud_buttons()
        self._update_composer_actions()

    def _composer_phone(self):
        if self._call_state in {VoiceCallState.IDLE, VoiceCallState.FAILED}:
            self._toggle_read_aloud()
        elif self._read_aloud_started_call:
            self._panel_voice_call()

    def _stop_audio(self):
        if self.immediate_followup: self.immediate_followup.cancel('stop_audio')
        if self._call_audio is not None:
            self.voice_check.setChecked(False)
        elif self._read_aloud_started_call:
            self._hang_up_voice_call()
        else:
            player = getattr(self, 'speak_thread', None)
            if getattr(player, 'call_stop', None) is not None:
                player.call_stop.set()
            self._finish_message_delivery()
            self._pending_tts = False
            self._tts_queue.clear()
            self.tts.request_stop()

    def _change_voice_reveal(self, enabled):
        self._settings.setValue('voice/progressive_text', enabled)
        if not enabled:
            self._reveal_timer.stop()
            self.chat_display.finish_deliveries()

    def _change_immediate_followup(self, enabled):
        self._settings.setValue('voice/immediate_followup',bool(enabled))
        if not enabled and self.immediate_followup: self.immediate_followup.cancel('disabled')

    def _toggle_read_aloud(self):
        state = self._call_state
        if state == VoiceCallState.DISCONNECTING:
            return
        if state == VoiceCallState.DIALING:
            if self._read_aloud_started_call:
                self._hang_up_voice_call()
            return
        if state in ACTIVE_CALL_STATES:
            if self.voice_check.isChecked():
                if self._read_aloud_started_call and state == VoiceCallState.MUTED:
                    self._hang_up_voice_call()
                else:
                    self.voice_check.setChecked(False)
            else:
                self.voice_check.setChecked(True)
            return
        if self.dictation.active:
            self.append_status('请先结束听写，再开启朗读')
            return
        self.voice_check.setChecked(True)
        self._read_aloud_started_call = True
        self._dial_voice_call()

    def _sync_read_aloud_buttons(self):
        if not hasattr(self, 'settings_read_aloud_btn'):
            return
        state = self._call_state
        active = state in ACTIVE_CALL_STATES and self.voice_check.isChecked()
        self.voice_check.setVisible(state in ACTIVE_CALL_STATES and not self._read_aloud_started_call)
        text = '停止朗读' if active else '开启朗读'
        enabled = state != VoiceCallState.DISCONNECTING
        if state == VoiceCallState.DIALING:
            text = '取消朗读' if self._read_aloud_started_call else '正在准备语音'
            enabled = self._read_aloud_started_call
        elif state == VoiceCallState.DISCONNECTING:
            text = '正在释放语音'
        for button in (self.settings_read_aloud_btn,):
            button.setText(text)
            button.setEnabled(enabled)
            button.setToolTip('从接下来的回复开始朗读；开启不会打开麦克风。')
        self.voice_state_label.setText('朗读已开启' if active and state != VoiceCallState.DIALING else
                                       '正在准备' if state == VoiceCallState.DIALING else
                                       '正在释放资源' if state == VoiceCallState.DISCONNECTING else '朗读未开启')

    def _set_call_state(self, state, label=None):
        state = VoiceCallState(state)
        self._call_state = state
        if state != VoiceCallState.CONNECTED and self._call_audio is not None:self._call_audio.ducked=False
        if state in {VoiceCallState.IDLE, VoiceCallState.FAILED}:
            self._read_aloud_started_call = False
        display_label = str(label or call_state_label(state))
        self.waveform.set_call_state(state, '')

        call_icon, call_caption, call_mode = {
            VoiceCallState.IDLE: ("📞", "语音通话", "dial"),
            VoiceCallState.DIALING: ("✕", "取消拨号", "hangup"),
            VoiceCallState.CONNECTED: ("📵", "挂断", "hangup"),
            VoiceCallState.MUTED: ("📵", "挂断", "hangup"),
            VoiceCallState.RESTORING_MIC: ("📵", "挂断", "hangup"),
            VoiceCallState.DISCONNECTING: ("…", "正在挂断", "busy"),
            VoiceCallState.FAILED: ("↻", "重新拨号", "dial"),
        }[state]
        self.voice_input_btn.setText(call_caption)
        self.voice_input_btn.setToolTip(call_caption)
        self.voice_input_btn.setAccessibleName(call_caption)
        self.voice_input_btn.setProperty("callMode", call_mode)
        self.call_action_label.setText(call_caption)
        self.voice_input_btn.setEnabled(state != VoiceCallState.DISCONNECTING)
        self.panel_call_btn.setText('挂断通话' if self._call_audio is not None and state in ACTIVE_CALL_STATES else '语音通话')
        self.panel_call_btn.setEnabled(state!=VoiceCallState.DISCONNECTING and not self.dictation.active)

        if state == VoiceCallState.CONNECTED:
            mic_icon, mic_caption, mic_mode, mic_enabled = (
                "🎙", "关闭麦克风", "live", True)
        elif state == VoiceCallState.MUTED:
            mic_icon, mic_caption, mic_mode, mic_enabled = (
                "🔇", "开启麦克风", "muted", True)
        elif state == VoiceCallState.RESTORING_MIC:
            mic_icon, mic_caption, mic_mode, mic_enabled = (
                "✕", "取消恢复", "restoring", True)
        elif state == VoiceCallState.DIALING:
            mic_icon, mic_caption, mic_mode, mic_enabled = (
                "🔇", "麦克风关闭", "muted", False)
        else:
            mic_icon, mic_caption, mic_mode, mic_enabled = (
                "🎙", "麦克风", "idle", False)
        self.mic_toggle_btn.setText(mic_caption)
        self.mic_toggle_btn.setToolTip(mic_caption)
        self.mic_toggle_btn.setProperty("micMode", mic_mode)
        self.mic_action_label.setText(mic_caption)
        self.mic_toggle_btn.setEnabled(mic_enabled)
        self.voice_call_panel.microphone.setText(mic_caption)
        self.voice_call_panel.microphone.setIcon(composer_icon('mic' if state==VoiceCallState.CONNECTED else 'mic-off'))
        self.voice_call_panel.microphone.setEnabled(mic_enabled)
        self.panel_call_btn.setIcon(composer_icon('hangup'))
        self.voice_call_panel.status.setText(display_label)

        # Qt 样式表不会总在动态属性改变后主动重算，显式刷新颜色状态。
        for button in (self.voice_input_btn, self.mic_toggle_btn):
            button.style().unpolish(button)
            button.style().polish(button)
            button.update()

        can_change_asr = state in {
            VoiceCallState.IDLE, VoiceCallState.FAILED,
        } and not self.dictation.active
        self.asr_engine_combo.setEnabled(can_change_asr)
        self.asr_lang_combo.setEnabled(can_change_asr)
        self._update_composer_actions()
        self._sync_read_aloud_buttons()

    def _start_voice_task(self, target, name):
        thread = threading.Thread(target=target, name=name, daemon=True)
        self._voice_tasks={t for t in self._voice_tasks if t.is_alive()}
        self._voice_tasks.add(thread)
        self._voice_task_thread = thread
        thread.start()
        return thread

    def _panel_voice_call(self):
        if self.voice_call_panel.active:
            self._hang_up_voice_call()
        elif self._read_aloud_started_call and self._call_state in {VoiceCallState.MUTED, VoiceCallState.DIALING}:
            if not self._can_start_live_call():
                return
            warming = self._call_state == VoiceCallState.DIALING
            if not warming:
                self._call_generation += 1
            self._pending_tts=False
            self._tts_queue.clear()
            self._finish_message_delivery()
            player = getattr(self, 'speak_thread', None)
            if getattr(player, 'call_stop', None) is not None:
                player.call_stop.set()
            self.tts.stop()
            self._resume_read_aloud = self.voice_check.isChecked()
            self._read_aloud_started_call=False
            self._call_audio=CallAudio()
            self._enter_call_page()
            self._upgrade_after_prime = warming
            self.voice_check.setChecked(self._setting_bool('voice/call_speaker_enabled', True))
            if not warming:
                self._restore_microphone(initial=True)
            else:
                self._set_call_state(VoiceCallState.DIALING)
        else:
            self.toggle_voice_input()

    def _enter_call_page(self):
        if self.immediate_followup: self.immediate_followup.cancel('call_changed')
        self._active_call_id = str(uuid.uuid4())
        self._relationship_call_group_id = self._relationship_group_id
        self._call_started = False
        self._interrupted_call_reply = None
        self.voice_call_panel.set_active(True)
        self.page_stack.setCurrentWidget(self.voice_call_panel)
        self._sync_sidebar()
        self.panel_call_btn.setFocus()

    def _end_live_call(self, reason='hangup'):
        if self.immediate_followup: self.immediate_followup.cancel(reason)
        if self._call_audio is not None:
            self._record_call_interruption(reason)
            self._call_audio.finish(self._call_audio.target)
            playing=getattr(self,'speak_thread',None)
            if getattr(playing,'call_stop',None) is not None:playing.call_stop.set()
        if self._call_started:
            self._record_call_event('ended', self._active_call_id, reason=reason)
        self._call_started = False
        self._active_call_id = None
        self._relationship_call_group_id = None
        self._upgrade_after_prime = False
        self._call_audio=None
        self._call_duck_span=None
        self._initial_mic=False
        if self.voice_call_panel.active:
            self.voice_call_panel.set_active(False)
            if self._failed_packet and self._failed_packet.get('call_language'):
                self._waiting_for_backend=False
                self._failed_packet=None
            if not self._closing:
                self._switch_page(0)
                self.input_box.setFocus()

    def _start_call_microphone(self):
        channel=self._call_audio
        if channel is None:
            self.asr.start()
            return
        self.asr.set_paused(False)
        identity=(self._call_generation,self._mic_generation,(self._current_session or {}).get('id'))
        def emit(kind,span,text):
            self.call_input_sig.emit((identity,kind,span,text))
        self.asr.start(on_state=lambda state:emit('state',None,state),call_audio=channel,on_call_input=emit)

    def _record_call_event(self, kind, call_id, **details):
        if self.relationship_view:
            self.relationship_view.call_event(kind,call_id,details)

    def _on_call_input(self, event):
        identity,kind,span,text=event
        channel=self._call_audio
        if (self._closing or channel is None or identity[:2]!=(self._call_generation,self._mic_generation)
                or identity[2] and identity[2]!=(self._current_session or {}).get('id')):
            return
        if kind=='state':
            self._on_asr_state(text)
            return
        if self._call_state!=VoiceCallState.CONNECTED:return
        target = channel.interrupt_target(span)
        active = target is not None and not self._reply_audio_drained(target)
        if kind=='onset':
            if self.immediate_followup: self.immediate_followup.input_event(kind,span)
            if active:
                channel.ducked=True
                self._call_duck_span=span.number
                span.onset_played_ms = self._call_playback_boundary(channel.target)['played_ms']
            return
        choice=channel.decision(span,text)
        if self._call_duck_span==span.number:
            channel.ducked=False
            self._call_duck_span=None
        if choice in ('ignore','echo'):
            if self.immediate_followup: self.immediate_followup.input_event(kind,span,choice)
            return
        if active:
            self._record_call_interruption('user_speech', span)
        if self.immediate_followup: self.immediate_followup.input_event(kind,span,choice)
        if active:
            self._cancel_native_reply(interrupted=True)
        if kind=='final' and choice=='speech':
            self._on_asr_result(text)

    def _bind_call_reply(self, owner):
        if self.relationship_view:
            location = owner.request_packet or owner.turn_location
            call_id = location.get('call_id')
            if call_id:
                self._record_call_event('requesting',call_id,request_id=owner.request_id,group_id=location.get('group_id'))
            owner.call_history_ready = self.relationship_view.pending_call_barrier(owner.request_id if call_id else None)
        if owner.voice_enabled:
            owner.call_generation=self._call_generation
        if self._call_audio is not None and owner.call_language and self._call_voice_valid(owner):
            self._call_audio.expect(owner.request_id)

    def _call_voice_valid(self, owner):
        generation=getattr(owner,'call_generation',None)
        if owner is not None and self._call_audio is not None and not getattr(owner, 'call_language', None):
            return False
        if self.relationship_view and getattr(owner,'call_language',None):
            location = getattr(owner,'request_packet',None) or getattr(owner,'turn_location',{})
            if location.get('call_id') and location['call_id']!=self._active_call_id:
                return False
        return not getattr(owner,'call_interrupted',False) and (generation is None or generation==self._call_generation)

    def _call_playback_boundary(self, target):
        owner = getattr(self, 'speak_thread', None)
        if getattr(owner, 'call_reply', None) == target and getattr(owner, 'progress', None) is not None:
            return owner.progress.boundary()
        return {'played_ms': 0, 'heard_prefix': '', 'segment_index': None, 'estimated': True}

    def _reply_audio_drained(self, target):
        owner = getattr(self, 'speak_thread', None)
        return getattr(owner, 'call_reply', None) == target and getattr(owner, 'output_drained', False)

    def _record_call_interruption(self, reason, span=None):
        target = self._call_audio.target if self._call_audio is not None else None
        if (not self._call_started or not target or target.startswith('replay:')
                or target == self._interrupted_call_reply or self._reply_audio_drained(target)):
            return
        boundary = self._call_playback_boundary(target)
        onset = getattr(span, 'onset_played_ms', None)
        if onset is not None:
            boundary['onset_played_ms'] = onset
        owner = getattr(self, 'speak_thread', None)
        boundary['overlap'] = (span is not None and boundary['played_ms'] > 0 and owner.progress.overlaps(span))
        self._interrupted_call_reply = target
        self._record_call_event('interrupted', self._active_call_id, request_id=target, reason=reason, **boundary)

    def _can_start_live_call(self):
        if not self._selected_api_route() and self.backend_combo.currentData() != 'local':
            self._open_settings_section('模型服务')
            self.append_status('填写模型连接后即可通话')
            return False
        if self.manager.brain.protocol_version and 'dedicated-call-v1' not in self.manager.brain.capabilities:
            self.append_status('请重新打开新版 ASKA 以启用语音通话')
            return False
        return True

    def _dial_voice_call(self):
        if self._closing or self._navigation_blocked:return
        if self.dictation.active:
            self.append_status('请先结束听写，再开始通话')
            return
        if not self._read_aloud_started_call:
            if not self._can_start_live_call():
                return
            self._call_audio = CallAudio()
            self._initial_mic = True
            self._enter_call_page()
            self.voice_check.setChecked(self._setting_bool('voice/call_speaker_enabled', True))
            self.tts.configure_quality(quality_config_path().is_file() and self.call_language.currentData()=='ja')
        self._call_generation += 1
        generation = self._call_generation
        if self._call_audio is not None:
            self._mic_generation += 1
        self._dial_resources_ready = False
        self._mic_resources_ready = False
        self._call_audio_ready = False
        self._pending_client_event = None
        self._mic_event_timer.stop()
        self._pending_mic_event = None
        self.tts.set_enabled(True)
        self.waveform.set_source("tts")
        self._set_call_state(VoiceCallState.DIALING, '正在准备朗读' if self._read_aloud_started_call else None)
        self.append_status('正在准备语音朗读…' if self._read_aloud_started_call else '☎ 正在拨号并准备语音线路...')
        if not self._read_aloud_started_call:
            self._call_tones.start_ringback()

        live = self._call_audio is not None
        def prepare_call():
            errors = {}

            def prepare_tts():
                started = timer()
                try:
                    self.tts.prime()
                except Exception as exc:
                    errors["TTS"] = str(exc)
                    latency.record(
                        "tts_prime", elapsed_ms(started), success=False,
                        cancelled=not self.tts.enabled,
                        error=type(exc).__name__)
                else:
                    latency.record(
                        "tts_prime", elapsed_ms(started), success=True)

            def prepare_input():
                with self._mic_lifecycle:
                    if generation != self._call_generation: return
                    try: self.asr.prepare()
                    except Exception as exc: errors['ASR'] = str(exc)

            mic = threading.Thread(target=prepare_input, name='call-input-warmup', daemon=True) if live else None
            if mic: mic.start()
            prepare_tts()
            if mic: mic.join()
            self.voice_task_sig.emit({
                "action": "dial", "generation": generation,
                "errors": errors,
            })

        self._start_voice_task(prepare_call, "voice-call-dial")

    def _start_voice_cleanup(self, generation, final_state, message, *, release_asr=True):
        def cleanup():
            errors = []
            try:
                if release_asr:
                    with self._mic_lifecycle:self.asr.unload()
            except Exception as exc:
                errors.append(f"ASR: {exc}")
            try:
                self.tts.unload()
            except Exception as exc:
                errors.append(f"TTS: {exc}")
            self.voice_task_sig.emit({
                "action": "cleanup", "generation": generation,
                "errors": errors, "final_state": final_state.value,
                "message": message,
            })

        self._start_voice_task(cleanup, "voice-call-cleanup")

    def _hang_up_voice_call(self):
        if self._call_state in {VoiceCallState.IDLE, VoiceCallState.FAILED}:
            return
        live = self._call_audio is not None
        reading = self._read_aloud_started_call and not live
        keep_warm = live and self._resume_read_aloud and self._call_audio_ready
        self._end_live_call()
        self._stash_queued_asr()
        self._finish_message_delivery()
        playing = getattr(self, 'speak_thread', None)
        if getattr(playing, 'call_stop', None) is not None:
            playing.call_stop.set()
        self._call_generation += 1
        generation = self._call_generation
        if not reading:
            self._mic_generation += 1
        self._dial_resources_ready = False
        self._mic_resources_ready = False
        self._call_audio_ready = False
        self._mic_event_timer.stop()
        self._pending_mic_event = None
        self._pending_client_event = None
        self._pending_tts = False
        self._tts_queue.clear()
        self._call_tones.stop()
        if not reading:
            self.asr.request_stop()
        if live:
            self._call_tones.play_hangup()
        if keep_warm:
            self._resume_read_aloud = False
            self._read_aloud_started_call = True
            self.tts.request_stop()
            self.tts.configure_quality(quality_config_path().is_file())
            self.voice_check.setChecked(True)
            self._call_audio_ready = True
            self._set_call_state(VoiceCallState.MUTED, '朗读已就绪 · 麦克风关闭')
            self._release_asr_after_mute(self._mic_generation)
            self.append_status('语音通话已挂断，已恢复回复朗读')
            return
        self.tts.set_enabled(False)
        self._set_call_state(VoiceCallState.DISCONNECTING, '正在挂断' if live else '正在关闭朗读')
        self._start_voice_cleanup(
            generation, VoiceCallState.IDLE, '语音通话已挂断' if live else '已停止音频和自动朗读', release_asr=not reading)

    def _fail_voice_call(self, message):
        reading = self._read_aloud_started_call and self._call_audio is None
        self._end_live_call('failed')
        self._stash_queued_asr()
        self._finish_message_delivery()
        self._call_generation += 1
        generation = self._call_generation
        if not reading:
            self._mic_generation += 1
        self._dial_resources_ready = False
        self._mic_resources_ready = False
        self._call_audio_ready = False
        self._call_tones.stop()
        self._pending_tts = False
        self._tts_queue.clear()
        self._pending_client_event = None
        self._mic_event_timer.stop()
        self._pending_mic_event = None
        self.tts.set_enabled(False)
        if not reading:
            self.asr.request_stop()
        self._set_call_state(
            VoiceCallState.DISCONNECTING, "连接失败，正在清理")
        self._voice_problem('call',message)
        self._start_voice_cleanup(
            generation, VoiceCallState.FAILED,
            '语音未接通，可以重新拨号。', release_asr=not reading)

    def _complete_voice_connection(self):
        if (self._call_state != VoiceCallState.DIALING
                or not self._dial_resources_ready):
            return
        generation = self._call_generation
        self._dial_resources_ready = False
        if self._upgrade_after_prime:
            self._upgrade_after_prime = False
            self._call_audio_ready = True
            self._set_call_state(VoiceCallState.MUTED, '正在接通')
            self._restore_microphone(initial=True)
            return
        if self._read_aloud_started_call:
            self._set_call_state(VoiceCallState.MUTED, '朗读已就绪 · 麦克风关闭')
            self.append_status('语音朗读已准备好，麦克风保持关闭')
            self._on_call_tone_finished('connected', generation)
            return
        self._set_call_state(VoiceCallState.MUTED, '正在接通')
        self._call_tones.play_connected(
            on_finished=lambda: self.call_tone_finished_sig.emit(
                "connected", generation))

    def _on_call_tone_finished(self, tone, generation):
        if (tone != "connected" or generation != self._call_generation
                or self._call_state not in TTS_PLAYBACK_STATES):
            return
        self._call_audio_ready = True
        if self._call_audio is not None and self._initial_mic and self._call_state==VoiceCallState.MUTED:
            self._mic_resources_ready=True
            self._set_call_state(VoiceCallState.RESTORING_MIC, '正在打开麦克风')
            self._start_call_microphone()
        self._play_next_tts()
        self._drain_client_event()

    def _on_voice_task_result(self, result):
        if self._closing:return
        action = result.get("action")
        generation = result.get("generation")
        if action == "dial":
            if (generation != self._call_generation
                    or self._call_state != VoiceCallState.DIALING):
                return
            errors = result.get("errors") or {}
            if errors:
                self._fail_voice_call("；".join(
                    f"{name}: {error}" for name, error in errors.items()))
                return
            self._dial_resources_ready = True
            self._complete_voice_connection()
        elif action == "cleanup":
            if generation != self._call_generation:
                return
            errors = result.get("errors") or []
            if errors:
                self._resume_read_aloud = False
                self._set_call_state(VoiceCallState.FAILED)
                self.append_status(
                    "⚠️ 语音资源释放不完整：" + "；".join(errors))
                return
            final_state = VoiceCallState(result.get("final_state"))
            self._set_call_state(final_state)
            self.append_status(str(result.get("message") or call_state_label(
                final_state)))
            if self._resume_read_aloud:
                self._resume_read_aloud = False
                self._toggle_read_aloud()
        elif action == "mute_cleanup":
            if self._asr_release_generation == generation:
                self._asr_release_generation = None
                self._update_composer_actions()
            if generation != self._mic_generation:
                return
            if result.get("errors"):
                self.append_status(
                    "⚠️ ASR 释放失败：" + "；".join(result["errors"]))
            elif self._call_state == VoiceCallState.MUTED:
                if self.manager.brain.supports_hidden_client_events:
                    self.append_status("麦克风已关闭，语音识别模型已释放")
                else:
                    self.append_status(
                        "麦克风已关闭，识别模型已释放；"
                        "重启旧 Pi Brain 后可启用角色状态反馈")
        elif action == "restore_mic":
            if (generation != self._mic_generation
                    or self._call_state != VoiceCallState.RESTORING_MIC):
                return
            errors = result.get("errors") or []
            if errors:
                self._mic_resources_ready = False
                if self._initial_mic:
                    self._fail_voice_call('；'.join(errors))
                    return
                self._set_call_state(VoiceCallState.MUTED)
                self.append_status(
                    "⚠️ 麦克风恢复失败：" + "；".join(errors))
                self._release_asr_after_mute(generation)
                return
            self._mic_resources_ready = True
            self.append_status("识别模型已准备，正在打开麦克风...")
            self._start_call_microphone()

    def _release_asr_after_mute(self, generation):
        self._asr_release_generation = generation
        self._update_composer_actions()
        def cleanup_asr():
            errors = []
            try:
                with self._mic_lifecycle:
                    if generation == self._mic_generation:
                        self.asr.unload()
            except Exception as exc:
                errors.append(str(exc))
            self.voice_task_sig.emit({
                "action": "mute_cleanup", "generation": generation,
                "errors": errors,
            })

        self._start_voice_task(cleanup_asr, "voice-call-mute")

    def toggle_microphone(self):
        if self._read_aloud_started_call or self._call_state in {VoiceCallState.IDLE, VoiceCallState.FAILED}:
            if self.dictation.active:self.dictation.finish()
            elif self._asr_release_generation is None:
                player = getattr(self, 'speak_thread', None)
                if getattr(player, 'call_stop', None) is not None:
                    player.call_stop.set()
                self.tts.stop()
                self.asr.set_paused(False)
                self.dictation.start()
        elif self._call_state == VoiceCallState.CONNECTED:
            self._mute_microphone()
        elif self._call_state == VoiceCallState.MUTED:
            self._restore_microphone()
        elif self._call_state == VoiceCallState.RESTORING_MIC:
            self._mute_microphone()

    def _mute_microphone(self):
        if self._call_state not in {
                VoiceCallState.CONNECTED, VoiceCallState.RESTORING_MIC}:
            return
        self._mic_generation += 1
        generation = self._mic_generation
        self._mic_resources_ready = False
        self._initial_mic = False
        if self._call_audio: self._call_audio.ducked=False
        self._mic_event_timer.stop()
        self._pending_mic_event = None
        self._pending_client_event = None
        self.asr.request_stop()
        self._set_call_state(VoiceCallState.MUTED)
        self.append_status("麦克风已关闭，正在释放语音识别模型...")
        self._schedule_microphone_event(MICROPHONE_MUTED_EVENT)
        self._release_asr_after_mute(generation)

    def _restore_microphone(self, initial=False):
        if self._call_state != VoiceCallState.MUTED:
            return
        unavailable = self.asr.provider_availability_error(
            self.asr_engine_combo.currentData())
        if unavailable:
            if initial:
                self._fail_voice_call(unavailable)
                return
            self.append_status(f"⚠️ {unavailable}")
            return
        self._mic_generation += 1
        generation = self._mic_generation
        self._initial_mic = initial
        self._mic_event_timer.stop()
        self._pending_mic_event = None
        self._pending_client_event = None
        self._mic_resources_ready = False
        self._set_call_state(VoiceCallState.RESTORING_MIC)
        self.append_status("正在重新加载语音识别模型...")

        def prepare_asr():
            errors = []
            try:
                with self._mic_lifecycle:
                    if generation!=self._mic_generation:return
                    self.asr.prepare()
            except Exception as exc:
                errors.append(str(exc))
            self.voice_task_sig.emit({
                "action": "restore_mic", "generation": generation,
                "errors": errors,
            })

        self._start_voice_task(prepare_asr, "voice-call-restore-mic")

    def _complete_microphone_restore(self):
        if (self._call_state != VoiceCallState.RESTORING_MIC
                or not self._mic_resources_ready):
            return
        self._mic_resources_ready = False
        self._set_call_state(VoiceCallState.CONNECTED)
        if self._active_call_id and not self._call_started:
            self._call_started = True
            self._record_call_event('started', self._active_call_id)
        self.append_status("语音通话已接通" if self._initial_mic else "麦克风已恢复")
        if not self._initial_mic: self._schedule_microphone_event(MICROPHONE_UNMUTED_EVENT)
        self._initial_mic = False

    def _schedule_microphone_event(self, event_type):
        self._pending_mic_event = event_type
        self._mic_event_timer.start(600)

    def _commit_microphone_event(self):
        event_type = self._pending_mic_event
        self._pending_mic_event = None
        if event_type == MICROPHONE_MUTED_EVENT:
            valid = self._call_state == VoiceCallState.MUTED
        elif event_type == MICROPHONE_UNMUTED_EVENT:
            valid = self._call_state == VoiceCallState.CONNECTED
        else:
            valid = False
        if not valid:
            return
        # 尚未提交的相反事件以最终状态为准，不制造连续插话。
        self._pending_client_event = event_type
        self._drain_client_event()

    def _drain_client_event(self):
        if self._closing or self._navigation_blocked or not self._pending_client_event:
            return
        if self._call_state not in ACTIVE_CALL_STATES:
            self._pending_client_event = None
            return
        speak_thread = getattr(self, "speak_thread", None)
        if (getattr(self, "_chat_busy", False)
                or (speak_thread is not None and speak_thread.isRunning())
                or self.tts.is_speaking or self._tts_queue):
            return
        event_type = self._pending_client_event
        self._pending_client_event = None
        self._start_client_event(event_type)

    def _start_client_event(self, event_type):
        if getattr(self, "_chat_busy", False):
            self._pending_client_event = event_type
            return
        if self.immediate_followup: self.immediate_followup.cancel('microphone_state')
        if self.backend_combo.currentData()!='local' and (
                not self._selected_api_route() or not self._apply_pending_api()):
            self.append_status('语音状态将在模型连接可用后同步。')
            self._pending_client_event=event_type
            return
        self._active_chat_kind = "client_event"
        self._chat_user_row = None
        self._last_user_message = f"[client_event:{event_type}]"
        self._chat_busy = True
        self._chat_started_at = timer()
        self.reset_stream()
        self._begin_reply_feedback()
        self._chat_thread = ChatThread(
            self.manager, client_event=event_type,session_id=(self._current_session or {}).get('id'),
            **self._personality_options())
        if self.relationship_view:
            self._chat_thread.turn_location={'group_id':self._relationship_call_group_id if self._active_call_id else self._relationship_group_id,
                                             'call_id':self._active_call_id}
        self._bind_call_reply(self._chat_thread)
        self._chat_thread.result.connect(lambda speech,translation,owner=self._chat_thread:self._receive_chat_reply(speech,translation,owner))
        self._chat_thread.failed.connect(lambda problem,owner=self._chat_thread:self._on_chat_failure(problem,owner))
        self._chat_thread.tts_data.connect(lambda data,owner=self._chat_thread:self._on_tts_data(data,owner))
        self._chat_thread.status.connect(self.append_status)
        self._chat_thread.progress.connect(lambda data, owner=self._chat_thread: self._on_chat_progress(data, owner))
        self._chat_thread.finished_tts.connect(lambda ok,owner=self._chat_thread:self._chat_done(ok) if owner is self._chat_thread else None)
        self._chat_thread.start()

    def _toggle_waveform(self, visible):
        self.waveform.setVisible(bool(visible))
        self._settings.setValue('voice/show_call_avatar',bool(visible))

    def _update_diagnostics_badge(self, count):
        suffix = f"  {count}" if count else ""
        self.diagnostics_nav_btn.setText(f"异常样本{suffix}")

    def _show_session_context_menu(self, position):
        if self.relationship_view:
            return self.relationship_view.group_menu(position)
        item = self.session_list.itemAt(position)
        if item is None:
            return
        self.session_list.setCurrentItem(item)
        menu = QMenu(self)
        export_action=menu.addAction('导出聊天记录…')
        export_action.setEnabled(self._export_worker is None)
        export_action.triggered.connect(self.export_conversation)
        delete_action = menu.addAction("删除这条对话")
        delete_action.triggered.connect(self.delete_conversation)
        if self._pending_store.pending_removals():menu.addAction('继续未完成的删除…',self._choose_pending_removal)
        menu.exec(self.session_list.viewport().mapToGlobal(position))

    def export_conversation(self):
        if self._closing or self._export_worker is not None:return
        if self.relationship_view:
            session = dict(self._current_session or {})
            if not session.get('id'): return
        else:
            row=self.session_list.currentRow()
            if not 0<=row<len(self._sessions):return
            session=dict(self._sessions[row])
        from PyQt6.QtWidgets import QFileDialog
        file,_=QFileDialog.getSaveFileName(self,'导出聊天记录','聊天记录.txt','文本文件 (*.txt);;JSON (*.json)')
        if not file:return
        owner=ExportConversation(self.manager.brain,session,file,self)
        self._export_worker=owner
        owner.finished.connect(self._finish_export)
        owner.start()

    def _finish_export(self):
        owner=self._export_worker
        self._export_worker=None
        if not self._closing:
            self.append_status(f'已导出 {owner.count} 条消息' if owner.count is not None else '导出失败，请检查对话和保存位置。')
        owner.deleteLater()

    def auto_start(self):
        """启动时恢复所选 API 路由，并自动拉起 Pi 脑层。"""
        if self._closing:return
        if self._backend_connecting:return
        self._backend_connecting=True
        self.backend_combo.setCurrentIndex(0)
        import core.llama_manager as lm
        lm.BACKEND_MODE = "api"
        self._set_api_runtime_route()
        self._refresh_header_model()
        if self._selected_api_route():self.append_status("API 配置已载入")
        # 自动启动 Pi 脑层（后台线程）
        import threading
        def _start_pi():
            ok, msg = self.manager.pi_start()
            if ok:
                self.brain_ready_sig.emit()
            else:self.brain_failed_sig.emit(msg)
        t_pi = threading.Thread(target=_start_pi, daemon=True)
        self._startup_thread=t_pi
        t_pi.start()

    def _on_brain_ready(self):
        if self._closing:return
        """Brain 就绪后同步界面路由，再加载会话。"""
        self._backend_connecting=False
        import core.llama_manager as lm

        if (self.backend_combo.currentData() == "local"
                and self.manager.owns_server):
            ok, message = self.manager.pi_set_model(
                *lm.LOCAL_MODEL, vision=self.manager.use_vision,
                context_window=self.manager.context_size)
            if ok:
                lm.BACKEND_MODE = "local"
        else:
            # Brain 可能是上次客户端留下的兼容进程，不能假设它仍在 API
            # 路由；每次客户端启动都以当前界面选项覆盖一次真实模型。
            ok, message = self._apply_selected_api_route()
            if ok:
                lm.BACKEND_MODE = "api"
        self.append_status(f"🧠 {message}" if ok else
                           "请在设置 · 模型服务中填写连接" if not self._selected_api_route() else f"模型连接失败：{message}")
        if ok: self._api_config_pending = False
        self._navigation_blocked=True
        self._load_sessions(after='startup')

    def _resume_after_startup(self,synced):
        self._offer_pending_removal()
        self._request_context_usage()
        if synced and self._waiting_for_backend and self._failed_packet and self._failed_packet.get('session_id') and not self._failed_packet.get('cancelled'):
            self._waiting_for_backend=False
            QTimer.singleShot(0,self._retry_failed_reply)
        elif self._waiting_for_backend:
            self._waiting_for_backend=False
            self.chat_display.show_system_notice('消息已保留，连接恢复后可继续。',on_retry=self._retry_failed_reply)

    def _on_backend_failed(self,detail):
        self._backend_connecting=False;self._waiting_for_backend=False
        record_failure({'code':'BRAIN_START_FAILED','detail':detail},stage='startup')
        self.append_status('模型服务暂未连上。')
        if self._failed_packet:self.chat_display.show_system_notice('消息已保留，可以重新连接后继续。',
            on_retry=self._retry_failed_reply,on_settings=lambda:self._open_settings_section('模型服务'))
        self._update_composer_actions()

    def toggle_server(self):
        """后台启动/停止 llama-server，并在成功后切换 Pi 模型源。"""
        if self._local_model_thread is not None \
                and self._local_model_thread.isRunning():
            return
        if self.manager.owns_server:
            action = "stop"
            self._set_local_model_busy(True, "🟡 正在停止本地模型...")
            thread = LocalModelThread(self.manager, action)
        else:
            model_file = self.model_combo.currentData()
            if not model_file:
                self.append_status("⚠️ 没有可启动的本地 GGUF 模型")
                return
            action = "start"
            self._set_local_model_busy(True, "🟡 正在加载本地模型...")
            thread = LocalModelThread(
                self.manager, action, model_file=model_file,
                context_size=self.ctx_spin.value(),
                use_vision=self.vision_check.isChecked())
        self._local_model_thread = thread
        thread.result.connect(self._on_local_model_result)
        thread.start()

    def _on_asr_lang_change(self, idx):
        """切换语音识别语言"""
        lang = self.asr_lang_combo.currentData()
        self._settings.setValue("voice/asr_language", lang)
        names = {
            "mixed": "混合/自动", "zh": "中文",
            "en": "英文", "ja": "日文",
        }
        self.voice_input_btn.setToolTip(
            f"语音通话 · 识别语言：{names.get(lang, lang)}")
        if lang == "mixed":
            self.asr.language = None
            self.append_status("语音识别语言: 混合/自动")
        else:
            self.asr.language = lang
            self.append_status(
                f"语音识别语言: {names.get(lang, lang)}")

    def _on_asr_engine_change(self, _idx):
        engine = self.asr_engine_combo.currentData() or "whisper"
        try:
            self.asr.set_engine(engine)
        except (ValueError, RuntimeError) as exc:
            self.append_status(f"⚠️ {exc}")
            actual_index = self.asr_engine_combo.findData(self.asr.engine)
            self.asr_engine_combo.blockSignals(True)
            self.asr_engine_combo.setCurrentIndex(max(0, actual_index))
            self.asr_engine_combo.blockSignals(False)
            return
        self._settings.setValue("voice/asr_engine", engine)
        unavailable = self.asr.provider_availability_error(engine)
        if unavailable:
            self.append_status(f"⚪ {unavailable}")
            return
        provider = next(
            item for item in self.asr.provider_options()
            if item.provider_id == engine)
        self.append_status(
            f"语音识别: {self.asr_engine_combo.currentText()} · "
            f"{provider.resource_hint}")

    # ===== 会话管理 =====
    def _load_sessions(self, preferred_id=None, after=None):
        if self._closing:return
        if self.relationship_view:
            return self.relationship_view.list_groups(startup=after=='startup')
        self._list_generation+=1
        generation=self._list_generation
        worker=SessionListRead(self.manager.brain,self,self._pending_store)
        self._list_workers.add(worker)
        worker.finished.connect(lambda:self._list_read_done(worker,generation,preferred_id,after))
        worker.start()

    def _list_read_done(self,worker,generation,preferred_id,after):
        self._list_workers.discard(worker);worker.deleteLater()
        if self._closing or generation!=self._list_generation:return
        data=worker.result
        if not isinstance(data.get('sessions'),list):
            if after:
                self._navigation_blocked=True
                if after=='startup':self._resume_after_startup(False)
                self.chat_display.show_system_notice('会话列表暂时不可用。',on_retry=lambda:self._load_sessions(preferred_id,after))
            return
        if after=='startup':
            preferred_id=(data.get('active') or {}).get('id') or preferred_id
        preferred_id=preferred_id or (self._current_session or {}).get('id')
        self._apply_session_list(data,preferred_id)
        if self._pending_session_id and any(x.get('id')==self._pending_session_id and x.get('path') for x in self._sessions):
            self._pending_session_id=None
        if after and self._current_session:
            self._startup_navigation=after=='startup'
            self._begin_navigation(self._current_session)
        elif after:
            self._navigation_blocked=False
            if after=='startup':self._resume_after_startup(False)

    def _apply_session_list(self,data,preferred_id):
        pending = next((s for s in self._sessions
                        if preferred_id and s.get("id") == preferred_id
                        and s.get("pending")), None)
        self._sessions = list(data.get("sessions", []))
        listed={row.get('id'):row for row in self._sessions}
        for row in data.get('pending_titles',[]):
            if row['id'] in listed:
                saved=listed[row['id']]
                saved['updated_ms']=max(saved.get('updated_ms',0),row['updated_ms'])
            else:
                self._sessions.append(row)
        self._sessions.sort(key=lambda row:row.get('updated_ms',0),reverse=True)
        if data.get('active') and (not self._sessions or preferred_id==data['active'].get('id') and not any(x.get('id')==preferred_id for x in self._sessions)):
            active=dict(data['active'])
            self._sessions.insert(0,active)
            if not active.get('path'):
                active.update(pending=True,empty_session=True);self._pending_session_id=active['id']
        if (pending is not None
                and not any(s.get("id") == preferred_id for s in self._sessions)):
            self._sessions.insert(0, pending)
        self.session_list.clear()
        self.session_list.addItems([s.get('title') or '新对话' for s in self._sessions])
        selected_row=next((i for i,s in enumerate(self._sessions) if s.get('id')==preferred_id),0)
        if self.session_list.count() > 0:
            if preferred_id and self._current_session and all(x.get('id')!=preferred_id for x in self._sessions):
                self.session_list.setCurrentRow(-1);return
            self.session_list.setCurrentRow(selected_row)
            self._current_session = self._sessions[selected_row]
            self._sync_composer_labels()

    def new_conversation(self):
        """新建对话"""
        if self.relationship_view:
            return self.relationship_view.edit_group('create')
        if self._chat_busy or self._waiting_for_backend or self._navigation_worker is not None or self._delete_worker is not None:
            self.append_status("请等待当前操作结束后再新建对话")
            return
        self.dictation.cancel()
        self._switch_page(0)
        self._begin_navigation({},create=True)

    def _on_session_click(self, item):
        if self.relationship_view:
            if item is not None: self.relationship_view.select(item.data(Qt.ItemDataRole.UserRole))
            return
        if self._delete_worker is not None or self._closing:return
        """点击会话切换：切换并加载历史"""
        if self._chat_busy or self._waiting_for_backend:
            self.append_status("请先停止当前回复，或等它完成后再切换对话")
            return
        self.dictation.cancel()
        self._switch_page(0)
        row = self.session_list.row(item)
        if row < 0 or row >= len(self._sessions):
            return
        session = self._sessions[row]
        # Re-selecting the already displayed conversation keeps its scroll position.
        current=self._current_session or {}
        if (not self._navigation_blocked and self._navigation_worker is None and session.get('id')==current.get('id')
                and session.get('path')==current.get('path')):
            self._current_session = session
            return
        self._begin_navigation(session)

    def _begin_navigation(self,session,create=False):
        if self._closing or self._delete_worker is not None:return
        if self._navigation_worker is not None:
            self._queued_navigation=dict(session)
            return
        self._list_generation+=1
        self._navigation_blocked=True
        self.append_status('正在读取对话…')
        self._update_composer_actions()
        owner=SessionNavigation(self.manager.brain,self._current_session,session,self,create=create)
        self._navigation_worker=owner
        owner.finished.connect(self._navigation_done)
        owner.start()

    def _navigation_done(self):
        owner=self._navigation_worker
        if owner is None:return
        self._navigation_worker=None
        outcome=owner.result;target=owner.target
        owner.deleteLater()
        if self._closing:return
        later,self._queued_navigation=self._queued_navigation,None
        if later is not None:
            self._begin_navigation(later)
            return
        if outcome.get('ok'):
            if not self._startup_navigation:self._leave_voice_transcript()
            self._pending_session_id=target['id'] if not target.get('path') else None
            if owner.create:
                self._clear_chat_image();self.session_list.setCurrentRow(-1);self._stream_buf='';self._pending_tts=False
            self._current_session=target
            for index, listed in enumerate(self._sessions):
                if listed['id']==target['id'] and (not listed.get('path') or listed['path']==target.get('path')):
                    self._sessions[index]=target
                    item=self.session_list.item(index)
                    if item is not None:item.setText(target.get('title') or '新对话')
                    break
            self._render_session_history(outcome['history'])
            self._navigation_blocked=False
            self._sync_composer_labels()
            self.append_status('新对话开始' if owner.create else '已切换到: '+target.get('title','会话'))
        else:
            self._navigation_blocked=not outcome.get('restored',False)
            current=(self._current_session or {}).get('id')
            self.session_list.setCurrentRow(next((i for i,s in enumerate(self._sessions) if s.get('id')==current),-1))
            self.chat_display.show_system_notice('历史暂时未载入，当前消息已保留。',on_retry=lambda:self._begin_navigation(target))
        self._update_composer_actions()
        if self._startup_navigation:
            self._startup_navigation=False
            self._resume_after_startup(bool(outcome.get('ok')))

    def _load_session_history(self, path):
        session=dict(self._current_session or {})
        if session.get('id'):
            session['path']=path
            self._begin_navigation(session)

    def _render_session_history(self,data):
        self.thinking_panel=None
        messages=[m for m in data.get('messages',[]) if m.get('surface')!='call']
        answered=set(data.get('completed_requests',[]))
        answered.update(m['request_id'] for m in messages if m.get('role')=='assistant' and m.get('request_id'))
        limit=self.chat_display.history_page_size
        last_user=None
        with self.chat_display.batch_update():
            self.chat_display.clear()
            self.chat_display.retain_earlier(messages[:-limit])
            for m in messages[-limit:]:
                row=self._add_history_message(m)
                if row is not None:
                    last_user=row if row.is_user else None
            self._restore_pending(data.get('pending'),last_user,answered)
        self._restore_draft()

    def _add_history_message(self, message, before=None, *, display=None):
        from core.file_attachment import visible_file_message
        area = self.chat_display if display is None else display
        content=visible_file_message(message.get('content',''))
        if message.get('hasImage') and '\n\n附件：' not in content:
            content=f'🖼 图片\n{content}' if content else '🖼 图片'
        if not content:
            return None
        if message.get('role')=='user':
            row=area.add_message(content,is_user=True,before_row=before)
            row.request_id=message.get('request_id')
            row.set_read(bool(message.get('read')))
            if self.relationship_view: self.relationship_view.attach_row(row)
            return row
        if message.get('role')=='assistant':
            speech,translation=((message['speech'],message.get('translation','')) if isinstance(message.get('speech'),str)
                                else self._split_reply_translation(content))
            row=area.add_message(speech,avatar_path=self._asuka_avatar,translation=translation,
                                              parts=message.get('parts'),before_row=before)
            row.request_id=message.get('request_id')
            self._bind_replay_row(row,message.get('playback_id'))
            if self.relationship_view: self.relationship_view.attach_row(row)
            return row

    def _voice_owns_conversation(self):
        speaker=getattr(self,'speak_thread',None)
        return bool(self.tts.is_speaking or speaker is not None and speaker.isRunning() or self._tts_queue or self._call_state in ACTIVE_CALL_STATES)

    def delete_conversation(self):
        if self._native_chat_pending() or self._chat_busy or self._navigation_worker or self._delete_worker or self._voice_owns_conversation():
            self.append_status('请等待当前操作结束后再删除对话');return
        row=self.session_list.currentRow()
        if not 0<=row<len(self._sessions):return
        session=self._sessions[row]
        answer=QMessageBox.question(self,'删除对话','删除这段对话的消息、人格记录、草稿和音频回放？',
            QMessageBox.StandardButton.Yes|QMessageBox.StandardButton.No,QMessageBox.StandardButton.No)
        if answer!=QMessageBox.StandardButton.Yes:return
        try:self._pending_store.begin_removal(session['id'])
        except (OSError,ValueError):
            self.append_status('暂时无法保存删除请求，请稍后重试。');return
        self._delete_session_records(session)

    def _delete_session_records(self,session):
        if self._closing or self._chat_busy or self._delete_worker or self._navigation_worker or self._voice_owns_conversation():return
        self._list_generation+=1
        self._navigation_blocked=True
        self._finish_message_delivery();self._tts_queue.clear();self.dictation.cancel()
        owner=DeleteConversation(self.manager.brain,self._pending_store,self.tts.audio_replay,session,self)
        self._delete_worker=owner;owner.finished.connect(self._delete_session_finished);owner.start()

    def _delete_session_finished(self):
        owner=self._delete_worker
        if owner is None:return
        self._delete_worker=None;owner.deleteLater()
        if self._closing:return
        sid=owner.session['id'];finished=owner.result.get('ok')
        if finished:
            try:
                for key in (self._draft_key(sid),'voice/queued/'+sid):self._settings.remove(key)
                self._settings.sync()
                if self._settings.status()!=type(self._settings).Status.NoError:raise OSError('settings')
                self._pending_store.finish_removal(sid)
            except (OSError,ValueError):finished=False
        if not finished:
            local=owner.result.get('stage')=='local' or owner.result.get('ok')
            if local and (self._current_session or {}).get('id')==sid:
                self._leave_voice_transcript();self.chat_display.clear();self.input_box.clear();self._current_session=None
            self.chat_display.show_system_notice('后台对话已删除，本地记录仍待清理。' if local else '删除尚未确认，可重新选择会话或重试。',on_retry=lambda:self._delete_session_records({'id':sid}));return
        self._leave_voice_transcript();self.chat_display.clear();self.input_box.clear();self._current_session=None
        self._load_sessions(preferred_id=owner.result.get('activeSessionId'),after='delete')
        if owner.result.get('unclassified'):
            self.append_status('已删除这段对话的可核实记录，有归属不明的本地文件保留。')
        else:self.append_status('会话已删除')

    def _offer_pending_removal(self):
        pending=self._pending_store.pending_removals()
        if pending:
            self.chat_display.show_system_notice(f'有 {len(pending)} 段对话的删除尚未完成。',on_retry=self._choose_pending_removal)

    def _choose_pending_removal(self):
        from PyQt6.QtWidgets import QInputDialog
        pending=self._pending_store.pending_removals()
        if not pending:return
        if len(pending)==1:sid=pending[0]
        else:
            sid,ok=QInputDialog.getItem(self,'继续删除','选择要继续清理的对话编号',pending,0,False)
            if not ok:return
        self._delete_session_records({'id':sid})

    def import_avatar(self):
        """导入明日香头像"""
        from PyQt6.QtWidgets import QFileDialog
        path, _ = QFileDialog.getOpenFileName(
            self, "选择明日香头像", "", "图片 (*.png *.jpg *.jpeg *.webp)")
        if not path:
            return
        # 复制到 assets
        import shutil
        dest = os.path.join(self._assets_dir, "asuka_avatar.png")
        try:
            shutil.copy(path, dest)
            self._asuka_avatar = dest
            self.waveform.set_images(tts_image=dest)
            if self.relationship_view:self.relationship_view.header_avatar.set_image(dest)
            self.append_status("✅ 头像已更新")
        except Exception as e:
            self.append_status(f"⚠️ 头像导入失败: {e}")

    def import_user_avatar(self):
        """导入用户头像，用作用户说话时环形播放器的中心图片。"""
        from PyQt6.QtWidgets import QFileDialog
        path, _ = QFileDialog.getOpenFileName(
            self, "选择我的头像", "", "图片 (*.png *.jpg *.jpeg *.webp)")
        if not path:
            return
        pixmap = QPixmap(path)
        if pixmap.isNull():
            self.append_status("⚠️ 无法读取所选用户头像")
            return
        dest = os.path.join(self._assets_dir, "user_avatar.png")
        if not pixmap.save(dest, "PNG"):
            self.append_status("⚠️ 用户头像保存失败")
            return
        self._user_avatar = dest
        self.waveform.set_images(user_image=dest)
        self.waveform.set_source("user")
        self.append_status("✅ 用户头像已更新")

    def import_background(self):
        """导入并持久保存聊天背景图。"""
        from PyQt6.QtWidgets import QFileDialog
        path, _ = QFileDialog.getOpenFileName(
            self, "选择聊天背景", "", "图片 (*.png *.jpg *.jpeg *.webp)")
        if not path:
            return
        pixmap = QPixmap(path)
        if pixmap.isNull():
            self.append_status("⚠️ 无法读取所选背景图")
            return
        dest = os.path.join(self._assets_dir, "chat_background.png")
        if not pixmap.save(dest, "PNG"):
            self.append_status("⚠️ 背景图保存失败")
            return
        self._chat_bg = dest
        if self.chat_display.set_background(dest):
            self.voice_call_panel.set_artwork(dest)
            self.append_status("✅ 背景已更新")
        else:
            self.append_status("⚠️ 背景图加载失败")

    def on_background_opacity_change(self, value):
        """实时调节聊天背景透明度，并在客户端重启后保留设置。"""
        self._background_opacity = int(value)
        self.bg_opacity_label.setText(f"背景可见度  {value}%")
        self.chat_display.set_background_opacity(value / 100.0)
        self._settings.setValue("chat/background_opacity", value)

    def toggle_voice_input(self):
        """主通话按钮：主动拨号，或结束当前语音通话会话。"""
        if self._call_state in {
                VoiceCallState.IDLE, VoiceCallState.FAILED}:
            self._dial_voice_call()
        else:
            self._hang_up_voice_call()

    def _on_asr_state_raw(self, state):
        """ASR 后台线程调用的原始回调 → 发信号到主线程"""
        self.asr_state_sig.emit(state)

    def _on_asr_result_raw(self, text):
        """ASR 后台线程调用的原始回调 → 发信号到主线程"""
        self.asr_result_sig.emit(text)

    def _on_asr_level_raw(self, level):
        """ASR 后台线程的电平回调 → 发信号到主线程"""
        self.asr_level_sig.emit(level)

    def _on_asr_spectrum_raw(self, spectrum):
        """ASR 音频线程的 FFT 频带 → 主线程。"""
        self.asr_spectrum_sig.emit(spectrum)

    def _on_asr_level(self, level):
        """用户说话实时电平（主线程）→ 环形波形"""
        try:
            if self._asr_visual_active and not self._tts_visual_active:
                self.waveform.set_level(level)
        except Exception:
            pass

    def _on_asr_spectrum(self, spectrum):
        """VAD 已确认用户说话时显示实时输入频谱。"""
        if not self._asr_visual_active or self._tts_visual_active:
            return
        self.waveform.set_source("user")
        self.waveform.set_spectrum(spectrum)

    def _on_tts_level(self, level):
        """明日香播放实时电平（主线程）→ 环形波形和当前气泡。"""
        try:
            # 明日香说话时波形为粉色
            if level > 0.003:
                self._tts_visual_active = True
                self.waveform.set_source("tts")
            self.waveform.set_level(level)
            row = self._active_tts_row
            if row is not None:
                # 首个非零采样才启动，避免在 TTS 合成等待阶段提前发光。
                if level > 0.003:
                    row.set_playing(True)
                row.set_audio_level(level)
        except Exception:
            self._active_tts_row = None

    def _on_tts_spectrum(self, spectrum):
        """显示当前 TTS 输出的实时频谱；静音帧不改变最后说话者。"""
        try:
            if max(spectrum, default=0.0) > 0.002:
                self._tts_visual_active = True
                self.waveform.set_source("tts")
            self.waveform.set_spectrum(spectrum)
        except (TypeError, ValueError):
            pass

    def _on_tts_playback_end(self, row):
        """播放线程结束后在主线程触发气泡光效淡出。"""
        if isinstance(row,tuple):
            owner,row=row
            if owner is not getattr(self,'speak_thread',None):return
        if self._active_tts_row is row:
            self._active_tts_row = None
        self._tts_visual_active = False
        self.waveform.set_level(0)
        self.waveform.set_spectrum([0.0] * self.waveform.BAR_COUNT)
        if row is not None:
            try:
                row.set_audio_level(0)
                row.set_playing(False)
            except RuntimeError:
                pass

    def _on_asr_state(self, state):
        """语音输入状态变化（主线程）；通话按钮只由通话状态机控制。"""
        self._initiative_asr_state = state
        if self.dictation.active:return
        try:
            if state == "recording":
                if self._call_state != VoiceCallState.CONNECTED:
                    return
                self._asr_visual_active = True
                self._tts_visual_active = False
                self.waveform.set_source("user")
            elif state == "transcribing":
                self._asr_visual_active = False
                self.waveform.set_level(0)
                self.waveform.set_spectrum([0.0] * self.waveform.BAR_COUNT)
            elif state == "loading":
                self._asr_visual_active = False
                if self._call_state in {
                        VoiceCallState.DIALING,
                        VoiceCallState.RESTORING_MIC}:
                    self.append_status("正在加载语音识别模型...")
            elif state == "listening":
                self._asr_visual_active = False
                if self._call_state == VoiceCallState.DIALING:
                    self._complete_voice_connection()
                elif self._call_state == VoiceCallState.RESTORING_MIC:
                    self._complete_microphone_restore()
            elif state == "idle":
                self._asr_visual_active = False
            elif state.startswith("error:"):
                self._asr_visual_active = False
                message = state[6:]
                if self._call_state == VoiceCallState.DIALING:
                    self._fail_voice_call(message)
                elif self._call_state == VoiceCallState.RESTORING_MIC:
                    self._mic_resources_ready = False
                    if self._initial_mic:
                        self._fail_voice_call(message)
                        return
                    self._set_call_state(VoiceCallState.MUTED)
                    self._voice_problem('microphone',message)
                    self._release_asr_after_mute(self._mic_generation)
                elif self._call_state == VoiceCallState.CONNECTED:
                    self._mic_generation += 1
                    self._set_call_state(VoiceCallState.MUTED)
                    self._voice_problem('microphone',message)
                    self._release_asr_after_mute(self._mic_generation)
                else:
                    self._voice_problem('dictation',message)
        except Exception:
            pass

    def _on_asr_result(self, text):
        """语音识别结果（主线程）：显示并发送给明日香"""
        if not text or self.dictation.active or self._call_state != VoiceCallState.CONNECTED:
            return
        if self._call_audio is not None:
            if self.relationship_view and self.relationship_view.defer_call_input(text):
                return
            self.voice_call_panel.status.setText('你　' + text)
            if self._chat_busy or self._waiting_for_backend or self._queued_asr is not None:
                if self._queued_asr is None:
                    self._queued_asr = {'session_id':(self._current_session or {}).get('id'),
                        'generation':self._call_generation,'text':text,'row':None,'call':True}
                else:
                    self._queued_asr['text'] += ' ' + text
                return
            if not self._start_chat(text):
                self.voice_call_panel.status.setText('这次暂时没接上，可以继续说。')
            return
        if self._chat_busy or self._waiting_for_backend or self._queued_asr is not None:
            sid=(self._current_session or {}).get('id')
            queued=self._queued_asr
            if queued is None:
                queued={'session_id':sid,'generation':self._call_generation,'text':text,
                        'row':self.chat_display.add_message(f'🎤 {text}',is_user=True)}
                self._queued_asr=queued
            else:
                queued['text']+=' '+text
                queued['row'].raw_text='🎤 '+queued['text'];queued['row']._rebuild_bubbles()
            self._settings.setValue('voice/queued/'+str(sid),queued['text'])
            return
        # 显示用户说的话（气泡）
        row=self.chat_display.add_message(f"🎤 {text}", is_user=True)
        if not self._start_chat(text,user_row=row):
            self.chat_display._layout.removeWidget(row);row.hide();row.deleteLater()
            self._insert_dictation(text)

    def _start_chat(self, text, images=None, user_row=None,request_packet=None,restart_request_id=None,manual_retry=False):
        """启动对话线程（语音/文字共用）。忙时排队，避免并发冲突。"""
        # 忙时（上一条还在处理）提示，不等完成再发
        if self._closing or self._navigation_blocked:
            self.append_status('会话正在切换，输入已保留。')
            return False
        if getattr(self, '_chat_busy', False):
            self.append_status('上一条还在回复，输入已保留。')
            return False
        if self.backend_combo.currentData()!='local' and not self._selected_api_route() and not (request_packet or {}).get('api_connection'):
            self.chat_display.show_system_notice('请先配置模型连接。',on_settings=lambda:self._open_settings_section('模型服务'))
            return False
        from core.file_attachment import visible_file_message
        session=self._current_session or {}
        previous=None
        if request_packet is None:
            try:previous=self._pending_store.load(session.get('id'))
            except (OSError,ValueError):pass
        packet=request_packet or {'request_id':str(uuid.uuid4()),'session_id':session.get('id'),'session_path':session.get('path'),
            'empty_session':not session.get('path'),'message':text,'images':images or [],**self._personality_options(),
            'display_text':user_row.raw_text if user_row else visible_file_message(text),'image_path':getattr(user_row,'_image_path',None)}
        if request_packet is None and self.relationship_view:
            packet['group_id']=self._relationship_call_group_id if packet.get('call_language') else self._relationship_group_id
            if packet.get('call_language') and self._active_call_id:packet['call_id']=self._active_call_id
        if request_packet is None and self.backend_combo.currentData()!='local':
            ref=self._connection_ref(self._selected_api_route())
            if ref:packet['api_connection']=ref
        packet['cancelled']=False
        if self.relationship_view and user_row is not None:
            user_row.request_id = packet['request_id']
            self.relationship_view.attach_row(user_row)
        if packet.get('session_id') and not self._prepare_request_route(packet):return False
        try:self._pending_store.save(packet)
        except (OSError,ValueError) as error:
            record_failure(failure_from_exception(error),stage='pending-save')
            self.chat_display.show_system_notice('暂时无法保存，输入仍留在本页。')
            return False
        if not packet.get('session_id'):
            self._failed_packet=packet;self._failed_row=user_row;self._waiting_for_backend=True
            self.chat_display.show_system_notice('正在连接，消息已保留。')
            self.auto_start();self._update_composer_actions();return True
        self._show_pending_session('语音通话' if packet.get('call_language') else text)
        self._active_chat_kind = "user"
        self._last_user_message = text
        self._chat_user_row = user_row
        self._chat_busy = True
        self._chat_started_at = timer()
        self.reset_stream()
        self._begin_reply_feedback()
        self._update_composer_actions()
        self._chat_thread = ChatThread(
            self.manager, text, images=images,
            request_id=packet['request_id'],session_id=packet.get('session_id'),
            **{k:packet[k] for k in ('personality_mode','personality_state_scope','voice_enabled','voice_preset','voice_turn','voice_planner','call_language') if k in packet})
        self._chat_thread.request_packet=packet;self._chat_thread.pending_store=self._pending_store;self._chat_thread.user_row=user_row
        if self.immediate_followup:
            if request_packet is None and not manual_retry:
                self.immediate_followup.begin(self._chat_thread)
            else:
                self.immediate_followup.cancel('retry')
        self._bind_call_reply(self._chat_thread)
        self._chat_thread.restart_request_id=restart_request_id
        self._chat_thread.manual_retry=manual_retry
        self._chat_thread.previous_pending=previous
        self._chat_thread.prior_reply.connect(lambda data,owner=self._chat_thread:self._restore_prior_reply(data,owner))
        self._chat_thread.result.connect(lambda speech,translation,owner=self._chat_thread:self._receive_chat_reply(speech,translation,owner))
        self._chat_thread.failed.connect(lambda problem,owner=self._chat_thread:self._on_chat_failure(problem,owner))
        self._chat_thread.tts_data.connect(lambda data,owner=self._chat_thread:self._on_tts_data(data,owner))
        self._chat_thread.status.connect(self.append_status)
        self._chat_thread.finished_tts.connect(lambda ok,owner=self._chat_thread:self._chat_done(ok) if owner is self._chat_thread else None)
        self._chat_thread.progress.connect(lambda data, owner=self._chat_thread: self._on_chat_progress(data, owner))
        self._chat_thread.start()
        return True

    def _chat_done(self, succeeded=True):
        if self._closing:return
        """对话线程结束"""
        if getattr(getattr(self,'_chat_thread',None),'saved_after_stop',False):
            succeeded=True
        elif getattr(getattr(self,'_chat_thread',None),'cancel_requested',False):
            succeeded=False
            if not self._reply_failure and not getattr(self._chat_thread,'call_interrupted',False):
                self._on_chat_failure(chat_failure('用户取消',code='CHAT_CANCELLED')['failure'],self._chat_thread)
        self._chat_busy = False
        if succeeded and getattr(getattr(self,'_chat_thread',None),'request_packet',None):
            try:self._pending_store.clear(self._chat_thread.session_id,self._chat_thread.request_id)
            except (OSError,ValueError) as error:record_failure(failure_from_exception(error),stage='pending-clear')
        if succeeded:self._failed_packet=None;self._failed_row=None;self._failed_problem={}
        if getattr(self, '_api_config_pending', False): self._apply_pending_api()
        self._finish_reply_feedback(succeeded)
        status = self.status_label.text()
        if not status or status == '正在处理消息…' or status.startswith(('请先停止当前回复', '已请求停止当前回复')):
            if succeeded:
                self.status_label.clear();self.status_label.hide()
            elif not getattr(self,'_reply_failure',False):self.append_status('本轮已停止，消息内容已保留')
        if self._chat_started_at is not None:
            latency.record("llm_complete", elapsed_ms(self._chat_started_at))
            self._chat_started_at = None
        pending_id = getattr(self, "_pending_session_id", None)
        if pending_id:
            # 此时后端已经写入首轮消息，用正式路径和标题替换临时项。
            self._load_sessions(preferred_id=pending_id)
        self._speak_full()
        self._active_chat_kind = None
        self._continue_voice_queue()
        if self.relationship_view: self.relationship_view.finish_turn()
        self._update_composer_actions()
        self._request_context_usage()
        if self._queued_asr is not None:
            drain=succeeded or getattr(self._chat_thread,'call_interrupted',False)
            QTimer.singleShot(0,lambda:self._drain_queued_asr(drain))
        if self._call_audio and self._call_audio.target==getattr(self._chat_thread,'request_id',None):
            if not self._tts_queue and not (getattr(self,'speak_thread',None) and self.speak_thread.isRunning()):
                self._call_audio.finish(self._call_audio.target)

    def _show_pending_session(self, first_message):
        """首条消息发送时立即把新会话显示在左侧。"""
        if self.relationship_view: return
        session_id = getattr(self, "_pending_session_id", None)
        if not session_id:
            return
        title = str(first_message).strip().replace("\n", " ") or "新对话"
        if len(title) > 32:
            title = title[:32] + "…"
        for row, session in enumerate(self._sessions):
            if session.get("id") == session_id:
                if session.get("title") in (None, "", "新对话"):
                    session["title"] = title
                    self.session_list.item(row).setText(title)
                self.session_list.setCurrentRow(row)
                self._current_session = session
                return
        pending = {
            "id": session_id,
            "path": None,
            "title": title,
            "pending": True,
        }
        self._sessions.insert(0, pending)
        self.session_list.insertItem(0, title)
        self.session_list.setCurrentRow(0)
        self._current_session = pending

    def _select_chat_image(self):
        """原图片入口现在统一选择文件，保持既有控件接线。"""
        from PyQt6.QtWidgets import QFileDialog

        paths, _ = QFileDialog.getOpenFileNames(self, "上传文件", "", "所有文件 (*)")
        if paths:self._attach_chat_files(paths)

    def _attach_chat_image(self, path, show_error=True):
        return self._attach_chat_files([path])

    def _attach_chat_files(self, paths):
        from core.file_attachment import FilePreparation
        if self._file_worker and self._file_worker.isRunning():
            self.append_status('正在解析文件，请稍候');return False
        if len(self._pending_files)+len(paths)>8:
            QMessageBox.warning(self,'文件过多','每条消息最多8个文件');return False
        generation=self._attachment_generation
        worker=FilePreparation(paths,getattr(self,'_attachment_vision',False),self)
        self._file_worker=worker
        worker.prepared.connect(lambda files,errors:self._files_prepared(files,errors,generation))
        worker.start();self.append_status('正在本地解析文件…');return True

    def _files_prepared(self,files,errors,generation):
        if generation!=self._attachment_generation:return
        self._pending_files.extend(files);self._refresh_file_label()
        if errors:QMessageBox.warning(self,'部分文件未加入','\n'.join(errors))
        if files:self.append_status('已加入文件：'+ '；'.join(f["name"]+' — '+f['note'] for f in files))

    def _refresh_file_label(self):
        files=self._pending_files
        self.attachment_label.setText(f'附件 {len(files)} 个' if files else '')
        self.attachment_label.setToolTip('\n'.join(f['name']+'：'+f['note'] for f in files))
        self.attachment_label.setVisible(bool(files));self.clear_attachment_btn.setVisible(bool(files))
        self._update_composer_actions()

    def _remove_chat_file(self):
        if len(self._pending_files)<=1:self._clear_chat_image();return
        menu=QMenu(self)
        for index,file in enumerate(self._pending_files):
            menu.addAction('移除 '+file['name'],lambda checked=False,i=index:self._remove_file_at(i))
        menu.addSeparator();menu.addAction('移除全部',self._clear_chat_image)
        menu.exec(self.clear_attachment_btn.mapToGlobal(self.clear_attachment_btn.rect().bottomLeft()))

    def _remove_file_at(self,index):
        self._pending_files.pop(index);self._refresh_file_label()

    @staticmethod
    def _local_drop_paths(event):
        mime = event.mimeData()
        if not mime or not mime.hasUrls():
            return []
        return [url.toLocalFile() for url in mime.urls()
                if url.isLocalFile() and url.toLocalFile()]

    def _accept_image_drop(self, event):
        paths = self._local_drop_paths(event)
        if paths:
            event.acceptProposedAction()
            return True
        return False

    def _accept_client_drop(self, event):
        return self._accept_image_drop(event)

    def _handle_client_drop(self, event):
        return self._handle_image_drop(event)

    def _handle_image_drop(self, event):
        paths = self._local_drop_paths(event)
        if paths:
            self._attach_chat_files(paths)
            event.acceptProposedAction()
            return True
        return False

    def dragEnterEvent(self, event):
        if not self._accept_client_drop(event):
            super().dragEnterEvent(event)

    def dropEvent(self, event):
        if not self._handle_client_drop(event):
            super().dropEvent(event)

    def eventFilter(self, watched, event):
        if (event.type()==QEvent.Type.InputMethod and getattr(self,'immediate_followup',None)
                and watched in (self.input_box,self.input_box.viewport()) and (event.preeditString() or event.commitString())):
            self.immediate_followup.cancel('new_input')
        # 输入框原本会把 file:///... 当文字插入；聊天区的 viewport
        # 又会吞掉主窗口事件，所以三处统一分流人格图与普通文件附件。
        if event.type() == QEvent.Type.DragEnter:
            if self._accept_client_drop(event):
                return True
        elif event.type() == QEvent.Type.Drop:
            if self._handle_client_drop(event):
                return True
        return super().eventFilter(watched, event)

    def resizeEvent(self, event):
        super().resizeEvent(event)

    def _clear_chat_image(self):
        self._pending_files = []
        self._attachment_generation = getattr(self,'_attachment_generation',0)+1
        if getattr(self,'_file_worker',None) and self._file_worker.isRunning():self._file_worker.requestInterruption()
        if hasattr(self, "attachment_label"):
            self.attachment_label.clear()
            self.attachment_label.setVisible(False)
        if hasattr(self, "clear_attachment_btn"):
            self.clear_attachment_btn.setVisible(False)
        self._update_composer_actions()

    def send_message(self):
        if self.dictation.active:
            if self.dictation.state in {'listening','recording','transcribing'}:
                self.dictation.finish()
            self.append_status('听写完成后可确认发送')
            return
        from core.file_attachment import file_message,visible_file_message
        text = self.input_box.text().strip()
        files = self._pending_files
        if self._file_worker and self._file_worker.isRunning():
            self.append_status('文件正在解析，完成后再发送');return
        if not text and not files:
            return
        if getattr(self, "_chat_busy", False) or self._waiting_for_backend or self._queued_asr is not None:
            self.append_status("上一条仍在回复，请稍后再发送")
            return
        if not self._apply_pending_api(): return
        try:
            prompt,images=file_message(text,files)
            if images and not getattr(self,'_attachment_vision',False):raise ValueError('附件包含图像，请切换视觉模型或移除后重新上传文件')
        except ValueError as e:
            QMessageBox.warning(self,'附件无法发送',str(e));return
        display_text = visible_file_message(prompt)
        user_row=self.chat_display.add_message(
            display_text, is_user=True,
            image_path=next((f['path'] for f in files if f['is_image']),None))
        if self._start_chat(prompt, images=images or None,user_row=user_row):
            self.input_box.clear();self._clear_chat_image()
        else:
            self.chat_display._layout.removeWidget(user_row);user_row.hide();user_row.deleteLater()

    def _on_tts_data(self, data, owner=None):
        """收到 TTS 结构化数据（pauses）"""
        if owner is not None and (owner is not self._chat_thread or self._closing or owner.cancel_requested or getattr(owner,'saved_after_stop',False)):return
        receipt = data.get('quality_receipt')
        supported = can_read_reply(data.get('speech') or '', data.get('language'), data.get('voice_preset'))
        if self.immediate_followup and owner is not None:
            if supported:
                self.immediate_followup.parent_reply(owner,data)
            else:
                self.immediate_followup.cancel('text_only_language')
        mode = getattr(getattr(self,'_chat_thread',None),'personality_mode','light')
        if data.get('analysis_complete') is True or data.get('degraded_continuity') or (mode=='light' and bool(data.get('speech'))):
            self._mark_user_read()
        self._tts_playback_id = data.get('playback_id')
        row = getattr(self, '_last_reply_row', None)
        if row is not None:
            if data.get('degraded_continuity'):
                row.setToolTip('本条为简化回复，未更新人格状态。')
                self.append_status('本条为简化回复')
            self._bind_replay_row(row, self._tts_playback_id)
            if data.get('parts'):row.set_reply_parts(data['parts'])
        self._tts_voice_preset = data.get('voice_preset')
        self._tts_voice_expression = data.get('voice_expression')
        if (not supported or data.get('voice_error') or not self._call_voice_valid(owner)
                or (data.get('quality_mode') and not self._tts_voice_preset and data.get('voice_backend')!='multilingual')):
            self._pending_tts = False
            if row is not None:row.finish_delivery()
            if data.get('voice_error'):
                self._voice_problem('preparation',data['voice_error'])
        self._tts_pauses = data.get("pauses") or []
        self._tts_language = data.get('language')
        self._tts_diagnostic_context = {
            "user_message": getattr(self, "_last_user_message", ""),
            "emotion": data.get("emotion", ""),
            "action": data.get("action", ""),
            "tone": data.get("tone", ""),
            "brain_language": data.get("language", ""),
        } if self.development else {}
        if data.get('voice_turn')==SINGLE_VOICE:
            self._tts_diagnostic_context['voice_turn']=SINGLE_VOICE
        if receipt:
            self._tts_diagnostic_context['quality_identity'] = {'session': receipt['session'], 'turn': receipt['turn']}
        if self._call_audio is not None and self._call_voice_valid(owner):
            self._speak_full()

    def _acknowledge_delivery(self,receipt):
        if not receipt:return
        def delivered():
            try:
                response=self.manager.brain.request('POST','/general/delivery',receipt,timeout=180)
                if response.get('error'):record_failure({'code':'DELIVERY_PENDING','detail':response['error']},stage='delivery')
            except Exception as error:record_failure(failure_from_exception(error),stage='delivery')
        self._delivery_threads={t for t in self._delivery_threads if t.is_alive()}
        worker=threading.Thread(target=delivered,name='reply-delivery',daemon=True)
        self._delivery_threads.add(worker);worker.start()

    def _speak_full(self):
        """把完整回复放入通话语音队列；拨号中只排队，不抢跑播放。"""
        if not getattr(self, '_pending_tts', False):
            return
        self._pending_tts = False
        if (self._call_state not in ACTIVE_CALL_STATES
                or not self.voice_check.isChecked() or not self.tts.enabled):
            if self._pending_tts_row is not None:self._pending_tts_row.finish_delivery()
            return
        full = getattr(self, '_stream_buf', '')
        if not full.strip():
            return
        self._tts_queue.append({
            "text": full,
            "row": getattr(self, '_pending_tts_row', None),
            "pauses": list(getattr(self, '_tts_pauses', []) or []),
            "language": getattr(self, '_tts_language', None),
            "voice_preset": getattr(self, '_tts_voice_preset', None),
            "voice_expression": getattr(self, '_tts_voice_expression', None),
            'playback_id': getattr(self, '_tts_playback_id', None),
            "diagnostic_context": dict(getattr(
                self, '_tts_diagnostic_context', {}) or {}),
            "generation":self._call_generation,
            "parent_followup":getattr(self._chat_thread,'followup_turn',None),
            "call_reply":getattr(self._chat_thread,'request_id',None) if self._call_audio else None,
            "subtitle":self._reply_caption or getattr(self._pending_tts_row,'_translation','') or '',
        })
        self._play_next_tts()

    def _play_followup(self,job):
        item, line = job.item, job.item['behavior']
        row = None
        if job.call:
            self._call_audio.expect(item['request_id'])
        else:
            from ui.widgets import ChatMessageRow
            row=next((r for r in self.chat_display.widget().findChildren(ChatMessageRow)
                      if not r.is_user and getattr(r,'request_id',None)==item['request_id']),None)
            if row is None:
                row=self.chat_display.add_message(line['speech'],translation=line.get('translation'),avatar_path=self._asuka_avatar,
                    parts=line.get('parts'),voice_reveal=self.voice_reveal_check.isChecked())
                row.request_id=item['request_id']
                self.relationship_view.attach_row(row)
            self._bind_replay_row(row,item['playback_id'])
            row.configure_voice(job.audio.segments,clean_for_tts,live=self.voice_reveal_check.isChecked())
        self._tts_queue.append({'text':line['speech'],'row':row,'pauses':[],'diagnostic_context':{},
            'language':line['language'],'voice_preset':job.voice.preset,'playback_id':item['playback_id'],
            'generation':self._call_generation,'call_reply':item['request_id'] if job.call else None,
            'subtitle':line.get('translation',''),'child_followup':job})
        self._play_next_tts()

    def _play_next_tts(self):
        if self._closing or self._delete_worker is not None or self.dictation.active:return
        if (self._call_state not in TTS_PLAYBACK_STATES
                or not self._call_audio_ready
                or not self.voice_check.isChecked() or not self.tts.enabled
                or not self._tts_queue):
            return
        active = getattr(self, "speak_thread", None)
        if ((active is not None and active.isRunning())
                or self.tts.is_speaking):
            return
        task = self._tts_queue.popleft()
        if (task.get('generation',self._call_generation)!=self._call_generation or
                task.get('call_reply') and (not self._call_audio or task['call_reply']!=self._call_audio.target)):
            job=task.get('parent_followup') or task.get('child_followup')
            if job and self.immediate_followup and self.immediate_followup.current is job:
                self.immediate_followup.cancel('stale_playback')
            if task.get('row') is not None:
                from PyQt6 import sip
                if not sip.isdeleted(task['row']):
                    task['row'].finish_delivery()
            QTimer.singleShot(0,self._play_next_tts)
            return
        playback_row = task["row"]
        self._active_tts_row = playback_row
        self.speak_thread = SpeakThread(
            self.tts, task["text"], pauses=task["pauses"],
            diagnostic_context=task["diagnostic_context"],
            language=task.get('language'),
            voice_preset=task.get('voice_preset'),
            voice_expression=task.get('voice_expression'),
            playback_id=task.get('playback_id'),
            on_play_start=lambda: self.asr.set_paused(True),
            on_play_end=lambda row=playback_row: (
                self.asr.set_paused(False),
                self.tts_playback_end_sig.emit(row)),
        )
        if self.development:
            self.speak_thread.diagnostic_ready.connect(
                lambda diagnostic, row=playback_row:
                self._on_tts_diagnostic(row, diagnostic))
        self.speak_thread.call_reply=task.get('call_reply')
        child = task.get('child_followup')
        parent = task.get('parent_followup')
        self.speak_thread.child_followup = child
        if child is not None:
            asr = self.asr
            self.speak_thread.child_start_allowed = lambda: child.can_start() and (not child.call or not getattr(asr,'_current_speech',False))
        if parent and self.immediate_followup and self.immediate_followup.current is parent:
            self.speak_thread.parent_followup = parent
            self.speak_thread.voice_generated.connect(lambda voice:self.immediate_followup.generated(parent,voice))
        chinese = str(task.get('language')).lower() in ('zh','zh-cn','chinese')
        self.speak_thread.call_caption = task['text'] if chinese else task.get('subtitle') or '中文字幕暂不可用'
        self.speak_thread.call_original = '' if chinese else task['text']
        if self._call_audio:self._call_audio.speaking(task.get('call_reply'),task['text'],task.get('subtitle',''))
        self.speak_thread.finished.connect(self._continue_voice_queue)
        self.speak_thread.playback_error.connect(lambda problem,owner=self.speak_thread:self._on_playback_problem(problem,owner))
        self.speak_thread.audio_saved.connect(lambda message_id, row=playback_row: self._bind_replay_row(row, message_id))
        self._wire_speech_delivery(self.speak_thread,playback_row,live=True)
        self.speak_thread.start()

    def _wire_speech_delivery(self, owner, row, *, live):
        self._audio_delivery_owner = owner
        child = getattr(owner,'child_followup',None)
        owner.call_stop = child.stop if child is not None else threading.Event()
        channel = self._call_audio
        token = getattr(owner, 'call_reply', None)
        def render(output, rate):
            if owner.call_stop.is_set():
                output.fill(0)
                return
            if channel is not None:
                channel.render_for(token, output, rate)
                if not token or token != channel.target:
                    return
            first = owner.progress.first_output is None
            owner.progress.rendered(len(output), rate)
            if first and getattr(owner,'parent_followup',None) is not None:
                self.immediate_followup.mark(owner.parent_followup,'parent_first_pcm')
            if child is not None and not child.child_started:
                child.child_started = True
                self.immediate_followup.mark(child,'second_first_pcm')
        owner.call_render = render
        if channel is not None:
            owner.on_play_start=None
            owner.on_play_end=lambda:self.tts_playback_end_sig.emit((owner,row))
        else:
            owner.on_play_end=lambda:(self.asr.set_paused(False),self.tts_playback_end_sig.emit((owner,row)))
        owner.segments_ready.connect(lambda segments:self._speech_delivery_event(owner,row,'plan',segments,live))
        owner.segment_playing.connect(lambda segment:self._speech_delivery_event(owner,row,'segment',segment,live))
        owner.audio_drained.connect(lambda:self._speech_delivery_event(owner,row,'drained',None,live))
        owner.finished.connect(lambda:self._speech_delivery_event(owner,row,'end',None,live))
        if live and row is not None and row._voice_reveal:
            self._reveal_timer.start()

    def _tick_voice_reveal(self):
        from PyQt6 import sip
        owner = getattr(self, '_audio_delivery_owner', None)
        row = self._active_tts_row
        if owner is None or row is None or sip.isdeleted(row) or not row._voice_reveal:
            self._reveal_timer.stop()
            return
        index, fraction, _ = owner.progress.position()
        row.audio_progress(index, fraction)

    def _speech_delivery_event(self, owner, row, kind, value, live):
        from PyQt6 import sip
        if self._closing:return
        if owner is not getattr(self,'_audio_delivery_owner',None):return
        has_row = row is not None and not sip.isdeleted(row)
        token = getattr(owner,'call_reply',None)
        if kind=='plan':
            if has_row:row.configure_voice(value,clean_for_tts,live=live and self.voice_reveal_check.isChecked())
        elif kind=='segment':
            if has_row:row.audio_segment(value)
            if token and self._call_audio and token==self._call_audio.target:
                self.voice_call_panel.status.clear()
                self.voice_call_panel.set_caption(owner.call_caption, getattr(owner, 'call_original', ''))
        else:
            self._reveal_timer.stop()
            if has_row:row.finish_delivery()
            child = getattr(owner,'child_followup',None)
            if child and not owner.output_drained and self.immediate_followup.current is child:
                self.immediate_followup.cancel('audio_failed')
            if token and self._call_audio and token==self._call_audio.target:
                self._call_audio.finish(token)
                self.voice_call_panel.finish_caption()
            if self.immediate_followup:
                parent = getattr(owner,'parent_followup',None)
                if parent: self.immediate_followup.parent_audio_end(parent,owner)
                if child:
                    if owner.output_drained: self.immediate_followup.child_end(child)

    def _finish_message_delivery(self):
        self._reveal_timer.stop()
        self._audio_delivery_owner = None
        if self.relationship_view:
            from PyQt6 import sip
            rows = [self._active_tts_row, getattr(self,'_pending_tts_row',None),
                    *(task.get('row') for task in self._tts_queue)]
            for row in rows:
                if row is not None and not sip.isdeleted(row) and not self.chat_display.isAncestorOf(row):
                    row.finish_delivery()
        self.chat_display.finish_deliveries()

    def _leave_voice_transcript(self):
        if self.immediate_followup: self.immediate_followup.cancel('navigation')
        self._stash_queued_asr()
        self._failed_chat=None;self._failed_packet=None;self._failed_row=None;self._failed_problem={}
        self._waiting_for_backend=False
        self._finish_message_delivery()
        self._pending_tts = False
        self._tts_queue.clear()
        self.tts.stop()
        self._pending_client_event = None
        self._pending_mic_event = None
        self._mic_event_timer.stop()
        if self._call_audio is not None and self._call_state in ACTIVE_CALL_STATES:
            self._hang_up_voice_call()

    def _draft_key(self,sid=None):
        if self.relationship_view:
            session = sid or (self._current_session or {}).get('id','unbound')
            return 'relationship/drafts/'+session+'/'+(self._relationship_group_id or 'all')
        return 'chat/draft/'+str(sid if sid is not None else (self._current_session or {}).get('id','unbound'))

    def _save_draft(self):
        if not self._draft_loading:self._settings.setValue(self._draft_key(),self.input_box.text())

    def _restore_draft(self):
        sid=(self._current_session or {}).get('id')
        text=str(self._settings.value(self._draft_key(sid),'') or '')
        if sid:
            unbound_key = self._draft_key('unbound') if self.relationship_view else 'chat/draft/unbound'
            unbound=str(self._settings.value(unbound_key,'') or '')
            if unbound:
                text=(text+' '+unbound).strip()
                self._settings.remove(unbound_key)
        queued=str(self._settings.value('voice/queued/'+str(sid),'') or '')
        if queued:text=(text+' '+queued).strip();self._settings.remove('voice/queued/'+str(sid))
        self._draft_loading=True
        try:self.input_box.setText(text)
        finally:self._draft_loading=False
        self._save_draft()

    def _stash_queued_asr(self):
        queued=self._queued_asr;self._queued_asr=None
        if queued is None:return
        if queued.get('call'):
            return
        sid=queued['session_id'];key=self._draft_key(sid)
        draft=str(self._settings.value(key,'') or '')
        self._settings.setValue(key,(draft+' '+queued['text']).strip())
        self._settings.remove('voice/queued/'+str(sid))
        from PyQt6 import sip
        row=queued['row']
        if not sip.isdeleted(row):self.chat_display._layout.removeWidget(row);row.hide();row.deleteLater()
        if sid==(self._current_session or {}).get('id'):
            self._restore_draft();self.append_status('补充的语音已放回输入框。')

    def _drain_queued_asr(self,succeeded):
        if self._closing:return
        queued=self._queued_asr
        if queued is None or self._chat_busy:return
        if not succeeded or queued['generation']!=self._call_generation or queued['session_id']!=(self._current_session or {}).get('id') or self._call_state not in ACTIVE_CALL_STATES:
            self._stash_queued_asr();return
        self._queued_asr=None
        if self._start_chat(queued['text'],user_row=queued['row']):
            if not queued.get('call'):
                self._settings.remove('voice/queued/'+str(queued['session_id']))
        else:self._queued_asr=queued;self._stash_queued_asr()

    def _continue_voice_queue(self):
        if self._closing:return
        active = getattr(self, "speak_thread", None)
        if active is not None and active.isRunning():
            return
        self._play_next_tts()
        active = getattr(self, "speak_thread", None)
        if (not self._tts_queue
                and not self.tts.is_speaking
                and (active is None or not active.isRunning())):
            self._drain_client_event()

    def _receive_chat_reply(self, speech, translation, owner):
        if owner is not self._chat_thread or self._closing or owner.cancel_requested or getattr(owner,'saved_after_stop',False):return
        valid=self._call_voice_valid(owner)
        if getattr(owner,'call_language',None):
            self._reply_received = True
            if not self._call_audio or not valid:
                return
            self._stream_buf = speech
            chinese = str(owner.call_language).lower() in ('zh','zh-cn','chinese')
            self._reply_caption = speech if chinese else translation or '中文字幕暂不可用'
            self._pending_tts = bool(owner.voice_enabled and self.voice_check.isChecked() and not owner.reply_data.get('voice_error')
                                     and can_read_reply(speech,owner.reply_data.get('language'),owner.reply_data.get('voice_preset')))
            self._pending_tts_row = None
            self._last_reply_row = None
            if not self._pending_tts:
                self.voice_call_panel.set_caption(self._reply_caption, '' if chinese else speech)
            return
        self.show_reply(speech,translation,data=owner.reply_data,voice_expected=valid and owner.voice_enabled and not owner.cancel_requested)
        self._last_reply_row.request_id=owner.request_id

    def _restore_prior_reply(self,data,owner):
        if owner is not self._chat_thread or self._closing or owner.cancel_requested:return
        from ui.widgets import ChatMessageRow
        previous_id=owner.prior_request_id or (owner.previous_pending or {}).get('request_id')
        present=any(not row.is_user and (getattr(row,'request_id',None)==previous_id or
            data.get('playback_id') and row.playback_id==data['playback_id']) for row in self.chat_display.widget().findChildren(ChatMessageRow))
        matching_group = not self.relationship_view or self.relationship_view.accepts(owner.previous_pending or {})
        if data.get('speech') and not present and matching_group and data.get('surface')!='call':
            row=self.chat_display.add_message(data['speech'],avatar_path=self._asuka_avatar,translation=data.get('translation'),
                parts=data.get('parts'),before_row=owner.user_row)
            self._bind_replay_row(row,data.get('playback_id'))
            row.request_id=previous_id
            if self.relationship_view: self.relationship_view.attach_row(row)
        self._acknowledge_delivery(data.get('quality_receipt'))

    def _on_chat_failure(self, problem, owner):
        if owner is not self._chat_thread or self._closing or getattr(owner,'saved_after_stop',False):return
        if self.immediate_followup and self.immediate_followup.current is getattr(owner,'followup_turn',None):
            self.immediate_followup.cancel('parent_failed')
        if getattr(owner,'call_interrupted',False) and problem.get('code')=='CHAT_CANCELLED':
            self.chat_display.clear_typing()
            return
        record_failure(problem,request_id=getattr(owner,'request_id',None))
        self._reply_failure=True
        self.chat_display.clear_typing()
        if problem.get('analysis_complete'):self._mark_user_read()
        self.status_label.clear();self.status_label.hide()
        if owner.client_event is not None:
            self.append_status('语音状态暂未同步，聊天仍可继续。')
            return
        self._failed_chat=owner
        self._failed_packet=owner.request_packet
        self._failed_row=owner.user_row or self._chat_user_row
        self._failed_problem=problem
        if owner.request_packet:
            owner.request_packet.update(failure_code=problem.get('code'),recovery_request_id=problem.get('recovery_request_id'),
                                        analysis_complete=bool(problem.get('analysis_complete') or owner.request_packet.get('analysis_complete')),failure_retryable=problem.get('retryable',True),failure_closed=bool(problem.get('failure_closed')))
            try:self._pending_store.save(owner.request_packet)
            except (OSError,ValueError) as error:record_failure(failure_from_exception(error),stage='pending-failure-save')
        if getattr(owner,'call_language',None):
            if self.voice_call_panel.active and self._call_voice_valid(owner):
                self.voice_call_panel.status.setText('这次暂时没接上，可以继续说。')
            return
        self.chat_display.show_system_notice(failure_message(problem),
            on_retry=self._retry_failed_reply if problem.get('retryable',True) else None,
            on_settings=lambda:self._open_settings_section('模型服务'))

    def _retry_failed_reply(self):
        if self._chat_busy or not self._failed_packet:return
        if self._failed_packet.get('call_language') and not self.voice_call_panel.active:return
        packet=dict(self._failed_packet);problem=getattr(self,'_failed_problem',{})
        if 'api_connection' not in packet and self.backend_combo.currentData()!='local':
            route=self._selected_api_route()
            profile=(route or {}).get('profile') or {}
            if profile.get('connection_id'):
                decision=QMessageBox.question(self,'选择旧消息的连接',
                    f'这条旧消息没有保存连接信息。使用当前连接「{profile["name"]}」重试？',
                    QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.Cancel,QMessageBox.StandardButton.Cancel)
                if decision!=QMessageBox.StandardButton.Yes:return
                packet['api_connection']=self._connection_ref(route)
        code=problem.get('code','');restart=None
        if packet.get('failure_closed'):
            packet['request_id']=str(uuid.uuid4());packet['failure_closed']=False
        elif code=='PREVIOUS_REQUEST_PENDING':restart=problem.get('recovery_request_id')
        elif packet.get('personality_mode') in QUALITY_MODES and (packet.get('cancelled') or code in {'SyntaxError','CHAT_CANCELLED'}
            or code.startswith(('IDENTITY_','FAST_','FACT_','FRAME_','MALFORMED_','UNSUPPORTED_'))):
            restart=problem.get('recovery_request_id') or packet['request_id']
        self._start_chat(packet['message'],images=packet.get('images'),user_row=self._failed_row,
                         request_packet=packet,restart_request_id=restart,manual_retry=True)

    def _restore_pending(self, server_pending=None, user_row=None, answered=None):
        session=self._current_session or {};sid=session.get('id')
        try:packet=self._pending_store.load(sid) or server_pending or self._pending_store.load(None)
        except (OSError,ValueError) as error:
            record_failure(failure_from_exception(error),stage='pending-read');return
        if not packet:return
        if self.relationship_view and not self.relationship_view.accepts(packet):
            return
        if packet.get('session_id') is None and sid:
            packet={**packet,'session_id':sid,'session_path':session.get('path'),'empty_session':not session.get('path')}
            try:
                self._pending_store.save(packet);self._pending_store.clear(None,packet['request_id'])
            except (OSError,ValueError) as error:record_failure(failure_from_exception(error),stage='pending-bind')
        if packet.get('request_id') in (answered or set()):
            try:self._pending_store.clear(sid,packet['request_id'])
            except (OSError,ValueError) as error:record_failure(failure_from_exception(error),stage='pending-clear')
            return
        from core.file_attachment import visible_file_message
        if packet.get('call_language'):
            return
        display=packet.get('display_text') or visible_file_message(packet['message'])
        if user_row is None or getattr(user_row,'request_id',None)!=packet['request_id']:
            user_row=self.chat_display.add_message(display,is_user=True,image_path=packet.get('image_path'))
        user_row.request_id=packet['request_id']
        user_row.set_read(bool(packet.get('analysis_complete')))
        self._failed_packet=packet;self._failed_row=user_row
        self._failed_problem={'code':packet.get('failure_code',''),'recovery_request_id':packet.get('recovery_request_id'),
                              'retryable':packet.get('failure_retryable',True),'failure_closed':bool(packet.get('failure_closed'))}
        self.chat_display.show_system_notice('上次的消息已保留，可继续处理。' if self._failed_problem['retryable'] else '原消息已保留，请检查后继续。',
            on_retry=self._retry_failed_reply if self._failed_problem['retryable'] else None)

    def _voice_problem(self, stage, detail):
        record_failure({'code':'VOICE_'+stage.upper(),'detail':str(detail)},stage=stage)
        self.append_status({'dictation':'语音输入暂不可用，已有文字已保留。','microphone':'麦克风暂时关闭，可以重试打开。',
            'call':'语音未接通，可以重新拨号。'}.get(stage,'本条暂时只有文字，聊天可以继续。'))

    def _on_playback_problem(self, problem, owner):
        if owner is not getattr(self,'speak_thread',None) or self._closing:return
        if getattr(owner,'call_stop',None) is not None and owner.call_stop.is_set():return
        record_failure(problem,stage='playback')
        token = getattr(owner,'call_reply',None)
        if token and self._call_audio and token==self._call_audio.target:
            self.voice_call_panel.set_caption(owner.call_caption, getattr(owner, 'call_original', ''))
            self.voice_call_panel.status.setText('本句语音暂不可用')
            return
        self.append_status({'AUDIO_SAVE_FAILED':'这条声音已播放，暂时不能回放。',
            'AUDIO_REPLAY_FAILED':'这条消息暂时无法回放。'}.get(problem.get('code'),'本条语音暂不可用，文字已保留。'))

    def show_reply(self, speech, translation="", *, data=None, voice_expected=None):
        data = data or {}
        self._reply_received = True
        self.chat_display.clear_typing()
        self.chat_display.clear_system_notice()
        if self.thinking_panel:
            self.thinking_panel.finish(True)
            if not self.thinking_panel.summary.text():
                self.chat_display.discard_thinking(self.thinking_panel)
                self.thinking_panel = None
        # UI 与 TTS 直接使用结构化字段，不再把翻译拼进正文后二次解析。
        if not hasattr(self, '_stream_buf'):
            self._stream_buf = ""
        self._stream_buf += speech
        supported = can_read_reply(speech,data.get('language'),data.get('voice_preset'))
        if speech and self._call_state in ACTIVE_CALL_STATES and self.voice_check.isChecked() and voice_expected is not False and not supported:
            self.append_status('本条以文字显示。其他语种的朗读可使用中日双语版。')
        will_read = bool(speech and self._call_state in ACTIVE_CALL_STATES and self.voice_check.isChecked()
                         and voice_expected is not False and not data.get('voice_error')
                         and supported
                         and (not data.get('quality_mode') or data.get('voice_preset') or data.get('voice_backend') == 'multilingual'))
        # 更新聊天框：明日香气泡 + 翻译块
        row = self.chat_display.add_message(
            speech, is_user=False,
            avatar_path=self._asuka_avatar, translation=translation, analysis_panel=self.thinking_panel,parts=data.get('parts'),
            voice_reveal=will_read and self.voice_reveal_check.isChecked())
        self._last_reply_row = row
        if self.relationship_view: self.relationship_view.attach_row(row)
        if self.development:
            row.diagnostic_requested.connect(self._open_tts_annotation)
        # 只有语音通话会话中的回复才进入朗读队列；拨号阶段可以先排队。
        if will_read:
            self._pending_tts = True
            self._pending_tts_row = row
            try:
                segments=prepare_synthesis(speech,data.get('pauses'),data.get('language'),data.get('voice_preset'))[3]
                if data.get('playback_id') and self.tts.audio_replay.enabled:
                    stored=self.tts.audio_replay.record(data['playback_id'])
                    if stored:segments=stored.get('generation',{}).get('segments',[])
            except (TypeError,ValueError,OSError):segments=[]
            row.configure_voice(segments,clean_for_tts,live=self.voice_reveal_check.isChecked())
        else:
            row.pace_text()

    def _bind_replay_row(self, row, message_id):
        from PyQt6 import sip
        if row is None or sip.isdeleted(row): return
        if not getattr(row, '_replay_connected', False):
            row.replay_requested.connect(self._replay_message)
            row._replay_connected = True
        available = False
        if message_id:
            try: available = self.tts.audio_replay.replayable(message_id)
            except (ValueError, OSError): pass
        row.set_replay(message_id, self.tts.audio_replay.enabled, available)

    def _toggle_audio_replay(self, enabled):
        self._settings.setValue('voice/message_replay', bool(enabled))
        self.tts.audio_replay.enabled = bool(enabled)
        if not enabled and self._replay_active: self.tts.stop()
        from ui.widgets import ChatMessageRow
        for row in self.chat_display.findChildren(ChatMessageRow):
            self._bind_replay_row(row, row.playback_id)

    def _replay_message(self, row):
        if self.immediate_followup: self.immediate_followup.cancel('replay')
        if self._closing or self._navigation_blocked or self._delete_worker is not None:return
        if not self.tts.audio_replay.enabled: return
        if self._call_audio and not self.voice_check.isChecked():
            self.append_status('开启角色语音后即可重听')
            return
        if self._call_audio and self._chat_busy:
            self.append_status('这轮回复结束后即可重听')
            return
        active = getattr(self, 'speak_thread', None)
        if active is not None and active.isRunning():
            self._finish_message_delivery()
            if getattr(active,'call_stop',None) is not None:active.call_stop.set()
            if self._call_audio:self._call_audio.finish(self._call_audio.target)
            self.tts.stop()
            self.append_status('已停止播放，再点头像即可回放')
            return
        self._replay_active = True
        self._update_composer_actions()
        self._active_tts_row = row
        self.append_status('正在恢复这条消息的原音…')
        self.speak_thread = SpeakThread(self.tts, row.raw_text, playback_id=row.playback_id, replay=True,
            on_play_start=lambda: self.asr.set_paused(True),
            on_play_end=lambda: (self.asr.set_paused(False), self.tts_playback_end_sig.emit(row)))
        if self._call_audio:
            token='replay:'+row.playback_id
            self._call_audio.expect(token)
            self._call_audio.speaking(token,row.raw_text,row._translation or '')
            self.speak_thread.call_reply=token
            self.speak_thread.call_caption=row._translation or row.raw_text
            self.speak_thread.call_original=row.raw_text if row._translation and row._translation != row.raw_text else ''
        self.speak_thread.playback_error.connect(lambda problem,owner=self.speak_thread:self._on_playback_problem(problem,owner))
        self.speak_thread.finished.connect(self._replay_finished)
        self._wire_speech_delivery(self.speak_thread,row,live=False)
        self.speak_thread.start()

    def _replay_finished(self):
        self._replay_active = False
        self._update_composer_actions()
        self._continue_voice_queue()

    def _on_tts_diagnostic(self, row, diagnostic):
        """将实际合成样本绑定到产生它的明日香气泡。"""
        if not self.development or row is None or not diagnostic:
            return
        try:
            row.set_diagnostic(diagnostic)
            sample_id = diagnostic.get("sample_id", "")
            row.report_button.setToolTip(
                f"异常样本 {sample_id}：点击补充人工标注")
        except RuntimeError:
            # 用户在合成期间切换/清空了会话，滚动缓存仍会自动过期。
            pass

    def _open_tts_annotation(self, row):
        """收集异常类型和备注，并把滚动样本固化为报告。"""
        if not self.development:
            return
        diagnostic = getattr(row, "diagnostic", None)
        if not diagnostic:
            self.append_status("⚠️ 该回复尚未生成可标注的语音样本")
            return

        dialog = ThemedDialog(self)
        dialog.setWindowTitle("标注 TTS 异常")
        dialog.setMinimumWidth(420)
        layout = dialog.body_layout
        layout.addWidget(QLabel(
            f"样本编号：{diagnostic.get('sample_id', '')}\n"
            "请选择听到的异常，可多选："))
        category_names = [
            "电音／金属感", "声音变低沉／男性化", "音色漂移",
            "断裂／卡顿／空白", "爆音／音量异常", "语速／韵律异常", "其他",
        ]
        category_checks = []
        for name in category_names:
            check = QCheckBox(name)
            layout.addWidget(check)
            category_checks.append(check)
        layout.addWidget(QLabel("补充备注（例如异常出现在第几句、切换了什么语气）："))
        note = QTextEdit()
        note.setPlaceholderText("可选，但越具体越利于复现和比较……")
        note.setFixedHeight(90)
        layout.addWidget(note)
        buttons = QDialogButtonBox(
            QDialogButtonBox.StandardButton.Save
            | QDialogButtonBox.StandardButton.Cancel)
        buttons.button(QDialogButtonBox.StandardButton.Save).setText("保存样本")
        buttons.accepted.connect(dialog.accept)
        buttons.rejected.connect(dialog.reject)
        layout.addWidget(buttons)

        while True:
            if dialog.exec() != QDialog.DialogCode.Accepted:
                return
            categories = [
                check.text() for check in category_checks if check.isChecked()]
            if categories:
                break
            QMessageBox.warning(
                dialog, "缺少异常类型", "请至少选择一种异常类型。")
        try:
            report_path = tts_diagnostics.annotate(
                diagnostic.get("sample_id"), categories, note.toPlainText())
            row.mark_diagnostic_submitted()
            self.diagnostics_page.refresh()
            self.append_status(
                f"✅ TTS 异常样本已保存：{diagnostic.get('sample_id')}")
            QMessageBox.information(
                self, "异常样本已保存",
                "样本已加入异常中心，后续检查会自动发现，"
                "无需再单独提供编号。\n\n"
                f"样本：{diagnostic.get('sample_id')}\n资料目录：\n{report_path}")
        except Exception as exc:
            QMessageBox.warning(self, "保存失败", str(exc))

    @staticmethod
    def _split_reply_translation(text):
        """拆分历史记录中的末尾翻译，支持翻译内部的嵌套括号。"""
        value = str(text).strip()
        depth = 0
        group_start = None
        final_group = None
        for index, char in enumerate(value):
            if char in "（(":
                if depth == 0:
                    group_start = index
                depth += 1
            elif char in "）)" and depth > 0:
                depth -= 1
                if depth == 0 and group_start is not None:
                    final_group = (group_start, index)
        if final_group and final_group[1] == len(value) - 1:
            start, end = final_group
            speech = value[:start].strip()
            if speech:
                return speech, value[start + 1:end].strip()
        return value, ""

    def reset_stream(self):
        self._finish_message_delivery()
        self._reply_received = False
        self._reply_failure = False
        self.chat_display.clear_system_notice()
        self.chat_display.clear_typing()
        self._last_reply_row = None
        """新一轮对话前清空流式累积"""
        self._stream_buf = ""
        self._reply_caption = ''
        self._pending_tts = False
        self._pending_tts_row = None
        self._tts_diagnostic_context = {}
        self._tts_language = None
        self._tts_voice_preset = None
        self._tts_voice_expression = None

    def append_status(self, msg):
        value = str(msg)
        shown=value.lstrip('🧠⚠️🟢🟡🔴✅⚪📞 ')
        self.status_label.setText(shown)
        self.status_label.setToolTip(str(msg) or '最近一次系统状态')
        self.status_label.setVisible(bool(msg))
        if "⚠" in value or "失败" in value or "错误" in value:
            level = "error"
        elif "🟡" in value or "正在" in value or "预加载" in value:
            level = "busy"
        elif "🟢" in value or "✅" in value or "就绪" in value:
            level = "ok"
        else:
            level = "info"
        self.status_label.setProperty("level", level)
        self.status_label.style().unpolish(self.status_label)
        self.status_label.style().polish(self.status_label)
        if not hasattr(self,'_status_expiry'):
            self._status_expiry=QTimer(self)
            self._status_expiry.setSingleShot(True)
            self._status_expiry.timeout.connect(self.status_label.hide)
        self._status_expiry.stop()
        if level=='ok' or 'API 已应用' in shown or '模型已确认' in shown:
            self._status_expiry.start(4000)

    def _on_theme_changed(self, _index):
        self.setUpdatesEnabled(False)
        try:
            self._theme_id = apply_theme(self.theme_combo.currentData())
            self._settings.setValue('appearance/theme', self._theme_id)
            self.voice_call_panel.apply_theme()
            self._sync_sidebar()
        finally:
            self.setUpdatesEnabled(True)

    def apply_dark_style(self):
        base = """
            QMainWindow, QWidget#chatPage, QStackedWidget#pageStack {
                background-color: #181a1f;
            }
            QLabel { color: #e3e6ed; }
            QLabel#sectionLabel, QLabel#mutedLabel {
                color: #8f96a5; font-size: 12px;
            }
            QLabel#pageTitle {
                color: #f2f4f8; font-size: 22px; font-weight: 650;
            }
            QLabel#pageSubtitle, QLabel#cardDescription {
                color: #9da4b2;
            }
            QLabel#cardTitle {
                color: #f0f2f7; font-size: 16px; font-weight: 600;
            }
            QLabel#modelChip {
                background: #252a33; color: #cfd6e4;
                border: 1px solid #343b48; border-radius: 12px;
                padding: 5px 10px;
            }
            QLabel#statusPill {
                background: #252a33; color: #bfc5d0;
                border: 1px solid #363c47; border-radius: 12px;
                padding: 5px 10px;
            }
            QLabel#statusPill[level="ok"] {
                background: #18362c; color: #9de3c5; border-color: #285443;
            }
            QLabel#statusPill[level="busy"] {
                background: #3a311d; color: #efd18b; border-color: #5a4927;
            }
            QLabel#statusPill[level="error"] {
                background: #42242a; color: #f1a8b3; border-color: #68343e;
            }
            QLabel#diagnosticPending {
                background: #49203e; color: #ffb5e5;
                border: 1px solid #71315f; border-radius: 11px;
                padding: 4px 9px;
            }
            QComboBox, QSpinBox, QLineEdit, QTextEdit, QPlainTextEdit {
                background-color: #24272e; color: #e2e5ec;
                border: 1px solid #373b45; border-radius: 6px; padding: 6px;
            }
            QPushButton#configFileLink {
                color: #a8c8ed; background: transparent; border: none;
                text-decoration: underline; padding: 3px 0;
            }
            QComboBox QAbstractItemView {
                background-color: #25282f; color: #e2e5ec;
                selection-background-color: #3c465f; selection-color: #ffffff;
            }
            QCheckBox { color: #dfe2e8; spacing: 7px; }
            QCheckBox::indicator { width: 16px; height: 16px; }
            QScrollArea#settingsScroll { background: #181a1f; border: none; }
            QScrollArea#settingsScroll > QWidget > QWidget {
                background: #181a1f;
            }
            QPushButton {
                background-color: #292d35; color: #e2e5eb;
                border: 1px solid #3b404b; border-radius: 6px; padding: 7px 13px;
            }
            QPushButton:hover { background-color: #343943; border-color: #505663; }
            QPushButton:pressed { background-color: #242831; }
            QPushButton:disabled { color: #6f7580; background: #22252b; }
            QPushButton#primaryButton {
                background: #3e506f; border-color: #53698f; color: #f7f9ff;
            }
            QPushButton#primaryButton:hover { background: #4a5e80; }
            QPushButton#compactButton { padding: 6px 10px; }
            QPushButton#navButton {
                background: transparent; border: none; text-align: left;
                color: #b8bec9; padding: 8px 10px;
            }
            QPushButton#navButton:hover { background: #2b2f37; }
            QPushButton#navButton:checked {
                background: #343d52; color: #f1f4fa;
                border-left: 3px solid #778fbd;
            }
            QTextEdit, QPlainTextEdit { background-color: #22252b; }
            QWidget#conversationSidebar {
                background-color: #202329;
                border-right: 1px solid #30343c;
            }
            QFrame#sidebarSeparator {
                color: #343840; background: #343840; max-height: 1px;
            }
            QFrame#settingsCard {
                background: #202329; border: 1px solid #31353e;
                border-radius: 10px;
            }
            QFrame#voiceCallPanel, QFrame#voiceSettingsPanel {
                background: transparent; border: none;
            }
            QFrame#personalityActivityPanel {
                background: #171920; border: 1px solid #303541;
                border-radius: 10px;
            }
            QLabel#personalityFlowTitle {
                color: #f1d7ec; font-size: 11px; font-weight: 650;
                letter-spacing: 1px;
            }
            QLabel#personalityFlowStatus {
                color: #9199a8; font-size: 10px;
            }
            QLabel#personalityCollapsedLabel {
                color: #c786b4; font-size: 11px; font-weight: 600;
            }
            QPushButton#personalityCollapseButton {
                padding: 0; border-radius: 6px; color: #d6a4c8;
                background: #242832;
            }
            QLabel#callControlLabel {
                color: #aeb5c2; font-size: 12px;
            }
            QPushButton#micCallButton, QPushButton#phoneCallButton {
                border-radius: 7px; padding: 0 10px;
                background: #2a3039; border: 1px solid #414956;
                color: #f7f9ff;
            }
            QToolButton#chatOptionsButton {
                border-radius: 7px; padding: 7px 12px;
                background: #2a3039; border: 1px solid #414956; color: #e8eaf0;
            }
            QPushButton#micCallButton:hover,
            QPushButton#phoneCallButton:hover {
                background: #353c47; border-color: #626c7b;
            }
            QPushButton#micCallButton[micMode="live"] {
                background: #303844; border-color: #657184;
            }
            QPushButton#micCallButton[micMode="muted"] {
                background: #8f3947; border-color: #d46475;
            }
            QPushButton#micCallButton[micMode="restoring"] {
                background: #765a2c; border-color: #b79048;
            }
            QPushButton#phoneCallButton[callMode="dial"] {
                background: #287653; border-color: #45a879;
            }
            QPushButton#phoneCallButton[callMode="hangup"] {
                background: #9c3947; border-color: #d35d6d;
            }
            QPushButton#phoneCallButton[callMode="busy"],
            QPushButton#micCallButton[micMode="busy"] {
                background: #62502d; border-color: #9a7a3c;
            }
            QListWidget#sessionList {
                background-color: transparent;
                color: #d8dbe3;
                border: none;
                outline: none;
                padding: 2px;
            }
            QListWidget#sessionList::item {
                border-radius: 6px; padding: 8px 8px;
            }
            QListWidget#sessionList::item:hover {
                background-color: #2d3139;
            }
            QListWidget#sessionList::item:selected {
                background-color: #3c465f;
                color: #f2f3f7;
            }
            QListWidget#diagnosticList {
                background: #202329; border: 1px solid #31353e;
                border-radius: 9px; outline: none; padding: 5px;
            }
            QListWidget#diagnosticList::item {
                border-radius: 7px; padding: 11px 10px; margin: 2px;
            }
            QListWidget#diagnosticList::item:hover { background: #2b3039; }
            QListWidget#diagnosticList::item:selected { background: #3a4050; }
            QTextEdit#diagnosticDetails {
                background: #202329; border: 1px solid #31353e;
                border-radius: 9px; padding: 10px;
            }
            QMenu {
                background: #25282f; color: #e2e5ec;
                border: 1px solid #3b404b; padding: 5px;
            }
            QMenu::item { padding: 7px 18px; border-radius: 4px; }
            QMenu::item:disabled { color: #6f7580; background: transparent; }
            QMenu::item:selected { background: #3c465f; }
            QSlider#backgroundOpacitySlider::groove:horizontal {
                height: 4px; background: #3a3e48; border-radius: 2px;
            }
            QSlider#backgroundOpacitySlider::sub-page:horizontal {
                background: #9b4dca; border-radius: 2px;
            }
            QSlider#backgroundOpacitySlider::handle:horizontal {
                background: #e064c4; width: 12px; margin: -4px 0;
                border-radius: 6px;
            }
        """
        set_theme_style(self,lambda palette: render_style(base)+desktop_surface_style(palette))

    def closeEvent(self, event):
        if not self._closing:
            if self.immediate_followup: self.immediate_followup.cancel('exit')
            if self._call_audio is not None:
                self._end_live_call('exit')
            self._closing=True
            if getattr(self, '_initiative_controller', None) is not None:
                self._initiative_controller.stop()
            self.voice_call_panel.set_active(False)
            self.voice_call_panel.desktop.close()
            self._finish_message_delivery()
            self._queued_navigation=None
            self._context_timer.stop();self._mic_event_timer.stop()
            self._call_generation+=1;self._mic_generation+=1
            self._tts_queue.clear();self._pending_client_event=None;self._pending_mic_event=None
            self._call_tones.stop();self.tts.request_stop();self.asr.request_stop();self.dictation.cancel()
            owner=getattr(self,'_chat_thread',None)
            if owner is not None and owner.isRunning():
                owner.cancel_requested=True;owner.cancel_event.set()
                self._cancel_request_in_background(owner)
            if self._file_worker and self._file_worker.isRunning():self._file_worker.requestInterruption()
            self.setEnabled(False)
            self.append_status('正在保存并结束本次会话…')
            self._shutdown_timer.start()
        event.ignore()
        workers=[getattr(self,'_chat_thread',None),getattr(self,'speak_thread',None),
                 self._context_thread,self._navigation_worker,self._delete_worker,self._export_worker,self._file_worker,self._local_model_thread,
                 self.inference_settings.worker,self.security_settings.worker,*self._cancel_workers,*self._list_workers]
        if any(w is not None and w.isRunning() for w in workers):return
        if any(t.is_alive() for t in self._voice_tasks) or (self._startup_thread and self._startup_thread.is_alive()):return
        if self._shutdown_cleanup is None:
            def release():
                for name,action in [('speech',self.tts.unload),('microphone',self.asr.close),
                                    ('local-model',self.manager.stop),('brain',self.manager.pi_stop)]:
                    try:action()
                    except Exception as error:record_failure(failure_from_exception(error),stage='close-'+name)
            self._shutdown_cleanup=threading.Thread(target=release,name='desktop-close',daemon=True)
            self._shutdown_cleanup.start()
            return
        if self._shutdown_cleanup.is_alive() or (self.dictation._cleanup_thread and self.dictation._cleanup_thread.is_alive()):return
        if any(t.is_alive() for t in self._delivery_threads):return
        self._shutdown_timer.stop()
        event.accept()

def main():
    import argparse
    if sys.platform == 'win32':
        # Do not inherit Python/IDLE's taskbar identity for the shipped client.
        import ctypes
        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID('ASKA.Desktop')
    parser = argparse.ArgumentParser(description="ASKA 桌面客户端")
    parser.add_argument("--development", action="store_true",
                        help="启用 TTS 异常采集、标注和样本管理")
    parser.add_argument('--setup',action='store_true',help='完成本机资料的首次配置')
    args, qt_args = parser.parse_known_args()
    # 全局异常捕获：写入日志，避免 pythonw 无声闪退
    import traceback
    def _excepthook(exc_type, exc_value, exc_tb):
        try:
            with open(os.environ.get('ASUKA_CRASH_LOG', PROJECT_ROOT / "_crash.log"), "a", encoding="utf-8") as f:
                f.write("".join(traceback.format_exception(exc_type, exc_value, exc_tb)))
                f.write("\n")
        except Exception:
            pass
    sys.excepthook = _excepthook
    app = QApplication([sys.argv[0], *qt_args])
    app.setApplicationDisplayName("ASKA")
    app.setWindowIcon(QIcon(str(PROJECT_ROOT / "assets" / "aska.ico")))
    from ui.first_run import FirstRunDialog,needs_setup
    settings=desktop_settings()
    if needs_setup(settings,explicit=args.setup):
        apply_theme(theme_id(settings.value('appearance/theme','night')))
        dialog=FirstRunDialog(settings)
        dialog.exec()
        dialog.deleteLater()
    win = MainWindow(development=args.development)
    win.show()
    try:
        exit_code=app.exec()
    finally:
        # Destroy the native window, its child widgets and Python event filters
        # while QApplication and the Windows platform plugin are still alive.
        win.deleteLater()
        app.sendPostedEvents(None,QEvent.Type.DeferredDelete)
    sys.exit(exit_code)
