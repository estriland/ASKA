"""Build ASKA's application bytecode and ESM bundles from its public app/ sources."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import py_compile
import subprocess
import sys
import tempfile

ESBUILD_VERSION = "0.25.12"


def digest(file):
    with file.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def write_json(file, value):
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_bytes((json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode())


def build(app, output, esbuild):
    if sys.version_info[:2] != (3, 12):
        raise ValueError("Use the portable CPython 3.12 interpreter to compile ASKA")
    version = subprocess.check_output([str(esbuild), "--version"], text=True).strip()
    if version != ESBUILD_VERSION:
        raise ValueError(f"Expected esbuild {ESBUILD_VERSION}, found {version}")
    app, output = app.resolve(), output.resolve()
    if app == output or output.is_relative_to(app):
        raise ValueError("Choose a new output directory outside the input app")
    output.mkdir(parents=True, exist_ok=False)
    sources, artifacts, bundles = {}, {}, {}
    for directory in ("client", "brain", "voice", "tools"):
        for folder, dirs, files in os.walk(app / directory):
            dirs[:] = sorted(d for d in dirs if d not in ("node_modules", "__pycache__"))
            for name in sorted(files):
                file = Path(folder) / name
                if file.suffix not in (".py", ".mjs"):
                    continue
                rel = file.relative_to(app).as_posix()
                sources[rel] = digest(file)
                if file.suffix == ".py":
                    out = output / (rel + "c")
                    out.parent.mkdir(parents=True, exist_ok=True)
                    py_compile.compile(str(file), str(out), rel, doraise=True, optimize=0,
                                       invalidation_mode=py_compile.PycInvalidationMode.UNCHECKED_HASH)
                    artifacts[rel + "c"] = digest(out)
    cli = "brain/personality/client-packages.mjs"
    with tempfile.TemporaryDirectory() as tmp:
        meta = Path(tmp) / "metafile.json"
        for entry in ("brain/agent-core.mjs", cli):
            out = output / entry
            out.parent.mkdir(parents=True, exist_ok=True)
            args = [str(esbuild), entry, "--bundle", "--format=esm", "--platform=node", "--target=node24",
                    "--packages=external", "--minify", "--charset=utf8", "--log-level=warning",
                    "--outfile=" + str(out), "--metafile=" + str(meta)]
            if entry != cli:
                # The standalone validator checks import.meta.url against argv[1].
                args.append("--external:./personality/client-packages.mjs")
            subprocess.run(args, cwd=app, check=True)
            bundles[entry] = sorted(json.loads(meta.read_text("utf8"))["inputs"])
            artifacts[entry] = digest(out)
    if set().union(*bundles.values()) != {p for p in sources if p.endswith(".mjs")}:
        raise ValueError("Published Node sources differ from the two compiled entry points")
    pin = "voice/tts/vendor/faster-contract.json"
    graph = "voice/tts/vendor/observed_graph.py"
    contract = json.loads((app / pin).read_text("utf8"))
    if contract["observed_graph_sha256"] != sources[graph]:
        raise ValueError("Speech adapter source differs from its reviewed contract")
    contract["observed_graph_pyc_sha256"] = artifacts[graph + "c"]
    write_json(output / pin, contract)
    artifacts[pin] = digest(output / pin)
    report = {"python": sys.version.split()[0], "esbuild": version, "sources": sources,
              "artifacts": artifacts, "esm_inputs": bundles, "contract_source": digest(app / pin)}
    write_json(output / "BUILD_CODE.json", report)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--esbuild", type=Path, required=True)
    args = parser.parse_args()
    build(args.app, args.output, args.esbuild.resolve())
