let tags = { dialect: null, gender: null, accent: null };
let transcriptSegments = []; // ✅ stores editable transcript segments

function setTag(type, value) {
  tags[type] = value;
  console.log(`✅ ${type} set to`, value);
}

function renderSegments(segments) {
  const container = document.getElementById('segmentsList');
  container.innerHTML = '';

  segments.forEach((seg, idx) => {
    const segDiv = document.createElement('div');
    segDiv.className = 'segment';

    // Segment header: time range + speaker
    const header = document.createElement('div');
    header.className = 'segment-header';
    header.innerText = `[${seg.start.toFixed(2)} – ${seg.end.toFixed(2)}] ${seg.speaker}`;
    segDiv.appendChild(header);

    // Segment text (editable inline)
    const text = document.createElement('textarea');
    text.className = 'segment-text';
    text.rows = 2;
    text.value = seg.text;
    text.addEventListener('input', e => transcriptSegments[idx].text = e.target.value);
    segDiv.appendChild(text);

    // Play button
    const playBtn = document.createElement('button');
    playBtn.className = 'small';
    playBtn.innerText = '▶ Play';
    playBtn.addEventListener('click', () => playSegment(seg.start, seg.end));
    segDiv.appendChild(playBtn);

    container.appendChild(segDiv);
  });
}

function playSegment(start, end) {
  const video = document.getElementById('videoPlayer');
  video.currentTime = start;
  video.play();

  // Stop video after segment end (with +1 sec buffer)
  setTimeout(() => {
    if (video.currentTime >= end + 1) {
      video.pause();
    }
  }, ((end - start) + 1) * 1000);
}

async function loadClip() {
  const res = await fetch('http://localhost:5000/clip');
  const data = await res.json();

  if (data.error) {
    alert(data.error);
    return;
  }

  // ✅ Set video player source
  document.getElementById('videoPlayer').src = 'http://localhost:5000' + data.video_url;

  // ✅ Store segments & render list
  transcriptSegments = data.transcript.segments;
  renderSegments(transcriptSegments);
}

async function submitAnnotation() {
  const payload = { transcript: transcriptSegments, tags };

  await fetch('http://localhost:5000/submit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  alert('✅ Annotation submitted!');
}

// ✅ Button listeners
document.getElementById('submitBtn').addEventListener('click', submitAnnotation);
document.getElementById('flagBtn').addEventListener('click', () => { alert('🚩 Clip flagged!'); });

// ✅ Load first clip on page load
loadClip();
