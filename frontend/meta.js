// ======== CONFIG ========
const API='http://localhost:5000';
const tags={
  dialect:null,sub_dialect:null,accent_notes:[],accent_notes_custom:'',
  gender:null,age:null,speaker_count:null,
  emotion:[],emotion_other:'',
  code_switch:null,code_switch_other:'',
  topic:null,topic_other:'',
  environment:null,environment_other:'',
  face_visible:null,lip_visible:null,
  facial_expression:null,facial_expression_other:'',
  gestures_visible:null,
  notes:''
};

// ---------- Option lists ----------
const DIALECTS={
  'Levantine':['Unspecified','Syria','Jordan','Palestine','Lebanon'],
  'Iraqi':['Unspecified','South Iraqi','Central Iraqi','Kurdish-influenced'],
  'Gulf':['Unspecified','Emirati','Saudi Najdi','Saudi Hijazi','Qatari','Bahraini','Kuwaiti','Omani'],
  'Yemeni':['Unspecified','Sanaani','Taizi-Adeni','Hadhrami'],
  'Egyptian':['Unspecified','Cairene','Saidi','Alexandrian'],
  'Maghrebi':['Unspecified','Moroccan','Algerian','Tunisian','Libyan'],
  'MSA':['Unspecified'],
  'Mixed':['Unspecified'],
  'Other':['Unspecified']
};
// --- Lebanese sub-regions ---
const LEB_SUB=['Beirut','Tripoli/North','South Lebanon','Bekaa','Mount Lebanon','Akkar','Other LB'];

const ACCENTS=[
  'Kurdish influence','Bedouin Najdi','Coastal Syrian','Tripolitan',
  'Queer Lebanese','Gulf Arabic','Armenian influence','South Lebanese',
  'Bekaa Rural','Urban Beirut','Chouf','Palestinian Lebanese','Other'
];
const GENDERS=['Male','Female','Mixed','Unknown'];
const AGES=['Child','Teen','Young Adult','Adult','Elderly','Unknown'];
const SPEAKERS=['1','2','3','4','5+'];
const EMOTIONS=['Neutral','Happy','Angry','Sad','Excited','Other'];
const CODE_SWITCH=['None','Arabic-English','Arabic-French','Arabic-Other','Other'];
const TOPICS=['Lifestyle','Comedy','Fashion/Beauty','Food','Travel','Politics','Religion','Technology','Education','Music/Performance','Other'];
const ENVIRON=['Indoor','Outdoor','Street noise','Café noise','Background music','Quiet/Studio','Other'];
const FACE_VIS=['Yes','Partially','No'];
const LIP_VIS=['Yes','No'];
const EXPRESSIONS=['Neutral','Smiling','Laughing','Angry','Surprised','Sarcastic','Unknown','Other'];
const GESTURES=['Yes','No'];

// ---------- UI helpers ----------
function makeButtons(containerId,list,key,{multi=false,otherBox=null}={}){
  const box=document.getElementById(containerId);
  list.forEach(item=>{
    const b=document.createElement('button');b.innerText=item;
    b.addEventListener('click',()=>{
      if(multi){
        const arr=tags[key];
        if(arr.includes(item)){arr.splice(arr.indexOf(item),1);b.classList.remove('selected');}
        else{arr.push(item);b.classList.add('selected');if(item==='Other'&&otherBox)toggle(otherBox,true);}
      }else{
        box.querySelectorAll('button').forEach(btn=>btn.classList.remove('selected'));
        tags[key]=item;b.classList.add('selected');
        if(key==='dialect')handleDialectChange(item);
        if(otherBox)toggle(otherBox,item==='Other');
      }
      console.log(tags);
    });
    box.appendChild(b);
  });
}
function toggle(id,show){document.getElementById(id).classList[show?'remove':'add']('hidden');}

// ---------- Build groups ----------
makeButtons('dialectButtons',Object.keys(DIALECTS),'dialect');
makeButtons('accentButtons',ACCENTS,'accent_notes',{multi:true,otherBox:'accentFree'});
makeButtons('genderButtons',GENDERS,'gender');
makeButtons('ageButtons',AGES,'age');
makeButtons('speakerButtons',SPEAKERS,'speaker_count');
makeButtons('emotionButtons',EMOTIONS,'emotion',{multi:true,otherBox:'emotionOther'});
makeButtons('codeSwitchButtons',CODE_SWITCH,'code_switch',{otherBox:'codeSwitchOther'});
makeButtons('topicButtons',TOPICS,'topic',{otherBox:'topicOther'});
makeButtons('envButtons',ENVIRON,'environment',{otherBox:'envOther'});
makeButtons('faceButtons',FACE_VIS,'face_visible');
makeButtons('lipButtons',LIP_VIS,'lip_visible');
makeButtons('exprButtons',EXPRESSIONS,'facial_expression',{otherBox:'exprOther'});
makeButtons('gestButtons',GESTURES,'gestures_visible');

document.getElementById('notesBox').addEventListener('input',e=>tags.notes=e.target.value);
document.getElementById('accentFree').addEventListener('input',e=>tags.accent_notes_custom=e.target.value.trim());
document.getElementById('emotionOther').addEventListener('input',e=>tags.emotion_other=e.target.value.trim());
document.getElementById('codeSwitchOther').addEventListener('input',e=>tags.code_switch_other=e.target.value.trim());
document.getElementById('topicOther').addEventListener('input',e=>tags.topic_other=e.target.value.trim());
document.getElementById('envOther').addEventListener('input',e=>tags.environment_other=e.target.value.trim());
document.getElementById('exprOther').addEventListener('input',e=>tags.facial_expression_other=e.target.value.trim());

// ---------- Dialect / sub-dialect logic ----------
function handleDialectChange(dialect){
  const sel=document.getElementById('subDialectSelect');sel.innerHTML='';
  let list=DIALECTS[dialect];
  if(dialect==='Levantine'&&tags.sub_dialect==='Lebanon')list=LEB_SUB; // we’ll update once LB picked
  list.forEach(opt=>{const o=document.createElement('option');o.value=opt;o.innerText=opt;sel.appendChild(o);});
  sel.classList.remove('hidden');
  sel.onchange=e=>tags.sub_dialect=e.target.value;
  sel.value=list[0];tags.sub_dialect=list[0];
  // If Levantine-Lebanon is later selected, we rebuild options again
  if(dialect==='Levantine')sel.onchange=(e)=>{
    if(e.target.value==='Lebanon'){buildLebaneseSubs();}
    tags.sub_dialect=e.target.value;
  };
}
function buildLebaneseSubs(){
  const sel=document.getElementById('subDialectSelect');sel.innerHTML='';
  LEB_SUB.forEach(opt=>{const o=document.createElement('option');o.value=opt;o.innerText=opt;sel.appendChild(o);});
  sel.value=LEB_SUB[0];tags.sub_dialect=LEB_SUB[0];
}

// ---------- Video source ----------
const file=(new URLSearchParams(location.search)).get('file')||'test.mp4';
document.getElementById('videoPlayer').src=`${API}/samples/${file}`;

// ---------- Submit ----------
async function submit(){
  if(!tags.dialect) return alert('Select dialect');
  const payload={file_id:file.replace('.mp4',''),meta:tags};
  await fetch(`${API}/submit_meta`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
  alert('Meta saved! Loading annotation…');
  window.location.href=`/annotate.html?file=${file}`;
}
document.getElementById('submitBtn').addEventListener('click',submit);

