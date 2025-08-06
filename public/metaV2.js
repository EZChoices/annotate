const questions = [
  {
    key: 'country',
    prompt: 'Where is the speaker likely from?',
    type: 'select',
    options: ['Lebanon', 'Iraq', 'Syria', 'Yemen', 'Gulf', 'Egypt', 'Maghreb', 'MSA', 'Mixed', 'Other']
  },
  {
    key: 'subregion',
    prompt: 'Which region in Lebanon?',
    type: 'select',
    options: ['Beirut', 'Tripoli', 'South', 'Bekaa', 'Mount Lebanon', 'Akkar', 'Other']
  },
  {
    key: 'accent',
    prompt: 'How would you describe the accent?',
    type: 'multi',
    options: ['Urban Beirut', 'Tripolitan', 'Queer Lebanese', 'South Lebanese', 'Bekaa Rural', 'Chouf', 'Palestinian Lebanese', 'Other (text input)']
  },
  {
    key: 'gender',
    prompt: 'What is the dominant gender of speakers?',
    type: 'select',
    options: ['Male', 'Female', 'Mixed', 'Unknown']
  },
  {
    key: 'age',
    prompt: 'What is the apparent age group?',
    type: 'select',
    options: ['Child', 'Teen', 'Young Adult', 'Adult', 'Elderly', 'Unknown']
  },
  {
    key: 'speakerCount',
    prompt: 'How many people are speaking?',
    type: 'select',
    options: ['1', '2', '3', '4', '5+']
  },
  {
    key: 'emotion',
    prompt: 'What emotion(s) do you detect?',
    type: 'multi',
    options: ['Neutral', 'Happy', 'Angry', 'Sad', 'Excited', 'Other (text input)']
  },
  {
    key: 'codeSwitch',
    prompt: 'Is there any code-switching?',
    type: 'select',
    options: ['None', 'Arabic-English', 'Arabic-French', 'Arabic-Other', 'Other (text input)']
  },
  {
    key: 'topic',
    prompt: "What's the main topic of this clip?",
    type: 'select',
    options: ['Lifestyle', 'Comedy', 'Fashion/Beauty', 'Food', 'Travel', 'Politics', 'Religion', 'Technology', 'Education', 'Music/Performance', 'Other (text input)']
  },
  {
    key: 'environment',
    prompt: 'Where is this recorded?',
    type: 'select',
    options: ['Indoor', 'Outdoor', 'Street noise', 'Background music', 'Café noise', 'Quiet/Studio', 'Other (text input)']
  },
  {
    key: 'visuals',
    prompt: 'Can you clearly see the speaker?',
    type: 'multi',
    options: [
      'Face clearly visible: Yes/Partially/No',
      'Lip visibility: Yes/No',
      'Facial expression: Neutral/Smiling/Laughing/Angry/Surprised/Sarcastic/Unknown',
      'Gestures visible: Yes/No'
    ]
  }
];

const answers = {};
const list = document.getElementById('commentList');

questions.forEach(q => {
  const item = document.createElement('div');
  item.className = 'comment';
  const prompt = document.createElement('p');
  prompt.textContent = q.prompt;
  item.appendChild(prompt);

  if (q.type === 'select') {
    const select = document.createElement('select');
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = '-- select --';
    placeholder.disabled = true;
    placeholder.selected = true;
    select.appendChild(placeholder);
    q.options.forEach(opt => {
      const o = document.createElement('option');
      o.value = opt;
      o.textContent = opt;
      select.appendChild(o);
    });
    select.onchange = () => { answers[q.key] = select.value; };
    item.appendChild(select);
  } else if (q.type === 'multi') {
    const selected = [];
    q.options.forEach(opt => {
      if (opt.includes('text input')) {
        const input = document.createElement('input');
        input.type = 'text';
        input.placeholder = opt.replace(' (text input)', '');
        input.oninput = () => {
          const val = input.value.trim();
          const idx = selected.findIndex(v => v.startsWith('Other:'));
          if (val) {
            const entry = `Other: ${val}`;
            if (idx > -1) selected[idx] = entry; else selected.push(entry);
          } else if (idx > -1) {
            selected.splice(idx, 1);
          }
          answers[q.key] = selected.slice();
        };
        item.appendChild(input);
      } else {
        const label = document.createElement('label');
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.value = opt;
        box.onchange = () => {
          if (box.checked) selected.push(opt); else selected.splice(selected.indexOf(opt), 1);
          answers[q.key] = selected.slice();
        };
        label.appendChild(box);
        label.appendChild(document.createTextNode(opt));
        item.appendChild(label);
      }
    });
  }

  list.appendChild(item);
});

document.getElementById('submitBtn').onclick = () => {
  console.log(answers);
};

document.getElementById('modeToggle').onclick = () => {
  document.body.classList.toggle('light-mode');
  document.body.classList.toggle('dark-mode');
};
