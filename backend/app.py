from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS
import os, json

app = Flask(__name__)
CORS(app)

SAMPLES_DIR = os.path.join(os.path.dirname(__file__), '..', 'samples')


@app.route('/clip', methods=['GET'])
def get_clip():
    """Return the first WAV/JSON pair from the samples folder."""
    wav_files = [f for f in os.listdir(SAMPLES_DIR) if f.endswith('.wav')]
    json_files = [f for f in os.listdir(SAMPLES_DIR) if f.endswith('.json')]

    if not wav_files or not json_files:
        return jsonify({'error': 'No sample files found in /samples/'}), 404

    wav_file = wav_files[0]
    json_file = json_files[0]

    with open(os.path.join(SAMPLES_DIR, json_file), 'r', encoding='utf-8') as f:
        transcript_data = json.load(f)

    return jsonify({
        'audio_url': f'/samples/{wav_file}',
        'transcript': transcript_data
    })


@app.route('/samples/<path:filename>', methods=['GET'])
def serve_audio(filename):
    """Serve sample audio or JSON."""
    return send_from_directory(SAMPLES_DIR, filename)


@app.route('/submit', methods=['POST'])
def submit_annotations():
    """Receive annotation payload from frontend."""
    data = request.json
    print("✅ Annotation submitted:", data)
    return jsonify({'status': 'ok', 'message': 'Annotation received'})


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=True)
