(function(global){
  "use strict";

  const STORAGE_KEY = 'qa_report';
  const REVIEW_STATUSES = ['accepted', 'corrected', 'rejected'];

  function getReviewerId(){
    const key = 'ea_stage2_reviewer_id';
    try{
      const existing = localStorage.getItem(key);
      if(existing){
        return existing;
      }
    }catch{}
    try{
      const annotator = localStorage.getItem('ea_stage2_annotator_id');
      if(annotator){
        localStorage.setItem(key, annotator);
        return annotator;
      }
    }catch{}
    return 'reviewer';
  }

  function parseReportFromStorage(){
    try{
      const raw = localStorage.getItem(STORAGE_KEY);
      if(!raw){ return null; }
      return JSON.parse(raw);
    }catch(err){
      console.warn('Stage2Review: unable to parse QA report', err);
      return null;
    }
  }

  function normalizeJson(raw){
    if(!raw){ return ''; }
    if(typeof raw === 'string'){
      const text = raw.trim();
      if(!text){ return ''; }
      try{
        const parsed = JSON.parse(text);
        return JSON.stringify(parsed, null, 2);
      }catch{
        return raw;
      }
    }
    try{
      return JSON.stringify(raw, null, 2);
    }catch{
      return '';
    }
  }

  const Stage2Review = {
    state: {
      flagged: [],
      report: null,
      history: null,
      entryIndex: null,
      entry: null,
      selectedClipId: null,
      selectedClip: null,
      originalFiles: null,
      originalStatus: null,
      pendingStatus: null,
      editEnabled: false,
      dirty: false,
    },
    elements: {},

    init(){
      const modal = document.getElementById('qaReviewModal');
      if(!modal){
        return;
      }
      this.elements.modal = modal;
      this.elements.clipList = document.getElementById('qaReviewClipList');
      this.elements.empty = document.getElementById('qaReviewEmpty');
      this.elements.meta = document.getElementById('qaReviewMeta');
      this.elements.statusLabel = document.getElementById('qaReviewStatusLabel');
      this.elements.editToggle = document.getElementById('qaReviewEnableEdit');
      this.elements.saveButton = document.getElementById('qaReviewSave');
      this.elements.cancelButton = document.getElementById('qaReviewCancel');
      this.elements.flaggedCount = document.getElementById('qaReviewFlaggedCount');
      this.elements.fields = {
        transcript: document.getElementById('qaReviewTranscript'),
        translation: document.getElementById('qaReviewTranslation'),
        codeSwitch: document.getElementById('qaReviewCodeSwitch'),
        codeSwitchSpans: document.getElementById('qaReviewCodeSwitchSpans'),
        diarization: document.getElementById('qaReviewDiarization'),
      };
      this.elements.statusButtons = Array.from(modal.querySelectorAll('[data-review-status]'));
      this.elements.closeButtons = Array.from(modal.querySelectorAll('[data-action="close"]'));

      this.attachEvents();
      this.applyReadOnly(true);
      this.updateMeta('Select a clip to load its annotations.');
      this.setStatusButtons(null);
      this.updateStatusLabel(null);
      this.setDirty(false);
      if(this.elements.editToggle){
        this.elements.editToggle.checked = false;
        this.elements.editToggle.disabled = true;
      }

      // If modal is triggered elsewhere, ensure Stage2Review.open works.
      global.Stage2Review = this;
    },

    attachEvents(){
      const { modal, editToggle, saveButton, cancelButton, statusButtons, closeButtons, fields } = this.elements;
      if(closeButtons){
        closeButtons.forEach((btn)=>{
          btn.addEventListener('click', ()=> this.close());
        });
      }
      if(modal){
        modal.addEventListener('keydown', (event)=>{
          if(event.key === 'Escape'){
            event.preventDefault();
            this.close();
          }
        });
      }
      if(editToggle){
        editToggle.addEventListener('change', ()=>{
          if(!this.state.entry){
            editToggle.checked = false;
            return;
          }
          this.setEditing(editToggle.checked);
        });
      }
      if(saveButton){
        saveButton.addEventListener('click', ()=> this.save());
      }
      if(cancelButton){
        cancelButton.addEventListener('click', ()=> this.cancel());
      }
      if(statusButtons){
        statusButtons.forEach((btn)=>{
          btn.addEventListener('click', ()=>{
            const status = btn.getAttribute('data-review-status');
            this.handleStatusSelection(status);
          });
        });
      }
      if(fields){
        Object.values(fields).forEach((field)=>{
          if(!field) return;
          field.addEventListener('input', ()=>{
            this.setDirty(this.hasChanges());
          });
        });
      }
    },

    open(){
      const modal = this.elements.modal;
      if(!modal){ return; }
      this.refreshFlaggedClips();
      modal.classList.remove('hide');
      modal.setAttribute('aria-hidden', 'false');
      const close = modal.querySelector('.qa-review-close');
      if(close){ try{ close.focus(); }catch{} }
    },

    close(){
      const modal = this.elements.modal;
      if(!modal){ return; }
      modal.classList.add('hide');
      modal.setAttribute('aria-hidden', 'true');
      this.clearSelection();
      if(global.Stage2QADashboard && typeof global.Stage2QADashboard.refresh === 'function'){
        global.Stage2QADashboard.refresh();
      }
    },

    isClipFlagged(clip){
      if(global.Stage2QADashboard && typeof global.Stage2QADashboard.isClipFlagged === 'function'){
        return global.Stage2QADashboard.isClipFlagged(clip);
      }
      if(!clip || clip.locked){ return false; }
      const metrics = clip.metrics || {};
      const f1 = typeof metrics.codeswitch_f1 === 'number' ? metrics.codeswitch_f1 : null;
      const diar = typeof metrics.diarization_mae === 'number' ? metrics.diarization_mae : null;
      const status = (clip.qaStatus || '').toLowerCase();
      if(Number.isFinite(f1) && f1 < 0.8) return true;
      if(Number.isFinite(diar) && diar > 0.5) return true;
      if(status === 'fail' || status === 'error') return true;
      return false;
    },

    refreshFlaggedClips(){
      let report = null;
      if(global.Stage2QADashboard && typeof global.Stage2QADashboard.refresh === 'function'){
        report = global.Stage2QADashboard.refresh();
      } else {
        report = parseReportFromStorage();
      }
      this.state.report = report;
      const clips = report && Array.isArray(report.clips) ? report.clips : [];
      const flagged = clips.filter((clip)=> this.isClipFlagged(clip));
      this.state.flagged = flagged;
      this.renderClipList(flagged);
      if(this.state.selectedClipId){
        const updated = clips.find((clip)=> clip && clip.clipId === this.state.selectedClipId);
        if(updated){
          this.state.selectedClip = updated;
          const status = this.normalizeStatus(this.state.pendingStatus) || this.normalizeStatus(this.state.originalStatus);
          this.updateMeta(this.describeClip(updated, status));
        }
      }
      if(!flagged.length){
        this.clearSelection();
      }
      return flagged;
    },

    renderClipList(clips){
      const list = this.elements.clipList;
      const empty = this.elements.empty;
      if(!list){ return; }
      list.innerHTML = '';
      if(!Array.isArray(clips) || !clips.length){
        if(empty){ empty.classList.remove('hide'); }
        return;
      }
      if(empty){ empty.classList.add('hide'); }
      clips.forEach((clip)=>{
        const li = document.createElement('li');
        li.className = 'qa-review-list__item';
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'qa-review-list__button';
        btn.setAttribute('data-clip-id', clip.clipId || '');
        const title = document.createElement('strong');
        title.textContent = clip.title || clip.clipId || 'Clip';
        const metrics = document.createElement('span');
        metrics.className = 'qa-review-metrics';
        const percent = (global.Stage2QADashboard && typeof global.Stage2QADashboard.formatPercent === 'function')
          ? global.Stage2QADashboard.formatPercent
          : (v)=>{
              if(typeof v !== 'number' || !Number.isFinite(v)) return 'N/A';
              return `${(v * 100).toFixed(1)}%`;
            };
        const seconds = (global.Stage2QADashboard && typeof global.Stage2QADashboard.formatSeconds === 'function')
          ? global.Stage2QADashboard.formatSeconds
          : (v)=>{
              if(typeof v !== 'number' || !Number.isFinite(v)) return 'N/A';
              return `${v.toFixed(2)} s`;
            };
        const clipMetrics = clip.metrics || {};
        const statusBits = [];
        statusBits.push(`QA: ${(clip.qaStatus || 'pending').toString().toUpperCase()}`);
        if(Number.isFinite(clipMetrics.codeswitch_f1)){
          statusBits.push(`F1 ${percent(clipMetrics.codeswitch_f1, 1)}`);
        }
        if(Number.isFinite(clipMetrics.diarization_mae)){
          statusBits.push(`MAE ${seconds(clipMetrics.diarization_mae, 2)}`);
        }
        metrics.textContent = statusBits.join(' · ');
        btn.appendChild(title);
        btn.appendChild(metrics);
        if(this.state.selectedClipId && clip.clipId === this.state.selectedClipId){
          btn.classList.add('active');
        }
        btn.addEventListener('click', ()=> this.selectClip(clip));
        li.appendChild(btn);
        list.appendChild(li);
      });
    },

    selectClip(clip){
      if(!clip){ return; }
      this.state.selectedClipId = clip.clipId || null;
      this.state.selectedClip = clip;
      const historyInfo = this.loadEntryFromHistory(clip.clipId);
      if(!historyInfo){
        this.updateMeta('Annotations for this clip are not available locally.');
        this.setStatusButtons(null);
        this.updateStatusLabel(null);
        this.applyReadOnly(true);
        if(this.elements.editToggle){ this.elements.editToggle.checked = false; this.elements.editToggle.disabled = true; }
        this.setDirty(false);
        this.highlightSelected();
        return;
      }
      this.state.history = historyInfo.history;
      this.state.entryIndex = historyInfo.index;
      this.state.entry = historyInfo.entry;
      const originalStatus = this.extractStatus(historyInfo.entry);
      this.state.originalStatus = originalStatus;
      this.state.pendingStatus = originalStatus;
      this.state.originalFiles = this.captureOriginalFiles(historyInfo.entry);
      this.populateFields(this.state.originalFiles);
      this.setStatusButtons(originalStatus);
      this.updateStatusLabel(originalStatus);
      this.updateMeta(this.describeClip(clip, originalStatus));
      this.applyReadOnly(true);
      if(this.elements.editToggle){
        this.elements.editToggle.disabled = false;
        this.elements.editToggle.checked = false;
      }
      this.setDirty(false);
      this.highlightSelected();
    },

    highlightSelected(){
      const list = this.elements.clipList;
      if(!list){ return; }
      Array.from(list.querySelectorAll('.qa-review-list__button')).forEach((btn)=>{
        const clipId = btn.getAttribute('data-clip-id');
        if(clipId && clipId === this.state.selectedClipId){
          btn.classList.add('active');
        } else {
          btn.classList.remove('active');
        }
      });
    },

    captureOriginalFiles(entry){
      const files = (entry && entry.files) || {};
      return {
        transcript: files.transcript_vtt || '',
        translation: files.translation_vtt || '',
        codeSwitch: files.code_switch_vtt || '',
        codeSwitchSpans: normalizeJson(files.code_switch_spans_json || '[]') || '',
        diarization: files.diarization_rttm || '',
      };
    },

    populateFields(files){
      const fields = this.elements.fields || {};
      if(!files){
        Object.values(fields).forEach((field)=>{ if(field) field.value = ''; });
        return;
      }
      if(fields.transcript) fields.transcript.value = files.transcript || '';
      if(fields.translation) fields.translation.value = files.translation || '';
      if(fields.codeSwitch) fields.codeSwitch.value = files.codeSwitch || '';
      if(fields.codeSwitchSpans) fields.codeSwitchSpans.value = files.codeSwitchSpans || '';
      if(fields.diarization) fields.diarization.value = files.diarization || '';
    },

    describeClip(clip, status){
      const percent = (global.Stage2QADashboard && typeof global.Stage2QADashboard.formatPercent === 'function')
        ? global.Stage2QADashboard.formatPercent
        : (v)=>{
            if(typeof v !== 'number' || !Number.isFinite(v)) return 'N/A';
            return `${(v * 100).toFixed(1)}%`;
          };
      const seconds = (global.Stage2QADashboard && typeof global.Stage2QADashboard.formatSeconds === 'function')
        ? global.Stage2QADashboard.formatSeconds
        : (v)=>{
            if(typeof v !== 'number' || !Number.isFinite(v)) return 'N/A';
            return `${v.toFixed(2)} s`;
          };
      const parts = [];
      parts.push(`QA ${ (clip.qaStatus || 'pending').toString().toUpperCase() }`);
      const metrics = clip.metrics || {};
      if(Number.isFinite(metrics.codeswitch_f1)){
        parts.push(`F1 ${percent(metrics.codeswitch_f1, 1)}`);
      }
      if(Number.isFinite(metrics.diarization_mae)){
        parts.push(`MAE ${seconds(metrics.diarization_mae, 2)}`);
      }
      if(status){
        parts.push(`Review ${status.toUpperCase()}`);
      }
      return `${clip.title || clip.clipId || 'Clip'} (${clip.clipId || 'unknown'}) — ${parts.join(' · ')}`;
    },

    extractStatus(entry){
      if(!entry){ return null; }
      const review = entry.review || (entry.qa && entry.qa.review) || null;
      const qaStatus = entry.qa && entry.qa.review_status;
      const status = review && (review.status || review.review_status) ? review.status || review.review_status : qaStatus;
      return status ? status.toString().toLowerCase() : null;
    },

    loadEntryFromHistory(clipId){
      if(!clipId){ return null; }
      if(!global.QAMetrics || !global.QAMetrics._internal || typeof global.QAMetrics._internal.loadHistory !== 'function'){
        return null;
      }
      const history = global.QAMetrics._internal.loadHistory();
      if(!history || !Array.isArray(history.entries)){
        return null;
      }
      for(let i = history.entries.length - 1; i >= 0; i -= 1){
        const entry = history.entries[i];
        if(entry && entry.clipId === clipId){
          return { history, entry, index: i };
        }
      }
      return null;
    },

    setEditing(enabled){
      if(!this.state.entry){
        this.elements.editToggle.checked = false;
        return;
      }
      this.state.editEnabled = !!enabled;
      this.applyReadOnly(!enabled);
      this.setDirty(this.hasChanges());
    },

    applyReadOnly(readonly){
      const fields = this.elements.fields || {};
      Object.values(fields).forEach((field)=>{
        if(field){
          field.readOnly = readonly;
        }
      });
    },

    handleStatusSelection(status){
      if(!this.state.entry){ return; }
      const normalized = this.normalizeStatus(status);
      this.state.pendingStatus = normalized;
      this.setStatusButtons(normalized);
      this.updateStatusLabel(normalized);
      this.updateMeta(this.describeClip(this.state.selectedClip, normalized));
      this.setDirty(this.hasChanges());
    },

    normalizeStatus(status){
      if(!status){ return null; }
      const lower = status.toString().toLowerCase();
      return REVIEW_STATUSES.includes(lower) ? lower : null;
    },

    setStatusButtons(status){
      const normalized = this.normalizeStatus(status);
      if(this.elements.statusButtons){
        this.elements.statusButtons.forEach((btn)=>{
          const value = this.normalizeStatus(btn.getAttribute('data-review-status'));
          if(normalized && value === normalized){
            btn.classList.add('active');
          } else {
            btn.classList.remove('active');
          }
        });
      }
    },

    updateStatusLabel(status){
      if(!this.elements.statusLabel){ return; }
      if(!status){
        this.elements.statusLabel.textContent = 'No review decision selected.';
      } else {
        this.elements.statusLabel.textContent = `Current decision: ${status.toUpperCase()}`;
      }
    },

    updateMeta(message){
      if(this.elements.meta){
        this.elements.meta.textContent = message;
      }
    },

    hasChanges(){
      if(!this.state.entry){ return false; }
      const original = this.state.originalFiles || {};
      const fields = this.elements.fields || {};
      const statusChanged = this.normalizeStatus(this.state.pendingStatus) !== this.normalizeStatus(this.state.originalStatus);
      if(statusChanged){ return true; }
      return ['transcript', 'translation', 'codeSwitch', 'codeSwitchSpans', 'diarization'].some((key)=>{
        const field = fields[key === 'codeSwitch' ? 'codeSwitch' : key];
        if(!field){ return false; }
        const originalValue = original[key] != null ? original[key] : '';
        return field.value !== originalValue;
      });
    },

    setDirty(flag){
      this.state.dirty = !!flag;
      if(this.elements.saveButton){
        this.elements.saveButton.disabled = !flag || !this.state.entry;
      }
      if(this.elements.cancelButton){
        this.elements.cancelButton.disabled = !flag || !this.state.entry;
      }
    },

    cancel(){
      if(!this.state.entry){ return; }
      this.populateFields(this.state.originalFiles);
      this.state.pendingStatus = this.state.originalStatus;
      this.setStatusButtons(this.state.originalStatus);
      this.updateStatusLabel(this.state.originalStatus);
      this.updateMeta(this.describeClip(this.state.selectedClip, this.state.originalStatus));
      if(this.elements.editToggle){
        this.elements.editToggle.checked = false;
      }
      this.setEditing(false);
      this.setDirty(false);
    },

    save(){
      if(!this.state.entry){ return; }
      const status = this.normalizeStatus(this.state.pendingStatus);
      if(!status){
        alert('Select a review outcome before saving.');
        return;
      }
      const fields = this.elements.fields || {};
      const entry = this.state.entry;
      const files = entry.files || (entry.files = {});
      const transcript = fields.transcript ? fields.transcript.value : '';
      const translation = fields.translation ? fields.translation.value : '';
      const codeSwitch = fields.codeSwitch ? fields.codeSwitch.value : '';
      const diarization = fields.diarization ? fields.diarization.value : '';
      let spansRaw = fields.codeSwitchSpans ? fields.codeSwitchSpans.value : '';
      let spansPretty = '';
      if(spansRaw && spansRaw.trim()){
        try{
          const parsed = JSON.parse(spansRaw);
          spansPretty = JSON.stringify(parsed, null, 2);
        }catch(err){
          alert('Code-switch spans JSON is invalid.');
          return;
        }
      } else {
        spansPretty = '[]';
      }

      files.transcript_vtt = transcript;
      files.translation_vtt = translation;
      files.code_switch_vtt = codeSwitch;
      files.diarization_rttm = diarization;
      files.code_switch_spans_json = spansPretty;

      const reviewerId = getReviewerId();
      const timestamp = new Date().toISOString();
      entry.review = Object.assign({}, entry.review, {
        status,
        locked: status === 'accepted' || status === 'corrected',
        reviewer: reviewerId,
        updatedAt: timestamp,
      });
      entry.qa = entry.qa || {};
      entry.qa.review_status = status;
      entry.qa.locked = entry.review.locked;
      entry.qa.reviewer = reviewerId;
      entry.qa.reviewed_at = timestamp;

      // Persist history
      if(this.state.history && Array.isArray(this.state.history.entries) && this.state.entryIndex != null){
        this.state.history.entries[this.state.entryIndex] = entry;
        if(global.QAMetrics && global.QAMetrics._internal && typeof global.QAMetrics._internal.saveHistory === 'function'){
          global.QAMetrics._internal.saveHistory(this.state.history);
        }
      }

      // Regenerate QA report with review data
      if(global.QAMetrics && typeof global.QAMetrics.generateReport === 'function'){
        try{ global.QAMetrics.generateReport(); } catch(err){ console.warn('Stage2Review: unable to regenerate QA report', err); }
      }

      // Update local state copies
      this.state.originalFiles = {
        transcript,
        translation,
        codeSwitch,
        codeSwitchSpans: spansPretty,
        diarization,
      };
      this.state.originalStatus = status;
      this.state.pendingStatus = status;
      this.populateFields(this.state.originalFiles);
      this.setStatusButtons(status);
      this.updateStatusLabel(status);
      this.updateMeta(this.describeClip(this.state.selectedClip, status));
      if(this.elements.editToggle){
        this.elements.editToggle.checked = false;
      }
      this.setEditing(false);
      this.setDirty(false);

      const flagged = this.refreshFlaggedClips();
      const stillFlagged = flagged.some((clip)=> clip.clipId === this.state.selectedClipId);
      if(!stillFlagged){
        this.clearSelection();
      }
    },

    clearSelection(){
      this.state.selectedClipId = null;
      this.state.selectedClip = null;
      this.state.entry = null;
      this.state.entryIndex = null;
      this.state.history = null;
      this.state.originalFiles = null;
      this.state.originalStatus = null;
      this.state.pendingStatus = null;
      this.state.editEnabled = false;
      this.populateFields({});
      this.setStatusButtons(null);
      this.updateStatusLabel(null);
      this.updateMeta('Select a clip to load its annotations.');
      if(this.elements.editToggle){
        this.elements.editToggle.checked = false;
        this.elements.editToggle.disabled = true;
      }
      this.applyReadOnly(true);
      this.setDirty(false);
      this.highlightSelected();
    },
  };

  global.Stage2Review = Stage2Review;
  Stage2Review.init();
})(typeof window !== 'undefined' ? window : globalThis);
