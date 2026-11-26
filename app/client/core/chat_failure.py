"""System failures are not character speech. Detail stays in local diagnostics."""
import json
import os
import re
import time
from pathlib import Path
from core.app_config import PROJECT_ROOT


def chat_failure(detail='', *, code=None, analysis_complete=False, retryable=True,recovery_request_id=None,failure_closed=False):
    detail = str(detail)
    if not code:
        match = re.match(r'^(?:Error:\s*)?([A-Z][A-Z0-9_]+)(?=[:\s]|$)', detail)
        code = match[1] if match else 'CHAT_FAILED'
    return {'failure': {'code': code, 'detail': detail, 'retryable': bool(retryable),
                        'analysis_complete': bool(analysis_complete),'recovery_request_id':recovery_request_id,'failure_closed':bool(failure_closed)},
            'text': '', 'speech': '', 'translation': '', 'pauses': []}


def failure_from_exception(error):
    code = getattr(error, 'code', None)
    # urllib's code is an HTTP number; local connection exceptions use names.
    if isinstance(code, int): code = 'HTTP_' + str(code)
    return chat_failure(str(error), code=code if isinstance(code,str) else type(error).__name__)['failure']


def failure_message(problem):
    code = problem.get('code','')
    if code=='BRAIN_UNREACHABLE':return '后台暂时没有响应，消息已保留。'
    if code=='CALL_HISTORY_PENDING':return '刚才的通话记录尚未保存，消息已保留，可以重试。'
    if code=='CALL_REQUEST_UNBOUND':return '原通话无法接收这一轮，消息已保留。'
    if code in {'BRAIN_CAPABILITY_MISSING','BRAIN_PERSONALITY_CHANGED'}:return '请检查当前后台的人格或模型资源，消息已保留。'
    if code in {'DIALOGUE_LEGACY_PROMPT_UNKNOWN','DIALOGUE_REQUEST_MISSING'}:
        return '这条旧请求的设定记录不完整，已保留原文；可以继续发送新消息。'
    if isinstance(code,str) and code.startswith('DIALOGUE_'):
        return '聊天设定暂未加载，输入已保留。请检查设置。'
    if code in {'SESSION_STORAGE_UNAVAILABLE','SESSION_STORAGE_RELOAD_REQUIRED','EPERM','EACCES','ENOSPC','EROFS'}:
        return '聊天记录暂时无法保存，消息已保留。请关闭后重新打开客户端。'
    if code in {'CHAT_CANCELLED','MODEL_REQUEST_ABORTED','AGENT_TURN_ABORTED','AbortError','ABORT_ERR'}:
        return '已停止，消息已保留。'
    if code in {'REQUEST_ACTIVE','CHAT_BUSY'}:
        return '这条消息仍在处理中。'
    if code=='PREVIOUS_REQUEST_PENDING':return '上一条尚未结束，本条消息已保留。'
    if code=='REQUEST_UNCERTAIN':return '上次处理结果尚未确认，原消息已保留。'
    if code in {'HTTP_401','HTTP_402','HTTP_422','MODEL_ROUTE_FAILED','BRAIN_START_FAILED','MODEL_NOT_RUNNING','MODEL_CONFIG','MODEL_NOT_CONFIGURED'}:
        return '模型连接需要检查，消息已保留。'
    if code in {'URLError','TimeoutError','HTTP_429','HTTP_500','HTTP_502','HTTP_503','HTTP_504','MODEL_REQUEST_TIMEOUT'}:
        return '暂时没有连上，消息已保留。'
    return '这条还没回复成功，消息已保留。'


def record_failure(problem, *, request_id=None, stage='chat'):
    """No prompt/config dump. Scrub known credentials before storing detail."""
    try:
        from core.app_config import deepseek_api_key
        from core.api_config import load_api_connections
        detail = str(problem.get('detail',''))
        secrets = {p['api_key'] for p in load_api_connections().profiles.values()} | {deepseek_api_key()}
        for value in sorted(filter(None,secrets),key=len,reverse=True):
            detail = detail.replace(str(value), '[REDACTED]')
        detail = re.sub(r'(?i)\bBearer\s+\S+', 'Bearer [REDACTED]', detail)
        detail = re.sub(r'(?i)(api[_-]?key\s*[=:]\s*)[^\s,;]+', r'\1[REDACTED]', detail)
        file = Path(os.environ.get('ASUKA_CLIENT_FAILURE_LOG') or PROJECT_ROOT/'data/logs/client-failures.jsonl')
        file.parent.mkdir(parents=True,exist_ok=True)
        with file.open('a',encoding='utf-8') as out:
            out.write(json.dumps({'at':time.time(),'stage':stage,'request_id':request_id,
                                 'code':problem.get('code','UNKNOWN'),'detail':detail[:6000]},ensure_ascii=False)+'\n')
    except Exception:
        pass  # Diagnostics must not become a second UI failure.
