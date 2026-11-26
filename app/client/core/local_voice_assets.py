"""Resolve the private development bundle's versioned voice asset locations."""
import json
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[2]

def read_voice_template(file):
    config=json.loads(Path(file).read_text(encoding="utf-8"))
    def location(value):
        if not value.startswith("@project/"):
            return value
        resolved=(PROJECT/value[len("@project/"):]).resolve()
        if not resolved.is_relative_to(PROJECT):
            raise ValueError("声音资料路径超出当前项目")
        return str(resolved)
    for key in ("base","dependencies","checkpoint"):
        config["models"][key]=location(config["models"][key])
    config["protected_sources"]={location(k):v for k,v in config["protected_sources"].items()}
    for profile in config["catalog"]["profiles"].values():
        if "bank_path" in profile:profile["bank_path"]=location(profile["bank_path"])
        for item in profile["evidence"]:item["path"]=location(item["path"])
    return config
