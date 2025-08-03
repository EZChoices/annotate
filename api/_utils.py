import json
from pathlib import Path

def load_json(path: str):
    with open(Path(path), "r", encoding="utf-8") as f:
        return json.load(f)
