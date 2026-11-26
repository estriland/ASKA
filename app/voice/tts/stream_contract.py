"""Compatibility and ownership of the installed CUDA graph implementation."""
from contextlib import contextmanager
import hashlib
from importlib import metadata
import json
from pathlib import Path
import threading

_owner=threading.Lock()

def check_faster_installation():
    lock=json.loads(Path(__file__).with_name("vendor").joinpath("faster-contract.json").read_text("utf8"))
    suffix=Path(__file__).suffix
    adapter=Path(__file__).with_name("vendor")/("observed_graph"+suffix)
    expected=lock["observed_graph_pyc_sha256" if suffix==".pyc" else "observed_graph_sha256"]
    if hashlib.sha256(adapter.read_bytes()).hexdigest()!=expected:
        raise RuntimeError("Unsupported project voice adapter")
    try:dist=metadata.distribution("faster-qwen3-tts")
    except metadata.PackageNotFoundError as exc:raise RuntimeError("FasterQwen 0.3.2 is required") from exc
    import faster_qwen3_tts
    directory=Path(faster_qwen3_tts.__file__).resolve().parent
    if dist.version!=lock["version"] or directory!=Path(dist.locate_file("faster_qwen3_tts")).resolve():
        raise RuntimeError("Unsupported FasterQwen installation")
    for filename,expected in lock["files"].items():
        if hashlib.sha256((directory/filename).read_bytes()).hexdigest()!=expected:
            raise RuntimeError("Unsupported FasterQwen adapter source: "+filename)

@contextmanager
def own_voice_stream():
    if not _owner.acquire(blocking=False):
        raise RuntimeError("Another local voice stream is active")
    try:
        yield
    finally:
        _owner.release()

class StreamRandomState:
    """Preserve the caller's CPU and selected GPU RNG between PCM chunks."""
    def __init__(self, torch, device, seed):
        self.torch=torch
        self.device=torch.device(device)
        self.cpu=torch.Generator(device="cpu").manual_seed(seed).get_state()
        self.cuda=torch.Generator(device=self.device).manual_seed(seed).get_state()

    @contextmanager
    def advance(self):
        torch=self.torch
        with torch.inference_mode(), torch.cuda.device(self.device), torch.random.fork_rng(devices=[self.device]):
            torch.set_rng_state(self.cpu)
            torch.cuda.set_rng_state(self.cuda,self.device)
            try:
                yield
            finally:
                self.cpu=torch.get_rng_state()
                self.cuda=torch.cuda.get_rng_state(self.device)

class CachedReferenceView:
    """Expose a cached-reference model interface without changing SDK objects."""
    def __init__(self, target, denied, counters, **children):
        self._target=target
        self._denied=denied
        self._counters=counters
        self._children=children

    def __getattr__(self, name):
        if name in self._children:
            return self._children[name]
        if name in self._denied:
            def refuse(*args, **kwargs):
                key=self._denied[name]
                self._counters[key]+=1
                raise RuntimeError("Unexpected reference extraction: "+key)
            return refuse
        return getattr(self._target,name)
