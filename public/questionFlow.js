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
    options: ['Lifestyle', 'Comedy', 'Fashion/Beauty', 'Food', 'Travel', 'Politics', 'Religion', 'Technology', 'Education', 'Music/Performance', 'Other (text input)'],
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

let currentIndex = 0;
const answers = {};

function renderQuestion() {
  const qBox = document.getElementById('questionBox');
  const q = questions[currentIndex];
  qBox.innerHTML = '';

  const prompt = document.createElement('p');
  prompt.textContent = q.prompt;
  qBox.appendChild(prompt);

  if (q.type === 'select') {
    q.options.forEach(opt => {
      const btn = document.createElement('button');
      btn.className = 'option';
      btn.textContent = opt;
      btn.onclick = () => {
        if (opt.toLowerCase().includes('other')) {
          btn.disabled = true;
          btn.classList.add('selected');
          const input = document.createElement('input');
          input.type = 'text';
          input.placeholder = 'Please specify';
          qBox.appendChild(input);
          const nextBtn = document.createElement('button');
          nextBtn.className = 'action';
          nextBtn.textContent = 'Next';
          nextBtn.onclick = () => {
            answers[q.key] = input.value || 'Other';
            currentIndex++;
            nextStep();
          };
          qBox.appendChild(nextBtn);
        } else {
          answers[q.key] = opt;
          currentIndex++;
          nextStep();
        }
      };
      qBox.appendChild(btn);
    });
  } else if (q.type === 'multi') {
    // Detect sub-questions pattern (contains ':')
    if (q.options.some(o => o.includes(':'))) {
      const subAnswers = {};
      q.options.forEach(o => {
        const [label, vals] = o.split(':');
        const lbl = document.createElement('label');
        lbl.textContent = label.trim();
        const select = document.createElement('select');
        vals.trim().split('/').forEach(v => {
          const optEl = document.createElement('option');
          optEl.value = v.trim();
          optEl.textContent = v.trim();
          select.appendChild(optEl);
        });
        subAnswers[label.trim()] = select.value;
        select.onchange = () => {
          subAnswers[label.trim()] = select.value;
        };
        qBox.appendChild(lbl);
        qBox.appendChild(select);
      });
      const nextBtn = document.createElement('button');
      nextBtn.className = 'action';
      nextBtn.textContent = 'Next';
      nextBtn.onclick = () => {
        answers[q.key] = subAnswers;
        currentIndex++;
        nextStep();
      };
      qBox.appendChild(nextBtn);
    } else {
      const selected = new Set();
      q.options.forEach(opt => {
        const btn = document.createElement('button');
        btn.className = 'option';
        btn.textContent = opt;
        btn.onclick = () => {
          if (btn.classList.contains('selected')) {
            btn.classList.remove('selected');
            selected.delete(opt);
            if (opt.toLowerCase().includes('other')) {
              const input = qBox.querySelector('input');
              if (input) input.remove();
            }
          } else {
            btn.classList.add('selected');
            selected.add(opt);
            if (opt.toLowerCase().includes('other')) {
              const input = document.createElement('input');
              input.type = 'text';
              input.placeholder = 'Please specify';
              qBox.appendChild(input);
            }
          }
        };
        qBox.appendChild(btn);
      });
      const nextBtn = document.createElement('button');
      nextBtn.className = 'action';
      nextBtn.textContent = 'Next';
      nextBtn.onclick = () => {
        const otherInput = qBox.querySelector('input');
        const arr = Array.from(selected);
        if (otherInput && otherInput.value) {
          const idx = arr.findIndex(v => v.toLowerCase().includes('other'));
          if (idx !== -1) arr[idx] = otherInput.value;
          else arr.push(otherInput.value);
        }
        answers[q.key] = arr;
        currentIndex++;
        nextStep();
      };
      qBox.appendChild(nextBtn);
    }
  }
}

function showSummary() {
  const qBox = document.getElementById('questionBox');
  const sBox = document.getElementById('summaryBox');
  qBox.classList.add('hidden');
  sBox.classList.remove('hidden');
  sBox.innerHTML = '';

  questions.forEach((q, idx) => {
    const div = document.createElement('div');
    div.className = 'summary-item';
    const title = document.createElement('strong');
    title.textContent = q.prompt;
    div.appendChild(title);
    const val = document.createElement('div');
    val.textContent = JSON.stringify(answers[q.key]);
    div.appendChild(val);
    const editBtn = document.createElement('button');
    editBtn.className = 'option';
    editBtn.textContent = 'Edit';
    editBtn.onclick = () => {
      currentIndex = idx;
      sBox.classList.add('hidden');
      qBox.classList.remove('hidden');
      renderQuestion();
    };
    div.appendChild(editBtn);
    sBox.appendChild(div);
  });

  const confirmBtn = document.createElement('button');
  confirmBtn.className = 'action';
  confirmBtn.textContent = 'Confirm & Finish';
  confirmBtn.onclick = () => {
    console.log('Final Answers:', answers);
    alert('Answers logged to console');
  };
  sBox.appendChild(confirmBtn);
}

function nextStep() {
  if (currentIndex >= questions.length) {
    showSummary();
  } else {
    renderQuestion();
  }
}

// Start
nextStep();
