import os, json, pathlib

# === CONFIG ===
SAMPLES_DIR = pathlib.Path(r"./samples")  # where sample .json lives
OUT_DIR = pathlib.Path(r"./samples/split_test")
OUT_DIR.mkdir(parents=True, exist_ok=True)

TARGET_MAX_LEN = 7.0  # hard max chunk length
TARGET_MIN_LEN = 5.0  # ideal chunk length range
PUNCTUATION = [".", ",", "?", "!"]


def split_segment(seg):
    start = seg["start"]
    end = seg["end"]
    text = seg["text"]
    duration = end - start

    # If already short enough, return as-is
    if duration <= TARGET_MAX_LEN:
        return [seg]

    # First try to split by punctuation
    words = text.split(" ")
    parts = []
    chunk_words = []
    chunk_start = start
    elapsed = 0.0

    for word in words:
        chunk_words.append(word)
        elapsed = duration * (len(" ".join(chunk_words)) / max(1, len(text)))

        # If we hit punctuation and chunk is > TARGET_MIN_LEN or segment is almost done
        if any(p in word for p in PUNCTUATION) and elapsed >= TARGET_MIN_LEN:
            chunk_text = " ".join(chunk_words).strip()
            chunk_end = chunk_start + elapsed
            parts.append({
                "start": chunk_start,
                "end": chunk_end,
                "speaker": seg.get("speaker"),
                "text": chunk_text
            })
            chunk_start = chunk_end
            chunk_words = []

    # Add leftover chunk if any
    if chunk_words:
        chunk_text = " ".join(chunk_words).strip()
        parts.append({
            "start": chunk_start,
            "end": end,
            "speaker": seg.get("speaker"),
            "text": chunk_text
        })

    # If punctuation splitting still left >7s chunks, cut by time
    final_parts = []
    for p in parts:
        if (p["end"] - p["start"]) > TARGET_MAX_LEN:
            cur_start = p["start"]
            while cur_start < p["end"]:
                cur_end = min(cur_start + TARGET_MAX_LEN, p["end"])
                final_parts.append({
                    "start": cur_start,
                    "end": cur_end,
                    "speaker": p.get("speaker"),
                    "text": p.get("text")
                })
                cur_start = cur_end
        else:
            final_parts.append(p)

    return final_parts


# === PROCESS ONE SAMPLE JSON ===
for jf in SAMPLES_DIR.glob("*.json"):
    with open(jf, "r", encoding="utf-8") as f:
        data = json.load(f)

    new_segments = []
    for seg in data.get("segments", []):
        new_segments.extend(split_segment(seg))

    data["segments"] = new_segments
    if "metadata" not in data:
        data["metadata"] = {}
    data["metadata"]["segment_count"] = len(new_segments)
    data["metadata"]["tool_version"] = str(data["metadata"].get("tool_version", "")) + "_split_test"

    out_path = OUT_DIR / jf.name
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)

print("Segment splitting complete — check samples/split_test/")

