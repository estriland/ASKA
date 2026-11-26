"""Host-side completion-suffix policy for the natural Japanese voice route.

This module is deliberately pure: it reads no file, environment variable,
model, player or logger.  The caller passes the already-parsed desktop quality
settings and uses the returned ``instruct`` for the actual synthesis request.
"""
from __future__ import annotations

POLICY_KEY = 'voice_inference_policy'
POLICY_SCHEMA = 'asuka.voice-inference-policy/1'
POLICY_ID = 'completion-ja-v1'
POLICY_TEXT = '最後まで言い切る。'

_NATURAL = 'natural'
_JAPANESE = 'Japanese'


class VoiceInferencePolicyError(ValueError):
    """The optional host policy is present but cannot be consumed safely."""


def _host_policy(status, *, applied=False, rule=False):
    """Build a fresh snapshot; policy text is never stored in the source."""
    return {
        'status': status,
        'id': POLICY_ID if rule else None,
        'text': POLICY_TEXT if rule else None,
        'separator': '',
        'applied': bool(applied),
    }


def _unchanged(source_instruct, status):
    return {
        'source_instruct': source_instruct,
        'instruct': source_instruct,
        'host_policy': _host_policy(status),
    }


def resolve_voice_inference(source_instruct, quality_settings, preset, language):
    """Resolve the optional host policy for one synthesis request.

    ``preset == 'natural'`` and ``language == 'Japanese'`` are the only routes
    that consult the policy.  Every other route returns immediately, even when
    the supplied settings are malformed, so Base voices are never blocked by a
    rule that does not apply to them.

    The source instruction is returned unchanged.  When the policy applies and
    the source does not already end with the fixed text, the text is appended
    directly (no separator).  ``host_policy['applied']`` is true only when the
    actual instruction differs from the source.
    """
    if preset != _NATURAL or language != _JAPANESE:
        return _unchanged(source_instruct, 'not_applicable')

    if quality_settings is None:
        return _unchanged(source_instruct, 'absent')
    if not isinstance(quality_settings, dict):
        raise VoiceInferencePolicyError('高质量版配置必须是对象')

    if POLICY_KEY not in quality_settings:
        return _unchanged(source_instruct, 'absent')
    policy = quality_settings[POLICY_KEY]
    if not isinstance(policy, dict):
        raise VoiceInferencePolicyError('声音完成策略必须是对象')

    if 'enabled' in policy and type(policy['enabled']) is not bool:
        raise VoiceInferencePolicyError('声音完成策略 enabled 必须是布尔值')
    if policy.get('enabled') is not True:
        return _unchanged(source_instruct, 'off')

    if policy.get('schema') != POLICY_SCHEMA:
        raise VoiceInferencePolicyError('声音完成策略版本不受支持')
    if policy.get('id') != POLICY_ID:
        raise VoiceInferencePolicyError('声音完成策略编号不受支持')
    if policy.get('text') != POLICY_TEXT:
        raise VoiceInferencePolicyError('声音完成策略文本不受支持')

    if not isinstance(source_instruct, str) or not source_instruct.strip():
        raise VoiceInferencePolicyError('声音完成策略需要非空来源指令')

    if source_instruct.rstrip().endswith(POLICY_TEXT):
        return {
            'source_instruct': source_instruct,
            'instruct': source_instruct,
            'host_policy': _host_policy('already_present', rule=True),
        }

    return {
        'source_instruct': source_instruct,
        'instruct': source_instruct + POLICY_TEXT,
        'host_policy': _host_policy('applied', applied=True, rule=True),
    }
