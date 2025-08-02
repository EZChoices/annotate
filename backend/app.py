import os, json
from flask import Flask, jsonify, request, send_from_directory, render_template
from flask_cors import CORS

app = Flask(
    __name__, static_folder='../frontend', template_folder='../frontend', static_url_path=''
)
CORS(app)

SAMPLES_DIR = os.path.join(os.path.dirname(__file__), '..', 'samples')
SPLIT_DIR = os.path.join(SAMPLES_DIR, 'split_test')
os.makedirs(SPLIT_DIR, exist_ok=True)

MAX_SEG_LEN = 7.0
MIN_SEG_LEN = 5.0
PUNCTUATION = ['،', '.', '؟', '!']


def split_segment(seg):
    start, end, text = seg['start'], seg['end'], seg['text']
    duration = end - start
    if duration <= MAX_SEG_LEN:
        return [seg]

    words = text.split(' ')
    parts = []
    chunk_words = []
    chunk_start = start

    for word in words:
        chunk_words.append(word)
        elapsed = duration * (len(' '.join(chunk_words)) / len(text))
        if any(p in word for p in PUNCTUATION) and elapsed >= MIN_SEG_LEN:
            chunk_text = ' '.join(chunk_words).strip()
            chunk_end = chunk_start + elapsed
            parts.append({'start': chunk_start, 'end': chunk_end, 'speaker': seg['speaker'], 'text': chunk_text})
            chunk_start = chunk_end
            chunk_words = []

    if chunk_words:
        chunk_text = ' '.join(chunk_words).strip()
        parts.append({'start': chunk_start, 'end': end, 'speaker': seg['speaker'], 'text': chunk_text})

    final_parts = []
    for p in parts:
        seg_len = p['end'] - p['start']
        if seg_len > MAX_SEG_LEN:
            cur_start = p['start']
            while cur_start < p['end']:
                cur_end = min(cur_start + MAX_SEG_LEN, p['end'])
                final_parts.append({'start': cur_start, 'end': cur_end, 'speaker': p['speaker'], 'text': p['text']})
                cur_start = cur_end
        else:
            final_parts.append(p)
    return final_parts


def ensure_split_json(json_filename):
    original_path = os.path.join(SAMPLES_DIR, json_filename)
    split_path = os.path.join(SPLIT_DIR, json_filename)

    if os.path.exists(split_path):
        return split_path

    with open(original_path, 'r', encoding='utf-8') as f:
        data = json.load(f)

    new_segments = []
    for seg in data['segments']:
        new_segments.extend(split_segment(seg))

    data['segments'] = new_segments
    data['metadata']['segment_count'] = len(new_segments)
    data['metadata']['tool_version'] += '_split5to7'

    with open(split_path, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=2, ensure_ascii=False)

    print(f'✅ Split created: {split_path}')
    return split_path


@app.route('/meta')
def meta_screen():
    return render_template('meta.html')


@app.route('/submit_meta', methods=['POST'])
def submit_meta():
    data = request.json
    print('\n✅ META SUBMISSION RECEIVED:\n', json.dumps(data, indent=2, ensure_ascii=False))
    return jsonify({'status': 'ok', 'message': 'Meta saved'})


@app.route('/clip', methods=['GET'])
def get_clip():
    mp4_files = [f for f in os.listdir(SAMPLES_DIR) if f.endswith('.mp4')]
    json_files = [f for f in os.listdir(SAMPLES_DIR) if f.endswith('.json')]

    if not mp4_files or not json_files:
        return jsonify({'error': 'No sample MP4 or JSON found in /samples/'}), 404

    mp4_file = mp4_files[0]
    json_file = json_files[0]

    # ✅ Auto split if needed
    json_path = ensure_split_json(json_file)

    with open(json_path, 'r', encoding='utf-8') as f:
        transcript_data = json.load(f)

    return jsonify({
        'video_url': f'/samples/{mp4_file}',
        'transcript': transcript_data
    })


@app.route('/samples/<path:filename>', methods=['GET'])
def serve_media(filename):
    return send_from_directory(SAMPLES_DIR, filename)


@app.route('/submit', methods=['POST'])
def submit_annotations():
    data = request.json
    print('✅ Annotation submitted:', data)
    return jsonify({'status': 'ok', 'message': 'Annotation received'})


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=True)

