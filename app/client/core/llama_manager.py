# asuka-ai/client/core/llama_manager.py
# 明日香大脑管理器 - 统一走 Pi 脑层（agent-core.mjs），模型源运行时可切换
import subprocess
import json
import time
import os
import urllib.request
import re
from difflib import SequenceMatcher
from pathlib import Path
from core.app_config import (
    BRAIN_DIR, LLAMA_BASE_URL, LLAMA_DIR as CONFIG_LLAMA_DIR,
    LLAMA_HOST, LLAMA_PORT, MODELS_DIR as CONFIG_MODELS_DIR,
    NODE_EXE, PROJECT_ROOT, deepseek_api_key,
)
from core.api_config import load_custom_api_profile
from core.brain_client import BrainClient
from core.chat_failure import chat_failure
from core.pending_chat import PendingChatStore
from core.personality_library import fingerprint

LLAMA_DIR = str(CONFIG_LLAMA_DIR)
MODELS_DIR = str(CONFIG_MODELS_DIR)
PORT = LLAMA_PORT
BASE_URL = LLAMA_BASE_URL
LLAMA_PARALLEL_SLOTS = 1

# ===== Pi 脑层配置 =====
PI_DIR = str(BRAIN_DIR)

# ===== 模型源配置 =====
# BACKEND_MODE: "api" = DeepSeek（默认，通过 Pi）, "local" = 本地35B（通过 Pi）
# 两者都走 Pi 脑层，Pi 负责性格/记忆/工具编排，模型源仅影响智力
BACKEND_MODE = "api"
API_MODEL = None
API_PROVIDER = None
API_VISION = False
API_CONTEXT_WINDOW = None
LOCAL_MODEL = ("local", "qwen")  # 本地 35B（Pi 的 provider/id）

# 可用模型
MODELS = {
    "Qwen3.6-35B-A3B (主力)": "Qwen3.6-35B-A3B-abliterated-MAX.Q4_K_M.gguf",
    "Qwen3-VL-30B-A3B (识图)": "Qwen3-VL-30B-A3B-Instruct-Heretic.i1-Q4_K_M.gguf",
    "Qwen3.8-27B HauhauCS (人物)": "Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-Q4_K_P.gguf",
    "Qwen3.8-27B huihui (保守)": "Huihui-Qwen3.8-27B-abliterated-UD-DW-Q4_K_M.gguf",
    "Qwen3.8-27B RVN (Agentic)": "Qwen3.8-27B-RVN-Heretic-Q4_K_M-multilingual-mtp.gguf",
    "Gemma-4-26B (创作)": "gemma-4-26B-A4B-uncensored-balanced-Q4_K_M.gguf",
}

VISION_PROJECTORS = {
    "Qwen3.6-35B-A3B-abliterated-MAX.Q4_K_M.gguf":
        "Qwen3.6-35B-A3B-mmproj-BF16.gguf",
    "Qwen3-VL-30B-A3B-Instruct-Heretic.i1-Q4_K_M.gguf":
        "mmproj-Qwen3VL-30B-A3B-Instruct-F16.gguf",
    "Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-Q4_K_P.gguf":
        "mmproj-Qwen3.8-27B-Uncensored-HauhauCS-Aggressive-BF16.gguf",
    "Huihui-Qwen3.8-27B-abliterated-UD-DW-Q4_K_M.gguf":
        "mmproj-Huihui-Qwen3.8-27B-bf16.gguf",
    "Qwen3.8-27B-RVN-Heretic-Q4_K_M-multilingual-mtp.gguf":
        "mmproj-Qwen3.8-27B-RVN-Q8_0.gguf",
}


def discover_local_models(models_dir=CONFIG_MODELS_DIR):
    """扫描真实 GGUF；mmproj 只作为模型能力附件，不进入模型列表。"""
    root = Path(models_dir)
    if not root.is_dir():
        return []
    known_names = {filename: name for name, filename in MODELS.items()}
    known_order = {filename: index for index, filename in enumerate(MODELS.values())}
    models = []
    for path in root.glob("*.gguf"):
        if "mmproj" in path.name.lower() or not path.is_file():
            continue
        projector_name = VISION_PROJECTORS.get(path.name)
        projector_path = root / projector_name if projector_name else None
        models.append({
            "name": known_names.get(path.name, path.stem),
            "filename": path.name,
            "path": str(path),
            "size_gb": round(path.stat().st_size / (1024 ** 3), 2),
            "supports_vision": bool(
                projector_path is not None and projector_path.is_file()
                and projector_path.stat().st_size > 0),
            "projector": str(projector_path) if projector_path else None,
            "sort_order": known_order.get(path.name, len(known_order)),
        })
    models.sort(key=lambda item: (item["sort_order"], item["name"].lower()))
    return models


def _recover_nested_behavior(value):
    """防止 Brain 异常时把整个行为 JSON 当作台词送进 UI/TTS。"""
    if not isinstance(value, str):
        return None
    cleaned = value.replace("```json", "").replace("```", "").strip()
    if not cleaned.startswith('{'):
        return None
    try:
        parsed = json.loads(cleaned)
        if isinstance(parsed, dict) and isinstance(parsed.get("speech"), str):
            return parsed
    except json.JSONDecodeError:
        pass

    def loose_field(key, next_keys):
        boundary = "|".join(re.escape(item) for item in next_keys)
        match = re.search(
            rf'"{re.escape(key)}"\s*:\s*"(.*?)"\s*,\s*"(?:{boundary})"\s*:',
            cleaned, flags=re.DOTALL | re.IGNORECASE)
        if not match:
            return ""
        value = match.group(1)
        # 无效 JSON 中的 LaTeX 命令也可能以 \n/\t/\r 开头；例如
        # \nu、\nabla、\theta。只在后面不是拉丁字母时按控制字符恢复。
        value = re.sub(r'\\n(?![A-Za-z])', lambda _: '\n', value)
        value = re.sub(r'\\r(?![A-Za-z])', lambda _: '\r', value)
        value = re.sub(r'\\t(?![A-Za-z])', lambda _: '\t', value)
        return value.replace(r'\"', '"').replace(r'\\', '\\').strip()

    speech = loose_field("speech", ["translation", "language", "pauses"])
    if not speech:
        return None
    return {
        "speech": speech,
        "translation": loose_field("translation", ["language", "pauses"]),
        "pauses": [],
    }


def _sanitize_model_speech(value):
    """清理模型格式漂移产生的 Markdown 和重复草稿。"""
    speech = str(value or "").replace("```json", "").replace("```", "").strip()
    drafts = [part.strip() for part in re.split(
        r'^\s*-{3,}\s*$', speech, flags=re.MULTILINE) if part.strip()]
    if len(drafts) > 1:
        final = drafts[-1]

        def comparable(text):
            return re.sub(r'[\s。、，！？!?…「」『』"“”‘’—-]+', '', text)

        # 仅在两个长段高度相似时判定为重复草稿；正常的短分隔内容保留。
        previous = drafts[-2]
        similarity = SequenceMatcher(
            None, comparable(previous), comparable(final)).ratio()
        if min(len(previous), len(final)) >= 80 and similarity >= 0.52:
            speech = final
        else:
            speech = "\n".join(drafts)
    return speech.strip()

class LlamaManager:
    def __init__(self):
        self.process = None
        self.current_model = None
        self.current_model_file = None
        self.context_size = 65536
        self.use_vision = False
        self.pi_process = None  # Pi brain 进程
        self.brain = BrainClient()
        self._personality_config_error = None
        try:
            self.brain.expected_personality_fingerprint = fingerprint()
        except (OSError, ValueError) as exc:
            self._personality_config_error = str(exc)
        self._server_log_handle = None
        self.server_log_path = Path(os.environ.get('ASUKA_LLAMA_LOG',
            PROJECT_ROOT / "data" / "logs" / "llama-server.log"))
        self.brain_log_path = Path(os.environ.get('ASUKA_BRAIN_STARTUP_LOG',
            PROJECT_ROOT / "data" / "logs" / "brain-startup.log"))

    # ===== Pi 脑层服务管理 =====
    @property
    def pi_is_running(self):
        """检查 Pi brain 服务是否在运行"""
        return self.brain.is_healthy()

    def pi_start(self):
        """启动 Pi brain（agent-core.mjs）"""
        def failed(message):
            # Only a Popen handle created by this manager may be stopped.
            # A healthy shared service is never killed by startup recovery.
            if self.pi_process is not None:
                self.pi_stop()
            return False, message
        if self._personality_config_error:
            return False, '人格启动配置无效：' + self._personality_config_error
        if self.pi_is_running:
            if (os.environ.get('ASUKA_REQUIRE_OWN_BRAIN','1') == '1'
                    and (self.pi_process is None or self.pi_process.poll() is not None)):
                return False, '候选端口已有其他后台；本次不会复用，请关闭冲突服务后重试'
            if not self.brain.personality_matches:
                return failed('Brain仍使用另一份人格配置，请退出全部客户端后重新启动')
            if self.brain.is_compatible:
                return True, "Pi 已运行"
            return failed(
                "检测到旧版 Pi Brain 占用服务端口；请关闭旧客户端或旧 "
                "node/agent-core.mjs 进程后重试")
        if self.pi_process is not None:
            self.pi_stop()
        self.brain.invalidate()
        # 密钥只来自环境变量或被 Git 忽略的本机配置。
        env = os.environ.copy()
        env.pop('ASUKA_PENDING_SESSION_HINT',None)
        try:
            pending = PendingChatStore().titles()
            if pending:
                env['ASUKA_PENDING_SESSION_HINT'] = json.dumps({k:pending[0][k] for k in ('id','updated_ms')})
        except OSError:
            pass
        api_key = deepseek_api_key()
        if api_key:
            env["DEEPSEEK_API_KEY"] = api_key
        else:
            env.pop("DEEPSEEK_API_KEY", None)
        # A legacy account remains selectable when the desktop starts on another connection.
        if api_key and API_PROVIDER == "deepseek":
            env["ASUKA_START_API_MODEL"] = API_MODEL
        else:
            env.pop("ASUKA_START_API_MODEL", None)
        custom_profile = load_custom_api_profile()
        if custom_profile and API_PROVIDER == 'custom-api':
            env["ASUKA_CUSTOM_API_CONFIG"] = json.dumps(
                custom_profile, ensure_ascii=False)
        else:
            env.pop("ASUKA_CUSTOM_API_CONFIG",None)
        try:
            self.brain_log_path.parent.mkdir(parents=True, exist_ok=True)
            with self.brain_log_path.open("a", encoding="utf-8") as log:
                log.write(time.strftime("\n[%Y-%m-%d %H:%M:%S] Pi Brain 启动\n"))
                log.flush()
                self.pi_process = subprocess.Popen(
                    [NODE_EXE, os.path.join(PI_DIR, "agent-core.mjs")],
                    cwd=PI_DIR,
                    stdout=subprocess.DEVNULL,
                    stderr=log,
                    env=env,
                    creationflags=(subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0),
                )
        except OSError as exc:
            self.pi_process = None
            return False, f"Pi 无法启动：{exc}"
        # 等待就绪（最多 60 秒）
        for _ in range(60):
            if self.pi_process.poll() is not None:
                code = self.pi_process.returncode
                self.pi_process = None
                return False, f"Pi 启动失败（退出码 {code}），日志：{self.brain_log_path}"
            if self.pi_is_running:
                if not self.brain.personality_matches:
                    return failed('人格配置与Brain启动结果不一致，请完整重启客户端')
                if not self.brain.is_compatible:
                    return failed('Brain启动协议不兼容，请完整重启客户端')
                return True, "Pi 已启动"
            time.sleep(1)
        return failed(f"Pi 启动超时，日志：{self.brain_log_path}")

    def pi_stop(self):
        """停止 Pi brain"""
        if self.pi_process and self.pi_process.poll() is None:
            self.pi_process.terminate()
            try:
                self.pi_process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.pi_process.kill()
                self.pi_process.wait(timeout=5)
        self.pi_process = None
        self.brain.invalidate()
        return True, "Pi 已停止"

    def pi_set_model(self, provider, model_id, vision=None,
                     context_window=None):
        """切换 Pi 的模型源（运行时，不重启）"""
        return self.brain.set_model(
            provider, model_id, vision=vision,
            context_window=context_window)

    def pi_configure_api(self, profile):
        """在正在运行的 Brain 中注册并立即应用自定义 API。"""
        return self.brain.configure_api(profile)

    def pi_ask(self, message, images=None, personality_mode="light",
               personality_state_scope="conversation", on_progress=None,
               voice_enabled=False, voice_preset='natural',request_id=None,session_id=None,cancel_event=None,manual_retry=False,voice_turn=None,voice_planner=None,call_language=None,group_id=None,call_id=None,immediate_followup=False):
        """调 Pi /ask，返回行为对象 dict"""
        if self._personality_config_error or not self.brain.personality_matches:
            return {'error': '人格启动配置未生效，请退出全部客户端后重启'}
        return self.brain.ask(
            message, images=images,
            **({'immediate_followup':True} if immediate_followup else {}),
            **({'group_id':group_id} if group_id else {}),**({'call_id':call_id} if call_id else {}),
            **({'voice_planner':voice_planner} if voice_planner is not None else {}),
            **({'voice_turn':voice_turn} if voice_turn else {}), **({'call_language':call_language} if call_language else {}),
            personality_mode=personality_mode,
            personality_state_scope=personality_state_scope, on_progress=on_progress,
            **({'request_id':request_id} if request_id else {}),**({'session_id':session_id} if session_id else {}),
            **({'cancel_event':cancel_event} if cancel_event is not None else {}),**({'manual_retry':True} if manual_retry else {}),
            **({'voice_enabled': voice_enabled, 'voice_preset': voice_preset}
               if voice_turn or personality_mode in {'general_quality', 'general_fast', 'general_auto'} else {}))

    def pi_client_event(self, event_type, personality_mode="light",
                        personality_state_scope="conversation", on_progress=None,request_id=None,session_id=None,cancel_event=None,voice_turn=None,call_language=None,group_id=None,call_id=None,voice_preset=None):
        """调 Pi /clientEvent，输入不进入可见聊天历史。"""
        if self._personality_config_error or not self.brain.personality_matches:
            return {'error': '人格启动配置未生效，请退出全部客户端后重启'}
        return self.brain.client_event(
            event_type, personality_mode=personality_mode,voice_preset=voice_preset,
            **({'group_id':group_id} if group_id else {}),**({'call_id':call_id} if call_id else {}),
            **({'voice_turn':voice_turn} if voice_turn else {}), **({'call_language':call_language} if call_language else {}),
            personality_state_scope=personality_state_scope, on_progress=on_progress,
            **({'request_id':request_id} if request_id else {}),**({'session_id':session_id} if session_id else {}),
            **({'cancel_event':cancel_event} if cancel_event is not None else {}))


    @property
    def is_running(self):
        """检查 llama-server 是否在运行"""
        try:
            urllib.request.urlopen(BASE_URL + "/health", timeout=0.75)
            return True
        except Exception:
            return False

    @property
    def owns_server(self):
        return self.process is not None and self.process.poll() is None

    def available_models(self):
        return discover_local_models(CONFIG_MODELS_DIR)

    def model_info(self, model_ref):
        for item in self.available_models():
            if model_ref in (item["filename"], item["name"]):
                return item
        return None

    def _close_server_log(self):
        if self._server_log_handle is not None:
            try:
                self._server_log_handle.close()
            except OSError:
                pass
            self._server_log_handle = None

    def start(self, model_ref, context_size=65536, use_vision=False):
        """启动 llama-server"""
        if self.owns_server:
            return False, f"本地模型已运行：{self.current_model}"
        if self.is_running:
            return False, f"端口 {PORT} 已被其他 llama-server 占用"
        info = self.model_info(model_ref)
        if info is None:
            return False, f"模型文件不存在或未识别：{model_ref}"
        model_path = info["path"]
        executable = Path(LLAMA_DIR) / "llama-server.exe"
        if not executable.is_file():
            return False, f"找不到 llama-server：{executable}"
        if use_vision and not info["supports_vision"]:
            return False, "所选模型没有可用的视觉投影文件"

        cmd = [
            str(executable),
            "-m", model_path,
            "--host", LLAMA_HOST,
            "--port", str(PORT),
            "-c", str(context_size),
            "--parallel", str(LLAMA_PARALLEL_SLOTS),
            "-ngl", "99",
            "--no-warmup",
            "--reasoning", "off",
            "--flash-attn", "on",
        ]
        if use_vision:
            cmd += ["--mmproj", info["projector"]]

        self.server_log_path.parent.mkdir(parents=True, exist_ok=True)
        self._close_server_log()
        self._server_log_handle = self.server_log_path.open(
            "a", encoding="utf-8", errors="replace")
        self._server_log_handle.write(
            f"\n--- start {time.strftime('%Y-%m-%d %H:%M:%S')} "
            f"model={info['filename']} vision={use_vision} ---\n")
        self._server_log_handle.flush()
        creationflags = (
            subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
        try:
            self.process = subprocess.Popen(
                cmd, stdout=self._server_log_handle,
                stderr=subprocess.STDOUT, creationflags=creationflags)
        except OSError as exc:
            self.process = None
            self._close_server_log()
            return False, f"无法启动 llama-server：{exc}"
        self.current_model = info["name"]
        self.current_model_file = info["filename"]
        self.context_size = context_size
        self.use_vision = use_vision
        process = self.process

        # 35B + mmproj 首次加载可能较慢；该方法由 UI 后台线程调用。
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline:
            if self.is_running:
                suffix = "，视觉投影已加载" if use_vision else ""
                return True, f"{info['name']} 已启动{suffix}"
            if process.poll() is not None:
                code = process.returncode
                if self.process is process:
                    self.process = None
                self.current_model = None
                self.current_model_file = None
                self.use_vision = False
                self._close_server_log()
                return False, (
                    f"llama-server 启动失败（退出码 {code}），"
                    f"日志：{self.server_log_path}")
            time.sleep(0.5)
        self.stop()
        return False, f"启动超时，日志：{self.server_log_path}"

    def stop(self):
        """停止 llama-server"""
        if self.process and self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=5)
        elif self.is_running:
            return False, "检测到外部 llama-server，本客户端不会强制停止它"
        self.process = None
        self.current_model = None
        self.current_model_file = None
        self.use_vision = False
        self._close_server_log()
        return True, "本地模型已停止"

    def chat(self, message=None, images=None, client_event=None,
             personality_mode="light",
             personality_state_scope="conversation", on_progress=None,
             voice_enabled=False, voice_preset='natural',request_id=None,session_id=None,cancel_event=None,manual_retry=False,voice_turn=None,voice_planner=None,call_language=None,group_id=None,call_id=None,immediate_followup=False):
        """对话（统一走 Pi 脑层，模型源由 BACKEND_MODE 决定）。
        返回结构化 dict: {text, speech, translation, pauses}
        """
        if cancel_event is not None and cancel_event.is_set():return chat_failure('用户停止',code='CHAT_CANCELLED')
        if client_event is None and not str(message or "").strip():
            return chat_failure('消息不能为空',code='EMPTY_INPUT',retryable=False)
        # 确保 Pi 已运行
        if BACKEND_MODE=='api' and not (API_PROVIDER and API_MODEL):
            return chat_failure('请先配置模型连接',code='MODEL_NOT_CONFIGURED',retryable=False)
        if not self.pi_is_running:
            ok, msg = self.pi_start()
            if not ok:
                return chat_failure(msg,code='BRAIN_START_FAILED')
        # Brain 可能跨客户端复用、独立重启或被另一模型源切换。Python
        # 不能相信进程内的上次路由缓存；每轮对话前幂等确认真实路由。
        if BACKEND_MODE == "local":
            if not self.is_running:
                return chat_failure('本地模型服务未运行',code='MODEL_NOT_RUNNING')
            route_ok, route_message = self.pi_set_model(
                *LOCAL_MODEL, vision=self.use_vision,
                context_window=self.context_size)
        else:
            if API_PROVIDER == "deepseek":
                route_ok, route_message = self.pi_set_model(
                    API_PROVIDER, API_MODEL)
            else:
                route_ok, route_message = self.pi_set_model(
                    API_PROVIDER, API_MODEL, vision=API_VISION,
                    context_window=API_CONTEXT_WINDOW)
        if not route_ok:
            return chat_failure(route_message,code='MODEL_ROUTE_FAILED')
        if cancel_event is not None and cancel_event.is_set():return chat_failure('用户停止',code='CHAT_CANCELLED')
        if client_event is not None:
            behavior = self.pi_client_event(
                client_event, personality_mode=personality_mode,
                **({'group_id':group_id} if group_id else {}),**({'call_id':call_id} if call_id else {}),
                **({'voice_turn':voice_turn,'voice_preset':voice_preset} if voice_turn else {}), **({'call_language':call_language} if call_language else {}),
                request_id=request_id,session_id=session_id,cancel_event=cancel_event,
                personality_state_scope=personality_state_scope,
                **({"on_progress": on_progress} if on_progress is not None else {}))
        else:
            behavior = self.pi_ask(
                str(message), images=images,
                **({'immediate_followup':True} if immediate_followup else {}),
                **({'group_id':group_id} if group_id else {}),**({'call_id':call_id} if call_id else {}),
                **({'voice_planner':voice_planner} if voice_planner is not None else {}),
                **({'voice_turn':voice_turn} if voice_turn else {}), **({'call_language':call_language} if call_language else {}),
                **({'request_id':request_id} if request_id else {}),**({'session_id':session_id} if session_id else {}),
                **({'cancel_event':cancel_event} if cancel_event is not None else {}),**({'manual_retry':True} if manual_retry else {}),
                personality_mode=personality_mode,
                personality_state_scope=personality_state_scope,
                **({"on_progress": on_progress} if on_progress is not None else {}),
                **({'voice_enabled': voice_enabled, 'voice_preset': voice_preset}
                   if voice_turn or personality_mode in {'general_quality', 'general_fast', 'general_auto'} else {}))
        return self._format_behavior(behavior)

    def lookup_reply(self,**options):
        behavior=self.brain.lookup_reply(**options)
        return self._format_behavior(behavior) if behavior is not None else None

    def _format_behavior(self,behavior):
        if "error" in behavior:
            return chat_failure(behavior['error'],code=behavior.get('code'),
                analysis_complete=behavior.get('analysis_complete') is True,retryable=behavior.get('retryable',True),
                recovery_request_id=behavior.get('recovery_request_id'),failure_closed=behavior.get('failure_closed',False))
        if behavior.get('silence'):
            return {'text': '', 'speech': '', 'translation': '', 'pauses': [],
                    'silence': True, 'quality_mode': bool(behavior.get('quality_mode')),
                    'analysis_complete':bool(behavior.get('analysis_complete')),
                    'personality':behavior.get('_personality') or {}}
        speech = behavior.get("speech", "")
        translation = behavior.get("translation", "")
        pauses = behavior.get("pauses") or []
        # 第二道边界：即使旧版 Brain 或异常响应把整段 JSON 塞进 speech，
        # 也只提取真正的台词；无法安全恢复时禁止进入 UI/TTS。
        # A validated behavior's speech is ordinary authored text, including
        # JSON/code examples. Only the old untyped compatibility path unwraps.
        nested = None if behavior.get('_validated_behavior') else _recover_nested_behavior(speech)
        if nested is not None:
            speech = nested.get("speech", "")
            translation = nested.get("translation", "") or translation
            pauses = nested.get("pauses") or pauses
        elif not behavior.get('_validated_behavior') and isinstance(speech, str) and speech.lstrip().startswith('{') and re.search(r'^\s*\{\s*"(?:speech|emotion|translation|action|tone)"\s*:',speech):
            return chat_failure('后端行为对象未完整返回',code='INVALID_OUTPUT')
        if not isinstance(speech, str) or not speech.strip():
            return chat_failure('后端没有返回台词',code='EMPTY_OUTPUT')
        if not behavior.get('quality_mode') and not behavior.get('_validated_behavior'):
            speech = _sanitize_model_speech(speech)
        translation = (translation if behavior.get('quality_mode') else translation.strip()) if isinstance(translation, str) else ""
        # 拼接：日语（中文翻译），TTS 剥离括号只读日语
        if translation and translation != speech:
            reply = f"{speech}（{translation}）"
        else:
            reply = speech
        return {
            "text": reply,
            "speech": speech,
            "translation": translation,
            "pauses": pauses,
            "emotion": behavior.get("emotion", ""),
            "action": behavior.get("action", ""),
            "tone": behavior.get("tone", ""),
            "language": behavior.get("language", ""),
            "personality": behavior.get("_personality") or {},
            **{key: behavior[key] for key in ['quality_mode','quality_receipt','voice_preset','voice_expression','voice_error','voice_backend','voice_turn','playback_id','analysis_complete','parts','degraded_continuity','reply_saved','followup'] if key in behavior},
        }
