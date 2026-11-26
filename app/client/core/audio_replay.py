"""Per-message original speech: compact decoder inputs + a bounded PCM cache.

Reconstruction calls only the original acoustic decoder. It never regenerates
text, chooses a new voice condition, or samples TTS again.
"""
from __future__ import annotations
from contextlib import contextmanager
from functools import lru_cache
from pathlib import Path
import hashlib
import inspect
import json
import os
import threading
import time
import uuid
import numpy as np
from core.app_config import PROJECT_ROOT

def pcm_hash(audio):
    return hashlib.sha256(np.asarray(audio, dtype='<f4').tobytes()).hexdigest()

@lru_cache(maxsize=32)
def _hash_file(file, size, stamp):
    value = hashlib.sha256()
    with open(file, 'rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            value.update(chunk)
    return value.hexdigest()

def file_hash(file):
    p = Path(file).resolve(); stat = p.stat()
    return _hash_file(str(p), stat.st_size, stat.st_mtime_ns)

def _record_decoder_path(file):
    path = Path(file).resolve()
    if path.is_relative_to(PROJECT_ROOT):
        return "@project/" + path.relative_to(PROJECT_ROOT).as_posix()
    return str(path)


def _verified_decoder_directory(info):
    # Older portable recordings stored a full path to either bundled tokenizer.
    old = Path(info["path"])
    bases = []
    for suffix in (Path("quality/qwen-base/speech_tokenizer"), Path("models/tts/model/speech_tokenizer")):
        if old.is_absolute() and Path(*old.parts[-len(suffix.parts):]) == suffix:
            bases.append(old.parents[len(suffix.parts) - 1])
            break

    def locate(value, base):
        if value.startswith("@project/"):
            relative = Path(value[len("@project/"):])
        elif base is not None and Path(value).is_relative_to(base):
            relative = Path(value).relative_to(base)
        else:
            return Path(value)
        target = (PROJECT_ROOT / relative).resolve()
        if relative.anchor or not target.is_relative_to(PROJECT_ROOT):
            raise ValueError("回放记录的解码器路径无效")
        multilingual_codec = PROJECT_ROOT / "models/tts/model/speech_tokenizer"
        if target.is_relative_to(multilingual_codec) and not (multilingual_codec / "model.safetensors").is_file():
            target = PROJECT_ROOT / "quality/qwen-base/speech_tokenizer" / target.relative_to(multilingual_codec)
        return target

    for base in [*bases, None]:
        directory = locate(info["path"], base)
        try:
            if directory.is_dir() and all(file_hash(locate(f, base)) == expected for f, expected in info["files"].items()):
                return directory
        except OSError:
            continue
    raise ValueError("找不到与原音校验一致的解码模型和代码")


def _write_json(file, value):
    temporary = file.with_name(file.name + '.' + uuid.uuid4().hex + '.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', 'utf-8')
    os.replace(temporary, file)


def _decoder_identity(tokenizer, directory):
    model = tokenizer.model.decoder
    files = [Path(directory) / 'model.safetensors', Path(directory) / 'config.json',
             Path(inspect.getfile(type(model))), Path(inspect.getfile(type(tokenizer)))]
    return {'path': _record_decoder_path(directory), 'dtype': str(next(model.parameters()).dtype),
            'device': str(tokenizer.device), 'files': {_record_decoder_path(p):file_hash(p) for p in files}}


def _same_decoder(left, right):
    def files(info):
        return sorted((Path(path).name, digest) for path, digest in info['files'].items())
    return left['device'] == right['device'] and left['dtype'] == right['dtype'] and files(left) == files(right)

class AudioReplayStore:
    def __init__(self, root=None, cache_limit=10):
        self.root = Path(root or os.environ.get('ASUKA_AUDIO_REPLAY_DIR') or PROJECT_ROOT / 'data/chat-audio')
        self.cache_limit = cache_limit
        self.enabled = True
        self.lock = threading.RLock()

    def key(self, message_id):
        if not isinstance(message_id, str) or not message_id:
            raise ValueError('消息没有持久编号，无法保存回放')
        return hashlib.sha256(message_id.encode('utf-8')).hexdigest()

    def forget_message(self, message_id):
        """Remove exactly this logical reply, including a cache left by an interrupted write."""
        with self.lock:
            key = self.key(message_id)
            records = self.root/'records'
            cache = self.root/'cache'
            folder = records/key
            record = folder/'generation.json'
            if any(p.is_symlink() or p.is_junction() for p in (records,cache,folder,record)):
                raise ValueError('回放目录归属无法验证')
            if record.exists():
                self.record(message_id)
            (cache/(key+'.wav')).unlink(missing_ok=True)
            (folder/'codes.npz').unlink(missing_ok=True)
            record.unlink(missing_ok=True)
            if folder.is_dir() and not any(folder.iterdir()): folder.rmdir()

    def forget_session(self,session_id):
        prefix=str(uuid.UUID(session_id))+':'
        unclassified=0
        with self.lock:
            records=self.root/'records'
            if records.is_symlink():raise ValueError('回放存储位置无法验证')
            for folder in records.iterdir() if records.is_dir() else ():
                if folder.is_symlink():raise ValueError('回放目录归属无法验证')
                if not folder.is_dir():continue
                file=folder/'generation.json'
                if not file.exists():
                    unclassified+=int(any(folder.iterdir()));continue
                if folder.is_symlink() or file.is_symlink() or not folder.resolve().is_relative_to((self.root/'records').resolve()):
                    raise ValueError('回放目录归属无法验证')
                try:record=json.loads(file.read_text('utf8'))
                except (UnicodeError,ValueError):
                    unclassified+=1;continue
                if not isinstance(record,dict):unclassified+=1;continue
                message_id=record.get('message_id')
                if not isinstance(message_id,str) or not message_id.startswith(prefix):continue
                if record.get('schema')!='asuka.message-audio/1' or self.key(message_id)!=folder.name:
                    raise ValueError('回放编号与目录不匹配')
                cache=self.root/'cache'/(folder.name+'.wav')
                if (self.root/'cache').is_symlink() or (self.root/'records').is_symlink():
                    raise ValueError('回放存储位置无法验证')
                # Leave the identifying record until its owned payload is gone.
                cache.unlink(missing_ok=True)
                (folder/'codes.npz').unlink(missing_ok=True)
                file.unlink()
                leftovers=list(folder.iterdir())
                if leftovers:unclassified+=len(leftovers)
                else:folder.rmdir()
        return unclassified

    def record(self, message_id):
        file = self.root / 'records' / self.key(message_id) / 'generation.json'
        if not file.exists(): return None
        value = json.loads(file.read_text('utf-8'))
        if value.get('schema') != 'asuka.message-audio/1' or value.get('message_id') != message_id:
            raise ValueError('回放记录与消息不一致')
        return value

    def begin(self, message_id, metadata):
        if not self.enabled or not message_id: return None
        return GenerationRecording(self, message_id, metadata)

    def stage(self, metadata):
        """Keep a speculative recording in memory until it has a published playback ID."""
        return GenerationRecording(self, None, metadata) if self.enabled else None

    def replayable(self, message_id):
        record = self.record(message_id)
        if not record: return False
        key = self.key(message_id)
        return (self.root / 'cache' / (key + '.wav')).is_file() or bool(
            record.get('reconstructable') and (self.root / 'records' / key / 'codes.npz').is_file())

    def _cache(self, key, wave, rate):
        import soundfile as sf
        folder = self.root / 'cache'; folder.mkdir(parents=True, exist_ok=True)
        file = folder / (key + '.wav')
        temporary = folder / (key + '.' + uuid.uuid4().hex + '.tmp')
        sf.write(str(temporary), wave, rate, format='WAV', subtype='FLOAT')
        os.replace(temporary, file)
        # Only this module's disposable cache, never records or user audio.
        files = sorted(folder.glob('*.wav'), key=lambda p: p.stat().st_mtime_ns, reverse=True)
        for stale in files[self.cache_limit:]: stale.unlink(missing_ok=True)
        return file

    def cached(self, message_id):
        import soundfile as sf
        with self.lock:
            record = self.record(message_id)
            if not record: raise ValueError('这条消息没有已生成的音频')
            file = self.root / 'cache' / (self.key(message_id) + '.wav')
            if not file.exists(): return None
            wave, rate = sf.read(str(file), dtype='float32')
            if pcm_hash(wave) != record['pcm_sha256'] or rate != record['sample_rate']:
                raise ValueError('音频缓存与原记录不一致')
            file.touch()
            return wave, rate

    def reconstruct(self, message_id, stop_event, *, resident=None):
        """Return the whole verified original waveform before publishing any PCM."""
        import torch
        from qwen_tts import Qwen3TTSTokenizer
        record = self.record(message_id)
        if not record or not record.get('reconstructable'):
            raise ValueError('该条的原音缓存已淘汰，生成数据不足以还原；不会重新抽样冒充原音')
        info = record['decoder']
        decoder_dir = _verified_decoder_directory(info)
        dtype = getattr(torch, info['dtype'].replace('torch.', ''))
        tokenizer = None
        if resident is not None:
            try:
                if _same_decoder(_decoder_identity(*resident), info):
                    tokenizer = resident[0]
            except OSError:
                # A different, still-resident model can have unavailable source files.
                pass
        if tokenizer is None:
            tokenizer = Qwen3TTSTokenizer.from_pretrained(str(decoder_dir), device_map='cpu',
                                                         torch_dtype=dtype, local_files_only=True)
            tokenizer.model.decoder.to(info['device'])
            tokenizer.device = torch.device(info['device'])
        tokenizer.model.eval()
        parts = []
        file = self.root / 'records' / self.key(message_id) / 'codes.npz'
        try:
            if file_hash(file) != record['codes_sha256']: raise ValueError('声学编码记录已损坏')
            with np.load(file, allow_pickle=False) as archive, torch.inference_mode():
                for item in record['chunks']:
                    if stop_event.is_set() or not self.enabled: return None
                    codes = torch.from_numpy(archive[item['array']].astype(np.int64)).to(info['device'])
                    decoded = tokenizer.model.decoder(codes).detach().float().cpu().numpy().reshape(-1)
                    wave = decoded[item['start']:item['end']].copy()
                    if pcm_hash(wave) != item['pcm_sha256']:
                        raise ValueError('当前解码环境不能精确还原这条原音，已停止回放')
                    parts.append(wave)
            audio = np.concatenate(parts)
            if pcm_hash(audio) != record['pcm_sha256']: raise ValueError('原音还原校验失败')
            with self.lock:
                if self.enabled and not stop_event.is_set(): self._cache(self.key(message_id), audio, record['sample_rate'])
            return audio, record['sample_rate']
        finally:
            del tokenizer
            import gc
            gc.collect()
            if torch.cuda.is_available(): torch.cuda.empty_cache()

class GenerationRecording:
    def __init__(self, store, message_id, metadata):
        self.store, self.message_id, self.metadata = store, message_id, metadata
        self.parts, self.chunks, self.arrays = [], [], {}
        self.pending, self.decoder = [], None
        self.rate, self.error, self.sequence = None, '', 0

    @contextmanager
    def observe(self, tokenizer, model_directory):
        """Observe actual decoder inputs, including ICL prefix or sliding window."""
        handle = None
        try:
            model = tokenizer.model.decoder
            identity = _decoder_identity(tokenizer, model_directory)
            if self.decoder is not None and identity != self.decoder:
                raise ValueError('同条音频的解码模型发生变化')
            self.decoder = identity
            def captured(_module, args, output):
                if not self.store.enabled or self.error: return
                try:
                    codes = args[0].detach().cpu().numpy()
                    if codes.ndim != 3 or codes.shape[:2] != (1, 16) or codes.min() < 0 or codes.max() > 65535:
                        raise ValueError('声学编码形状不受支持')
                    self.sequence += 1
                    self.pending.append((self.sequence, codes.astype(np.uint16),
                        output.detach().float().cpu().numpy().reshape(-1).copy()))
                except Exception as error: self.error = str(error)
            handle = model.register_forward_hook(captured)
        except Exception as error: self.error = str(error)
        try: yield
        finally:
            if handle is not None: handle.remove()

    def chunk(self, audio, rate):
        if not self.store.enabled: return
        wave = np.asarray(audio, dtype=np.float32).reshape(-1).copy()
        self.parts.append(wave)
        if self.rate is not None and self.rate != int(rate): self.error = '音频采样率中途改变'
        self.rate = int(rate)
        if not self.error:
            matches = [(serial,codes,decoded) for serial,codes,decoded in self.pending
                       if len(decoded) >= len(wave) and np.array_equal(decoded[-len(wave):], wave)]
            if len(matches) != 1:
                self.error = '当前分块不能唯一对应原解码结果'
            else:
                serial,codes,decoded = matches[0]
                name = f'chunk_{len(self.chunks):05d}'
                self.arrays[name] = codes
                self.chunks.append({'array':name, 'decoder_call':serial, 'start':len(decoded)-len(wave),
                                    'end':len(decoded), 'pcm_sha256':pcm_hash(wave)})
        self.pending.clear()

    def finish(self, details=None, *, playback_id=None):
        if not self.store.enabled or not self.parts: return None
        if playback_id is not None:
            if self.message_id not in (None, playback_id):
                raise ValueError('回放编号与准备的语音不一致')
            self.message_id = playback_id
        audio = np.concatenate(self.parts)
        if not np.isfinite(audio).all(): raise ValueError('音频包含无效采样，未保存')
        key = self.store.key(self.message_id)
        with self.store.lock:
            # Replay must never silently replace an original recording.
            if self.store.record(self.message_id): return self.message_id
            folder = self.store.root / 'records' / key; folder.mkdir(parents=True, exist_ok=True)
            capable = bool(self.decoder and not self.error and len(self.chunks) == len(self.parts))
            codes_sha = None
            if capable:
                temp = folder / (uuid.uuid4().hex + '.npz')
                np.savez_compressed(temp, **self.arrays)
                os.replace(temp, folder / 'codes.npz')
                codes_sha = file_hash(folder / 'codes.npz')
            record = {'schema':'asuka.message-audio/1','message_id':self.message_id,'created_at':time.time(),
                'sample_rate':self.rate,'samples':len(audio),'pcm_sha256':pcm_hash(audio),
                'reconstructable':capable,'reconstruction_error':self.error,
                'decoder':self.decoder,'codes_sha256':codes_sha,'chunks':self.chunks if capable else [],
                'generation':self.metadata,'actual_generation':details or {}}
            self.store._cache(key, audio, self.rate)
            _write_json(folder / 'generation.json', record)
        return self.message_id
