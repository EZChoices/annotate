const API = 'http://localhost:5000';
const tags = { dialect: null, accent_notes: [], gender: null, speaker_count: null, emotion: null, code_switch: null, topic: null, notes: '' };

const dialects = ['Levantine','Iraqi','Gulf','Yemeni','MSA','Mixed','Other'];
const accents = ['Kurdish influence','Heavy Iraqi','Gulf Arabic','Other'];
const genders = ['Male','Female','Mixed','Unknown'];
const speakers = ['Single','2–3','4+'];
const emotions = ['Neutral','Happy','Angry','Sad','Excited','Other'];
const codeSwitch = ['None','Arabic-English','Arabic-French','Other'];
const topics = ['Lifestyle','Politics','Religion','Comedy','Daily Life','Food','Fashion','Other'];

function createButtons(containerId, list, multi=false) {
  const container = document.getElementById(containerId);
  list.forEach(item => {
    const btn = document.createElement('button');
    btn.innerText = item;
    btn.addEventListener('click', () => {
      if (multi) {
        if (tags[containerId.replace('Buttons','')].includes(item)) {
          tags[containerId.replace('Buttons','')] = tags[containerId.replace('Buttons','')].filter(x => x !== item);
          btn.classList.remove('selected');
        } else {
          tags[containerId.replace('Buttons','')].push(item);
          btn.classList.add('selected');
        }
      } else {
        document.querySelectorAll(`#${containerId} button`).forEach(b => b.classList.remove('selected'));
        tags[containerId.replace('Buttons','')] = item;
        btn.classList.add('selected');
      }
      console.log(tags);
    });
    container.appendChild(btn);
  });
}

createButtons('dialectButtons', dialects);
createButtons('accentButtons', accents, true);
createButtons('genderButtons', genders);
createButtons('speakerButtons', speakers);
createButtons('emotionButtons', emotions);
createButtons('codeSwitchButtons', codeSwitch);
createButtons('topicButtons', topics);

document.getElementById('notesBox').addEventListener('input', e => tags.notes = e.target.value);

document.getElementById('submitBtn').addEventListener('click', async () => {
  const payload = { file_id: 'TEST_FILE_ID', meta: tags };
  await fetch(`${API}/submit_meta`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  alert('✅ Meta saved! Moving to annotation mode...');
  window.location.href = '/annotate.html'; // 🔜 redirect to annotation later
});
