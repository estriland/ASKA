"""Pi Brain 的唯一 HTTP 边界。"""
from __future__ import annotations

import json
import os
import time
import urllib.request
import urllib.error
import uuid
import threading
from http.client import IncompleteRead
from urllib.parse import urlencode

from core.app_config import PI_BASE_URL

BRAIN_PROTOCOL_VERSION = 37
HIDDEN_CLIENT_EVENT_CAPABILITY = "hidden-client-event-v1"
PERSONALITY_OBSERVER_CAPABILITY = "personality-observer-v1"

from dataclasses import dataclass

@dataclass(frozen=True)
class BrainHealth:
    protocol: int
    capabilities: frozenset
    personality: str
    timeout: int

class BrainResponseError(ValueError):
    pass


class BrainClient:
    def __init__(self, base_url=PI_BASE_URL):
        self.base_url = base_url.rstrip("/")
        self._health_lock = threading.Lock()
        self._health_epoch = self._health_sequence = self._health_applied = 0
        self._last_health = None
        self._healthy_until = 0.0
        self._model = None
        self.protocol_version = 0
        self.capabilities = set()
        self._native_request_id = None
        self.personality_fingerprint = None
        self.personality_selection = {}
        self.expected_personality_fingerprint = None
        self.general_timeout_seconds = 300

    def request(self, method, path, data=None, timeout=30):
        body = None
        headers = {}
        if path.startswith('/relationship/') or path in ('/security', '/security/capabilities', '/personality/selection', '/configureApi','/sessions/switch','/sessions/delete'):
            headers['X-Asuka-Settings'] = '1'
        if data is not None:
            body = json.dumps(data, ensure_ascii=False).encode("utf-8")
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(
            self.base_url + path, data=body, headers=headers, method=method)
        with urllib.request.urlopen(request, timeout=timeout) as response:
            value=json.loads(response.read().decode('utf-8'))
            if not isinstance(value,dict):raise BrainResponseError('Brain returned an invalid response envelope')
            return value

    def health_snapshot(self, cache_seconds=0):
        with self._health_lock:
            if cache_seconds > 0 and time.monotonic() < self._healthy_until:
                return self._last_health
            self._health_sequence += 1
            sequence,epoch=self._health_sequence,self._health_epoch
        try:
            data=self.request('GET','/health',timeout=2)
            health=BrainHealth(int(data.get('protocolVersion',0)),frozenset(data.get('capabilities') or ()),
                data.get('personalityFingerprint') or 'builtin',max(30,int(data.get('generalTimeoutSeconds',300))))
        except (OSError,ValueError,TypeError,KeyError):
            with self._health_lock:
                if epoch==self._health_epoch and sequence>=self._health_applied:
                    self._healthy_until=0.0
            return None
        with self._health_lock:
            if epoch!=self._health_epoch:return None
            if sequence < self._health_applied:return self._last_health
            self._health_applied=sequence
            self._last_health=health
            self.protocol_version=health.protocol
            self.general_timeout_seconds=health.timeout
            self.capabilities=set(health.capabilities)
            self.personality_fingerprint=data.get('personalityFingerprint')
            self.personality_selection=data.get('personalitySelection') or {}
            self._healthy_until=time.monotonic()+cache_seconds
        return health

    def is_healthy(self, cache_seconds=1.0):
        return self.health_snapshot(cache_seconds) is not None

    @property
    def is_compatible(self):
        needs_timeline = bool(os.environ.get('ASUKA_RELATIONSHIP_DIR'))
        return (self.protocol_version >= BRAIN_PROTOCOL_VERSION and self.personality_matches and
                (not needs_timeline or 'relationship-timeline-v1' in self.capabilities))

    @property
    def personality_matches(self):
        return (self.expected_personality_fingerprint is None
                or self.expected_personality_fingerprint == (self.personality_fingerprint or 'builtin'))

    def use_personality(self, kind, file_id):
        if not self.is_healthy(cache_seconds=0) or 'personality-hot-load-v1' not in self.capabilities:
            raise ValueError('当前 Brain 不支持人格热切换，请先重启更新后的客户端')
        result = self.request('POST', '/personality/selection', {
            'kind': kind, 'id': file_id,
            'expected_fingerprint': self.personality_fingerprint,
        }, timeout=30)
        if not result.get('ok'):
            raise ValueError(result.get('error', '人格切换失败'))
        return result

    @property
    def supports_hidden_client_events(self):
        return HIDDEN_CLIENT_EVENT_CAPABILITY in self.capabilities

    @property
    def supports_personality_observer(self):
        return PERSONALITY_OBSERVER_CAPABILITY in self.capabilities

    def ask(self, message, images=None, personality_mode="light",
            personality_state_scope="conversation", on_progress=None,
            voice_enabled=False, voice_preset='natural',request_id=None,session_id=None,cancel_event=None,manual_retry=False,voice_turn=None,voice_planner=None,call_language=None,group_id=None,call_id=None,immediate_followup=False):
        payload = {
            "message": message,
            "personality_mode": personality_mode,
            "personality_state_scope": personality_state_scope,
        }
        if images:
            payload["images"] = images
        if request_id:payload['request_id']=request_id
        if session_id:payload['session_id']=session_id
        if group_id:payload['group_id']=group_id
        if call_id:payload['call_id']=call_id
        if manual_retry:payload['manual_retry']=True
        if immediate_followup: payload['immediate_followup']=True
        if call_language:payload['call_language']=call_language
        if voice_turn and personality_mode=='light':payload['voice_turn']=voice_turn
        if voice_turn and personality_mode=='light' and voice_preset:payload['voice_preset']=voice_preset
        if personality_mode in {'general_quality', 'general_fast', 'general_auto'}:
            payload.update(voice_enabled=bool(voice_enabled), voice_preset=voice_preset)
            if voice_enabled and voice_preset=='natural' and voice_planner is not None:
                payload['voice_planner']=voice_planner
        data = self._personality_request("/ask", payload, personality_mode, on_progress,cancel_event)
        if "error" in data:
            return {k:data[k] for k in ('error','code','retryable','analysis_complete','recovery_request_id','failure_closed') if k in data}
        behavior = data.get("behavior", {})
        if isinstance(behavior,dict):
            behavior['_validated_behavior']=True
            behavior.pop('followup',None)
            if immediate_followup and isinstance(data.get('followup'),dict):
                behavior['followup']=data['followup']
        if data.get("personality"):
            behavior["_personality"] = data["personality"]
        return behavior

    def lookup_reply(self,message,images=None,personality_mode='light',personality_state_scope='conversation',
                     request_id=None,session_id=None,voice_enabled=False,voice_preset='natural',voice_turn=None,voice_planner=None,call_language=None,group_id=None,call_id=None):
        payload={'message':message,'personality_mode':personality_mode,'personality_state_scope':personality_state_scope,
                 'request_id':request_id,**({'session_id':session_id} if session_id else {})}
        if group_id:payload['group_id']=group_id
        if call_id:payload['call_id']=call_id
        if images:payload['images']=images
        if call_language:payload['call_language']=call_language
        if voice_turn and personality_mode=='light':payload['voice_turn']=voice_turn
        if voice_turn and personality_mode=='light' and voice_preset:payload['voice_preset']=voice_preset
        if personality_mode in {'general_fast','general_quality','general_auto'}:
            payload.update(voice_enabled=bool(voice_enabled),voice_preset=voice_preset)
            if voice_enabled and voice_preset=='natural' and voice_planner is not None:
                payload['voice_planner']=voice_planner
        data=self.request('POST','/requests/lookup',payload,timeout=3)
        if not data.get('ready'):return None
        result=data['result'];behavior=result['behavior'];behavior['_validated_behavior']=True
        if result.get('personality'):behavior['_personality']=result['personality']
        return behavior

    def client_event(self, event_type, personality_mode="light",
                     personality_state_scope="conversation", on_progress=None,request_id=None,session_id=None,cancel_event=None,voice_turn=None,call_language=None,group_id=None,call_id=None,voice_preset=None):
        """触发一个受 Brain 白名单约束、客户端不可见的状态事件。"""
        data = self._personality_request("/clientEvent", {
            "type": str(event_type),
            **({'group_id':group_id} if group_id else {}),**({'call_id':call_id} if call_id else {}),
            **({'voice_turn':voice_turn} if voice_turn and personality_mode=='light' else {}),
            **({'voice_preset':voice_preset} if voice_turn and voice_preset else {}),
            **({'call_language':call_language} if call_language else {}),
            "personality_mode": personality_mode,
            "personality_state_scope": personality_state_scope,
            **({'request_id':request_id} if request_id else {}),**({'session_id':session_id} if session_id else {}),
        }, personality_mode, on_progress,cancel_event)
        if "error" in data:
            return data
        behavior = data.get("behavior", {})
        behavior['_validated_behavior']=True
        if data.get("personality"):
            behavior["_personality"] = data["personality"]
        return behavior

    def _personality_request(self, path, payload, mode, on_progress=None,cancel_event=None):
        if cancel_event is not None and cancel_event.is_set():return {'error':'用户已停止','code':'AGENT_TURN_ABORTED'}
        health=self.health_snapshot(0)
        if health is None:return {'error':'后台暂时没有响应，消息已保留。','code':'BRAIN_UNREACHABLE'}
        if payload.get('call_language') and 'dedicated-call-v1' not in health.capabilities:
            return {'error':'请重开 ASKA，加载独立语音通话。','code':'BRAIN_CAPABILITY_MISSING'}
        if self.expected_personality_fingerprint is not None and self.expected_personality_fingerprint!=health.personality:
            return {'error':'后台加载的人格与当前选择不同。','code':'BRAIN_PERSONALITY_CHANGED'}
        from core.inference_config import CONFIG_PATH, load_inference
        if CONFIG_PATH.exists() and 'inference-settings-v1' not in health.capabilities:
            return {'error':'后台不支持当前模型设置，请检查客户端版本。','code':'BRAIN_CAPABILITY_MISSING'}
        general = mode in {'general_quality', 'general_fast', 'general_auto'}
        seconds=health.timeout if general else load_inference()['light']['timeout_seconds']+30 if mode=='light' else 7230
        required = {'personality-general-v1','personality-progress-v1'} if general else (
            {'personality-shin-cpp-v1','personality-context-v1','personality-progress-v1'} if mode=='deep_dive_shin' else {'personality-progress-v1'})
        if path=='/clientEvent' and HIDDEN_CLIENT_EVENT_CAPABILITY not in health.capabilities:
            return {'error':'当前后台不支持麦克风状态事件，请检查后台版本。','code':'BRAIN_CAPABILITY_MISSING'}
        if not required.issubset(health.capabilities):
            return {'error':'当前后台未提供所需功能，请检查版本和资源配置。','code':'BRAIN_CAPABILITY_MISSING'}
        request_id = payload.get('request_id') or str(uuid.uuid4())
        self._native_request_id = request_id
        cancel_requested=cancel_event or threading.Event();self._request_cancel=cancel_requested
        stopped = threading.Event()
        poller = None
        if on_progress and "personality-progress-v1" in health.capabilities:
            def poll():
                last = None
                while not stopped.wait(.6):
                    try:
                        data = self.request("GET", "/personality/progress?" + urlencode({"request_id": request_id}), timeout=2)
                        if not stopped.is_set() and data != last and data.get("stage") != "unavailable":
                            on_progress(data)
                            last = data
                    except Exception:
                        pass  # Progress visibility cannot fail the actual conversation.
            poller = threading.Thread(target=poll, daemon=True)
            poller.start()
        try:
            attempts=0;deadline=time.monotonic()+seconds
            while True:
                if cancel_requested.is_set():return {'error':'用户已停止当前请求','code':'AGENT_TURN_ABORTED'}
                try:
                    data=self.request('POST',path,{**payload,'request_id':request_id},timeout=max(1,deadline-time.monotonic()))
                except (urllib.error.URLError,TimeoutError,ConnectionError,IncompleteRead,json.JSONDecodeError,BrainResponseError) as error:
                    transient=not isinstance(error,urllib.error.HTTPError) or error.code in (408,429) or error.code>=500
                    if not transient or attempts>=2 or time.monotonic()>=deadline:raise
                    attempts+=1
                    if on_progress:on_progress({'stage':'retrying','text':'正在恢复连接'})
                    cancel_requested.wait(.5*attempts);continue
                if data.get('code')!='REQUEST_ACTIVE':return data
                if time.monotonic()>=deadline:raise TimeoutError('Waiting for the existing request timed out')
                if on_progress:on_progress({'stage':'retrying','text':'仍在处理同一条消息'})
                cancel_requested.wait(.6)
        finally:
            stopped.set()
            if self._native_request_id == request_id:
                self._native_request_id = None

    def cancel_native(self,request_id=None,session_id=None,*,details=False):
        request_id = request_id or self._native_request_id
        if not request_id:
            return {'cancelled':False,'completed':False} if details else False
        if request_id==self._native_request_id and getattr(self,'_request_cancel',None):self._request_cancel.set()
        response=self.request("POST", "/personality/cancel",
                              {"request_id": request_id,**({'session_id':session_id} if session_id else {})},timeout=3)
        status={key:response.get(key) is True for key in ('cancelled','completed','noop','inactive','source_unreadable')}
        if isinstance(response.get('recovery_request_id'),str):status['recovery_request_id']=response['recovery_request_id']
        if response.get('ok') is False:status.update(cancelled=False,completed=False,inactive=False)
        return status if details else status['cancelled']

    def set_model(self, provider, model_id, vision=None, context_window=None):
        requested = (provider, model_id, vision, context_window)
        payload = {"provider": provider, "id": model_id}
        capabilities = {}
        if vision is not None:
            capabilities["vision"] = bool(vision)
        if context_window is not None:
            capabilities["contextWindow"] = int(context_window)
        if capabilities:
            payload["capabilities"] = capabilities
        data = self.request("POST", "/setModel", payload)
        if data.get("ok"):
            self._model = requested
            return True, f"模型已确认为 {provider}/{model_id}"
        return False, data.get("error", "切换失败")

    def configure_api(self, profile):
        """注册或更新一个自定义远程模型；密钥只经过本机回环接口。"""
        if profile.get('connection_id'):
            health=self.health_snapshot(0)
            if health is None or 'saved-api-connections-v1' not in health.capabilities:
                return False,'请重开新版 ASKA 以启用已保存的连接。'
        data = self.request("POST", "/configureApi", profile)
        if data.get("ok"):
            model = data.get("model") or {}
            self._model = (
                model.get("provider"), model.get("id"),
                bool(model.get("vision")), model.get("contextWindow"),
            )
            return True, (
                f"API 已应用：{model.get('provider')}/{model.get('id')}")
        return False, data.get("error", "API 配置失败")

    def invalidate(self):
        with self._health_lock:
            self._health_epoch+=1
            self._healthy_until=0.0
            self._last_health=None
            self._model=None
            self.protocol_version=0
            self.capabilities=set()
