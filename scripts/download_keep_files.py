import os
from pathlib import Path
from typing import List
import requests

SUPABASE_URL = os.environ.get("NEXT_PUBLIC_SUPABASE_URL")
SUPABASE_SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_KEY")
BUNNY_STORAGE_ZONE = os.environ.get("BUNNY_STORAGE_ZONE")
BUNNY_STORAGE_PASSWORD = os.environ.get("BUNNY_STORAGE_PASSWORD")
FILTERED_FOLDER = os.environ.get("FILTERED_FOLDER", "")
DOWNLOAD_DIR = os.environ.get("DOWNLOAD_DIR", "downloads")
SUPABASE_TABLE = os.environ.get("SUPABASE_KEEP_TABLE", "keep")
SUPABASE_FILE_COL = os.environ.get("SUPABASE_FILE_COL", "file_name")


class ConfigError(Exception):
    pass


def _require(var: str, value: str) -> str:
    if not value:
        raise ConfigError(f"Missing required environment variable: {var}")
    return value


def fetch_keep_file_names() -> List[str]:
    """Return list of file names from the Supabase `keep` table."""
    url = _require("NEXT_PUBLIC_SUPABASE_URL", SUPABASE_URL)
    key = _require("SUPABASE_SERVICE_KEY", SUPABASE_SERVICE_KEY)

    endpoint = f"{url}/rest/v1/{SUPABASE_TABLE}?select={SUPABASE_FILE_COL}"
    headers = {"apikey": key, "Authorization": f"Bearer {key}"}
    resp = requests.get(endpoint, headers=headers, timeout=10)
    resp.raise_for_status()
    rows = resp.json()
    return [row[SUPABASE_FILE_COL] for row in rows if SUPABASE_FILE_COL in row]


def download_from_bunny(file_name: str) -> Path:
    """Download a file from Bunny Storage and return the local path."""
    zone = _require("BUNNY_STORAGE_ZONE", BUNNY_STORAGE_ZONE)
    password = _require("BUNNY_STORAGE_PASSWORD", BUNNY_STORAGE_PASSWORD)

    base = f"https://storage.bunnycdn.com/{zone}"
    if FILTERED_FOLDER:
        base += f"/{FILTERED_FOLDER.strip('/')}"
    url = f"{base}/{file_name}"

    headers = {"AccessKey": password}
    resp = requests.get(url, headers=headers, timeout=30)
    resp.raise_for_status()

    dest_dir = Path(DOWNLOAD_DIR)
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest_path = dest_dir / file_name
    with open(dest_path, "wb") as f:
        f.write(resp.content)
    return dest_path


def main():
    names = fetch_keep_file_names()
    for name in names:
        path = download_from_bunny(name)
        print(f"Downloaded {name} -> {path}")


if __name__ == "__main__":
    main()
