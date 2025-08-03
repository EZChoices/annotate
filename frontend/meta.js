const API = 'http://localhost:5000';
// master tag store
const tags = {
  dialect:null, sub_dialect:null, accent_notes:[], gender:null,
  speaker_count:null, emotion:null, code_switch:null, topic:null, notes:''
};

// Option lists
const DIALECTS = {
  'Levantine':['Unspecified','Lebanon','Syria','Jordan','Palestine'],
  'Iraqi':['Unspecified','South Iraqi','Central Iraqi','Kurdish-influenced'],
  'Gulf':['Unspecified','Emirati','Saudi Najdi','Saudi Hijazi','Qatari','Bahraini','Kuwaiti','Omani'],
  'Yemeni':['Unspecified','Sanaani','Taizi-Adeni','Hadhrami'],
  'Egyptian':['Unspecified','Cairene','Saidi','Alexandrian'],
  'Maghrebi':['Unspecified','Moroccan','Algerian','Tunisian','Libyan'],
  'MSA':['Unspecified'],
  'Mixed':['Unspecified'],
  'Other':['Unspecified']
};
const ACCENTS = ['Kurdish influence','Bedouin Najdi','Coastal Syrian','Tripolitan (Lebanon)','Queer Lebanese','Gulf Arabic','Armenian influence','Other'];
const GENDERS = ['Male','Female','Mixed','Unknown'];
const SPEAKERS = ['1','2','3','4','5+'];
const EMOTIONS = ['Neutral','Happy','Angry','Sad','Excited','Other'];
const CODE_SWITCH = ['None','Arabic-English','Arabic-French','Arabic-Other','Other'];
const TOPICS = ['Lifestyle','Comedy','Fashion/Beauty','Food','Travel','Politics','Religion','Technology','Education','Music/Performance','Other'];

// Helper to create button groups
function makeButtons(containerId, list, key, multi=false){
  const box=document.getElementById(containerId);
  list.forEach(item=>{
    const b=document.createElement('button'); b.innerText=item;
    b.addEventListener('click',()=>{
      if(multi){
        const arr=tags[key];
        if(arr.includes(item)){ arr.splice(arr.indexOf(item),1); b.classList.remove('selected'); }
        else { arr.push(item); b.classList.add('selected'); if(item==='Other') document.getElementById(key+'Free').classList.remove('hidden'); }
      }else{
        box.querySelectorAll('button').forEach(btn=>btn.classList.remove('selected'));
        tags[key]=item; b.classList.add('selected');
        if(key==='dialect') buildSubDialect(item);
        if(key==='emotion') toggleOtherBox('emotionOther', item==='Other');
        if(key==='code_switch') toggleOtherBox('codeSwitchOther', item==='Other');
        if(key==='topic') toggleOtherBox('topicOther', item==='Other');
      }
      console.log(tags);
    });
    box.appendChild(b);
  });
}

function toggleOtherBox(id, show){ document.getElementById(id).classList[show?'remove':'add']('hidden'); }

function buildSubDialect(dialect){
  const sel=document.getElementById('subDialectSelect'); sel.innerHTML='';
  DIALECTS[dialect].forEach(opt=>{
    const o=document.createElement('option'); o.value=opt; o.innerText=opt; sel.appendChild(o);} );
  sel.classList.remove('hidden');
  sel.onchange= e=> tags.sub_dialect=e.target.value;
  sel.value='Unspecified'; tags.sub_dialect='Unspecified';
}

// build UI groups
makeButtons('dialectButtons', Object.keys(DIALECTS), 'dialect');
makeButtons('accentButtons', ACCENTS, 'accent_notes', true);
makeButtons('genderButtons', GENDERS, 'gender');
makeButtons('speakerButtons', SPEAKERS, 'speaker_count');
makeButtons('emotionButtons', EMOTIONS, 'emotion');
makeButtons('codeSwitchButtons', CODE_SWITCH, 'code_switch');
makeButtons('topicButtons', TOPICS, 'topic');

// free-text inputs
['accentFree','emotionOther','codeSwitchOther','topicOther'].forEach(id=>{
  const el=document.getElementById(id);
  if(!el) return;
  el.addEventListener('input',e=>{
    if(id==='accentFree') tags.accent_notes_custom=e.target.value.trim();
    if(id==='emotionOther') tags.emotion_other=e.target.value.trim();
    if(id==='codeSwitchOther') tags.code_switch_other=e.target.value.trim();
    if(id==='topicOther') tags.topic_other=e.target.value.trim();
  });
});

document.getElementById('notesBox').addEventListener('input',e=>tags.notes=e.target.value);

document.getElementById('videoPlayer').src = `${API}/samples/` + getFirstMp4();

function getFirstMp4(){
  // naive fetch list via sync XHR (simpler for demo) or hard-code for pilot
  return document.location.search.replace('?file=','') || 'test.mp4';
}

// Submit
async function submit(){
  if(!tags.dialect) return alert('Select dialect first');
  const payload={ file_id:getFirstMp4().replace('.mp4',''), meta:tags };
  await fetch(`${API}/submit_meta`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
  alert('Meta saved! Loading annotation…');
  window.location.href='/annotate.html?file='+getFirstMp4();
}

document.getElementById('submitBtn').addEventListener('click',submit);
