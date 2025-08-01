from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS
import os, json

app = Flask(__name__)
CORS(app)

SAMPLES_DIR = os.path.join(os.path.dirname(__file__), '..', 'samples')


@app.route('/clip', methods=['GET'])
def get_clip():
    """Return the first MP4/JSON pair from the samples folder."""
    mp4_files = [f for f in os.listdir(SAMPLES_DIR) if f.endswith('.mp4')]
    json_files = [f for f in os.listdir(SAMPLES_DIR) if f.endswith('.json')]

    if not mp4_files or not json_files:
        return jsonify({'error': 'No sample MP4 or JSON found in /samples/'}), 404

    mp4_file = mp4_files[0]
    json_file = json_files[0]

    with open(os.path.join(SAMPLES_DIR, json_file), 'r', encoding='utf-8') as f:
        transcript_data = json.load(f)

    return jsonify({
        'video_url': f'/samples/{mp4_file}',
        'transcript': transcript_data
    })


@app.route('/samples/<path:filename>', methods=['GET'])
def serve_media(filename):
    """Serve sample video or JSON."""
    return send_from_directory(SAMPLES_DIR, filename)


@app.route('/submit', methods=['POST'])
def submit_annotations():
    """Receive annotation payload from frontend."""
    data = request.json
    print("✅ Annotation submitted:", data)
    return jsonify({'status': 'ok', 'message': 'Annotation received'})


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=True)
