(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const state = {
    recording: false,
    paused: false,
    transcribing: false,
    stream: null,
    audioContext: null,
    source: null,
    processor: null,
    mute: null,
    sampleRate: 48000,
    fullBuffers: [],
    liveBuffers: [],
    liveSampleCount: 0,
    liveFreshSamples: 0,
    liveQueue: [],
    liveProcessing: false,
    liveChunkIndex: 0,
    liveCompleted: 0,
    liveProcessingSeconds: 0,
    liveDrainResolvers: [],
    livePending: '',
    confirmedTranscript: '',
    captureBaseTranscript: '',
    continuation: false,
    startedAt: 0,
    timer: null,
    transcript: '',
    currentRecording: null,
    recoverableRecording: null,
    editSnapshot: '',
    editSaveTimer: null,
    draftSaveTimer: null,
    currentAudio: null,
    currentAudioUrl: null,
    playbackToken: 0,
    searchTimer: null,
    autoFollow: true,
    programmaticScrollAt: 0,
    lastScrollY: window.scrollY,
    installPrompt: null,
  };

  const els = {
    healthBadge: $('healthBadge'),
    recordButton: $('recordButton'), recordButtonText: $('recordButtonText'), meter: $('meter'),
    statusText: $('statusText'), statusDetail: $('statusDetail'), timer: $('timer'), pauseButton: $('pauseButton'),
    errorBox: $('errorBox'), transcriptView: $('transcriptView'), wordCount: $('wordCount'),
    editorWrap: $('editorWrap'), sentenceEditor: $('sentenceEditor'), editSaveStatus: $('editSaveStatus'), saveEditButton: $('saveEditButton'), cancelEditButton: $('cancelEditButton'),
    hearButton: $('hearButton'), focusButton: $('focusButton'), focusExitButton: $('focusExitButton'), useWordsButton: $('useWordsButton'),
    playRecordingButton: $('playRecordingButton'), editButton: $('editButton'), favouriteButton: $('favouriteButton'), newButton: $('newButton'), keepTalkingButton: $('keepTalkingButton'),
    followWordsButton: $('followWordsButton'),
    recoveryBanner: $('recoveryBanner'), recoveryDetail: $('recoveryDetail'), recoverButton: $('recoverButton'), dismissRecoveryButton: $('dismissRecoveryButton'),
    toast: $('toast'),
    language: $('language'), chunkSeconds: $('chunkSeconds'), voice: $('voice'), speechSpeed: $('speechSpeed'), prompt: $('prompt'), fileInput: $('fileInput'),
    installAppButton: $('installAppButton'), installHint: $('installHint'),
    historyList: $('historyList'), historySearch: $('historySearch'), historyFavourites: $('historyFavourites'), refreshHistoryButton: $('refreshHistoryButton'),
    progressDays: $('progressDays'), parentPin: $('parentPin'), loadProgressButton: $('loadProgressButton'), progressContent: $('progressContent'),
    metricGrid: $('metricGrid'), correctionsList: $('correctionsList'), dailyChart: $('dailyChart'), longestPiece: $('longestPiece'),
    retentionDays: $('retentionDays'), deleteAudioImmediately: $('deleteAudioImmediately'),
    saveRetentionButton: $('saveRetentionButton'), applyRetentionButton: $('applyRetentionButton'), retentionMessage: $('retentionMessage'),
    systemStatus: $('systemStatus'), downloadBackupButton: $('downloadBackupButton'), refreshAdminButton: $('refreshAdminButton'),
    recycleList: $('recycleList'), refreshRecycleButton: $('refreshRecycleButton'),
  };

  function setError(message = '') {
    els.errorBox.textContent = message;
    els.errorBox.classList.toggle('hidden', !message);
  }

  function setStatus(title, detail = '') {
    els.statusText.textContent = title;
    els.statusDetail.textContent = detail;
  }

  function formatTime(seconds) {
    const total = Math.max(0, Math.floor(seconds || 0));
    return String(Math.floor(total / 60)).padStart(2, '0') + ':' + String(total % 60).padStart(2, '0');
  }

  function splitSentences(text) {
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    if (!clean) return [];
    return (clean.match(/[^.!?]+(?:[.!?]+["”’']*|$)/g) || [clean]).map((s) => s.trim()).filter(Boolean);
  }

  function wordCount(text) {
    return (String(text || '').trim().match(/[\p{L}\p{N}'’-]+/gu) || []).length;
  }

  function joinText(left, right) {
    return [String(left || '').trim(), String(right || '').trim()].filter(Boolean).join(' ').trim();
  }

  function dedupeIncoming(existing, incoming) {
    const current = String(existing || '').trim();
    const next = String(incoming || '').trim();
    if (!next) return '';
    if (!current) return next;
    const a = current.split(/\s+/);
    const b = next.split(/\s+/);
    let overlap = 0;
    for (let size = Math.min(28, a.length, b.length); size >= 1; size -= 1) {
      let matches = true;
      for (let i = 0; i < size; i += 1) {
        const left = normalizeToken(a[a.length - size + i]);
        const right = normalizeToken(b[i]);
        if (!left || !right || left !== right) { matches = false; break; }
      }
      if (matches) { overlap = size; break; }
    }
    return b.slice(overlap).join(' ').trim();
  }

  function showToast(message) {
    els.toast.textContent = message;
    els.toast.classList.remove('hidden');
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => els.toast.classList.add('hidden'), 2200);
  }

  function updateFollowButton() {
    els.followWordsButton.classList.toggle('hidden', !state.recording || state.autoFollow);
  }

  function maybeAutoFollow() {
    if (!state.recording || !state.autoFollow) return;
    const target = els.transcriptView.lastElementChild || els.transcriptView;
    if (!target) return;
    state.programmaticScrollAt = Date.now();
    requestAnimationFrame(() => target.scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
  }

  function renderTranscript() {
    const text = state.transcript.trim();
    const liveMode = state.recording || state.transcribing;
    const confirmed = liveMode ? state.confirmedTranscript.trim() : text;
    const pending = liveMode ? state.livePending.trim() : '';
    els.transcriptView.replaceChildren();
    const count = wordCount(text);
    els.wordCount.textContent = count + ' word' + (count === 1 ? '' : 's');

    if (!text) {
      els.transcriptView.classList.add('empty');
      const p = document.createElement('p');
      p.textContent = 'Your words will appear here.';
      els.transcriptView.appendChild(p);
    } else {
      els.transcriptView.classList.remove('empty');
      if (confirmed) {
        for (const sentence of splitSentences(confirmed)) {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'sentence';
          button.textContent = sentence + ' ';
          button.title = 'Tap to hear this sentence';
          button.addEventListener('click', () => speakText(sentence));
          els.transcriptView.appendChild(button);
        }
      }
      if (pending) {
        const preview = document.createElement('span');
        preview.className = 'live-preview';
        preview.textContent = pending;
        preview.setAttribute('aria-label', 'Latest words still being checked');
        els.transcriptView.appendChild(preview);
      }
    }

    const hasText = Boolean(text);
    const canContinue = Boolean(state.currentRecording && hasText && !state.recording && !state.transcribing);
    els.hearButton.disabled = !hasText;
    els.focusButton.disabled = !hasText;
    els.editButton.disabled = !hasText || state.recording || !state.currentRecording;
    els.useWordsButton.disabled = !hasText;
    els.playRecordingButton.disabled = !state.currentRecording?.has_audio;
    els.favouriteButton.disabled = !state.currentRecording;
    els.keepTalkingButton.classList.toggle('hidden', !canContinue);
    els.favouriteButton.textContent = state.currentRecording?.is_favourite ? '★ Favourite' : '☆ Favourite';
    updateFollowButton();
    maybeAutoFollow();
  }

  function setTranscript(text) {
    state.transcript = String(text || '').trim();
    if (!state.recording) {
      state.confirmedTranscript = state.transcript;
      state.livePending = '';
    }
    renderTranscript();
  }

  function normalizeToken(token) {
    return token.toLocaleLowerCase().replace(/[^\p{L}\p{N}']/gu, '');
  }

  function acceptLiveTranscript(newText) {
    const incoming = String(newText || '').trim();
    if (!incoming) return;
    if (state.livePending) state.confirmedTranscript = joinText(state.confirmedTranscript, state.livePending);
    state.livePending = dedupeIncoming(state.confirmedTranscript, incoming);
    state.transcript = joinText(state.confirmedTranscript, state.livePending);
    renderTranscript();
    scheduleDraftSave();
  }

  function commitLivePending() {
    if (state.livePending) state.confirmedTranscript = joinText(state.confirmedTranscript, state.livePending);
    state.livePending = '';
    state.transcript = state.confirmedTranscript.trim();
    renderTranscript();
    scheduleDraftSave(true);
  }

  async function api(url, options = {}) {
    const response = await fetch(url, options);
    const type = response.headers.get('content-type') || '';
    const payload = response.status === 204 ? null : (type.includes('application/json') ? await response.json() : await response.text());
    if (!response.ok) {
      const detail = typeof payload === 'string' ? payload : payload?.detail || JSON.stringify(payload);
      throw new Error(detail || ('HTTP ' + response.status));
    }
    return payload;
  }

  async function checkHealth() {
    try {
      const data = await api('/healthz', { cache: 'no-store' });
      const good = data.database && data.speech_gateway;
      els.healthBadge.className = 'health ' + (good ? 'online' : 'degraded');
      els.healthBadge.textContent = good ? 'Local speech ready' : 'Needs attention';
    } catch {
      els.healthBadge.className = 'health degraded';
      els.healthBadge.textContent = 'Offline';
    }
  }

  async function loadVoices() {
    try {
      const data = await api('/api/voices', { cache: 'no-store' });
      const voices = Array.isArray(data) ? data : data.voices || [];
      if (!voices.length) return;
      const selected = localStorage.getItem('voice') || els.voice.value;
      els.voice.replaceChildren();
      for (const voice of voices) {
        const option = document.createElement('option');
        option.value = voice.id;
        option.textContent = voice.name || voice.id;
        els.voice.appendChild(option);
      }
      if ([...els.voice.options].some((o) => o.value === selected)) els.voice.value = selected;
    } catch {}
  }

  function startTimer() {
    state.startedAt = Date.now();
    els.timer.textContent = '00:00';
    state.timer = setInterval(() => { els.timer.textContent = formatTime((Date.now() - state.startedAt) / 1000); }, 250);
  }

  function stopTimer() {
    if (state.timer) clearInterval(state.timer);
    state.timer = null;
  }

  function setMeter(level) {
    const bars = [...els.meter.children];
    const normalized = Math.min(1, Math.max(0, level * 4.8));
    bars.forEach((bar, i) => {
      const distance = Math.abs(i - (bars.length - 1) / 2) / (bars.length / 2);
      const shaped = Math.max(.05, normalized * (1 - distance * .5));
      bar.style.height = (8 + shaped * 36) + 'px';
      bar.style.opacity = String(.2 + shaped * .8);
    });
  }

  function mergeBuffers(buffers) {
    const length = buffers.reduce((sum, item) => sum + item.length, 0);
    const out = new Float32Array(length);
    let offset = 0;
    for (const item of buffers) { out.set(item, offset); offset += item.length; }
    return out;
  }

  function writeAscii(view, offset, text) {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  }

  function encodeWav(samples, sampleRate) {
    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buffer);
    writeAscii(view, 0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true); writeAscii(view, 8, 'WAVE');
    writeAscii(view, 12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    writeAscii(view, 36, 'data'); view.setUint32(40, samples.length * 2, true);
    let offset = 44;
    for (let i = 0; i < samples.length; i += 1, offset += 2) {
      const sample = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    }
    return new Blob([view], { type: 'audio/wav' });
  }

  function resetLive() {
    state.liveBuffers = []; state.liveSampleCount = 0; state.liveFreshSamples = 0; state.liveQueue = [];
    state.liveProcessing = false; state.liveChunkIndex = 0; state.liveCompleted = 0; state.liveProcessingSeconds = 0; state.liveDrainResolvers = [];
    state.livePending = '';
  }

  function syncRecordingUI() {
    els.recordButton.classList.toggle('recording', state.recording);
    els.recordButtonText.textContent = state.recording ? 'Stop & finish' : 'Start talking';
    els.recordButton.disabled = state.transcribing;
    els.pauseButton.classList.toggle('hidden', !state.recording);
    els.pauseButton.textContent = state.paused ? 'Carry on' : 'Pause';
    els.language.disabled = state.recording || state.transcribing;
    els.chunkSeconds.disabled = state.recording || state.transcribing;
    els.fileInput.disabled = state.recording || state.transcribing;
    renderTranscript();
  }

  async function createRecording() {
    return api('/api/recordings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ language: els.language.value || null }),
    });
  }

  async function persistDraftNow(text = state.transcript) {
    if (!state.currentRecording) return;
    const draft = String(text || '').trim();
    localStorage.setItem('activeRecordingId', state.currentRecording.id);
    localStorage.setItem('activeRecordingDraft', draft);
    const updated = await api('/api/recordings/' + state.currentRecording.id + '/draft', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: draft }),
    });
    state.currentRecording = { ...state.currentRecording, draft_text: updated.draft_text };
  }

  function scheduleDraftSave(immediate = false) {
    if (!state.currentRecording) return;
    clearTimeout(state.draftSaveTimer);
    if (immediate) {
      persistDraftNow().catch(() => {});
      return;
    }
    state.draftSaveTimer = setTimeout(() => persistDraftNow().catch(() => {}), 650);
  }

  async function startRecording(reuseExisting = false) {
    setError('');
    stopSpeech();
    exitReadingFocus();
    if (!window.isSecureContext && !['localhost', '127.0.0.1'].includes(location.hostname)) return setError('The microphone needs HTTPS.');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      const ctx = new AudioContext();
      await ctx.resume();
      const source = ctx.createMediaStreamSource(stream);
      const processor = ctx.createScriptProcessor(4096, 1, 1);
      const mute = ctx.createGain(); mute.gain.value = 0;

      let record = reuseExisting ? state.currentRecording : null;
      try {
        if (!record) record = await createRecording();
      } catch (error) {
        stream.getTracks().forEach((t) => t.stop());
        await ctx.close();
        throw error;
      }

      const baseText = reuseExisting ? state.transcript.trim() : '';
      state.currentRecording = record;
      state.captureBaseTranscript = baseText;
      state.continuation = Boolean(reuseExisting && record.status === 'ready');
      state.stream = stream; state.audioContext = ctx; state.source = source; state.processor = processor; state.mute = mute;
      state.sampleRate = ctx.sampleRate; state.fullBuffers = []; resetLive(); state.recording = true; state.paused = false;
      state.autoFollow = true;
      state.confirmedTranscript = baseText;
      state.transcript = baseText;
      localStorage.setItem('activeRecordingId', record.id);
      localStorage.setItem('activeRecordingDraft', baseText);
      renderTranscript();

      processor.onaudioprocess = (event) => {
        if (!state.recording || state.paused) return setMeter(0);
        const input = event.inputBuffer.getChannelData(0);
        const chunk = new Float32Array(input);
        state.fullBuffers.push(chunk);
        state.liveBuffers.push(chunk); state.liveSampleCount += chunk.length; state.liveFreshSamples += chunk.length;
        maybeFlushLiveChunk();
        let sum = 0; for (let i = 0; i < input.length; i += 1) sum += input[i] * input[i];
        setMeter(Math.sqrt(sum / input.length));
      };
      source.connect(processor); processor.connect(mute); mute.connect(ctx.destination);
      startTimer(); syncRecordingUI();
      setStatus(reuseExisting ? 'Keep going' : 'I’m listening', reuseExisting ? 'Your new words will be added to this piece.' : 'Your words will appear a few seconds behind you.');
      scheduleDraftSave(true);
    } catch (error) { cleanupRecording(); setError(error?.message || 'I could not open the microphone.'); }
  }

  function maybeFlushLiveChunk() {
    const target = Math.round(Number(els.chunkSeconds.value) * state.sampleRate);
    if (state.liveSampleCount >= target) flushLiveChunk(false);
  }

  function flushLiveChunk(finalChunk) {
    if (!state.liveBuffers.length || !state.currentRecording) return false;
    const merged = mergeBuffers(state.liveBuffers);
    const target = Math.round(Number(els.chunkSeconds.value) * state.sampleRate);
    const overlap = Math.min(Math.round(.9 * state.sampleRate), Math.round(target * .22));
    if (!finalChunk && merged.length < target) return false;
    if (finalChunk && state.liveFreshSamples < Math.round(.18 * state.sampleRate)) return false;
    const sendLength = finalChunk ? merged.length : target;
    if (sendLength < Math.round(.25 * state.sampleRate)) return false;
    const audio = merged.slice(0, sendLength);
    const nextStart = finalChunk ? merged.length : Math.max(0, sendLength - overlap);
    const remainder = finalChunk ? new Float32Array(0) : merged.slice(nextStart);
    state.liveBuffers = remainder.length ? [remainder] : [];
    state.liveSampleCount = remainder.length;
    state.liveFreshSamples = finalChunk ? 0 : Math.max(0, remainder.length - overlap);
    state.liveQueue.push({ index: ++state.liveChunkIndex, blob: encodeWav(audio, state.sampleRate) });
    processLiveQueue();
    return true;
  }

  async function processLiveQueue() {
    if (state.liveProcessing) return;
    state.liveProcessing = true;
    while (state.liveQueue.length) {
      const item = state.liveQueue.shift();
      const form = new FormData();
      form.append('file', item.blob, 'chunk-' + String(item.index).padStart(5, '0') + '.wav');
      form.append('chunk_number', String(item.index));
      form.append('task', 'transcriptions');
      if (els.language.value) form.append('language', els.language.value);
      if (els.prompt.value.trim()) form.append('prompt', els.prompt.value.trim());
      try {
        const result = await api('/api/recordings/' + state.currentRecording.id + '/chunks', { method: 'POST', body: form });
        acceptLiveTranscript(result.text);
        state.liveCompleted += 1;
        state.liveProcessingSeconds += Number(result.processing_seconds || 0);
        setStatus(state.recording ? 'I’m listening' : 'Nearly done', state.liveQueue.length ? (state.liveQueue.length + ' little bits waiting') : 'Checking your latest words…');
      } catch (error) { setError('One short part could not be written down: ' + error.message); }
    }
    state.liveProcessing = false;
    const resolvers = state.liveDrainResolvers.splice(0); resolvers.forEach((resolve) => resolve());
  }

  function waitForLiveDrain() {
    if (!state.liveProcessing && state.liveQueue.length === 0) return Promise.resolve();
    return new Promise((resolve) => state.liveDrainResolvers.push(resolve));
  }

  function cleanupRecording() {
    stopTimer(); setMeter(0);
    if (state.processor) { state.processor.onaudioprocess = null; try { state.processor.disconnect(); } catch {} }
    try { state.source?.disconnect(); } catch {} try { state.mute?.disconnect(); } catch {}
    state.stream?.getTracks().forEach((track) => track.stop());
    if (state.audioContext && state.audioContext.state !== 'closed') state.audioContext.close().catch(() => {});
    state.stream = null; state.audioContext = null; state.source = null; state.processor = null; state.mute = null;
    state.recording = false; state.paused = false; syncRecordingUI();
  }

  async function stopRecording() {
    if (!state.recording) return;
    const elapsed = Math.max(0, (Date.now() - state.startedAt) / 1000);
    state.recording = false;
    flushLiveChunk(true);
    cleanupRecording();
    state.transcribing = true; syncRecordingUI(); setStatus('Nearly done', 'Saving your voice and checking the last few words…');
    await waitForLiveDrain();
    commitLivePending();
    clearTimeout(state.draftSaveTimer);
    try {
      await persistDraftNow();
      const wav = encodeWav(mergeBuffers(state.fullBuffers), state.sampleRate);
      const audioForm = new FormData();
      audioForm.append('file', wav, 'recording-' + Date.now() + '.wav');
      await api('/api/recordings/' + state.currentRecording.id + '/audio', { method: 'POST', body: audioForm });

      let finalText = state.transcript.trim();
      if (state.continuation && state.captureBaseTranscript && finalText.startsWith(state.captureBaseTranscript)) {
        finalText = finalText.slice(state.captureBaseTranscript.length).trim();
      }

      const finished = await api('/api/recordings/' + state.currentRecording.id + '/finish', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          transcript: finalText,
          duration_seconds: elapsed,
          processing_seconds: state.liveProcessingSeconds,
          append: state.continuation,
        }),
      });
      state.currentRecording = finished;
      localStorage.removeItem('activeRecordingId');
      localStorage.removeItem('activeRecordingDraft');
      state.captureBaseTranscript = ''; state.continuation = false;
      setTranscript(finished.transcript);
      setStatus('All done!', 'Your piece is saved. You can keep talking, read it, edit it, or use your words.');
    } catch (error) {
      setError('Your words are safe as a draft, but finishing the recording failed: ' + error.message);
      setStatus('Your draft is safe', 'You can recover it when this page opens again.');
    } finally {
      state.transcribing = false; state.fullBuffers = []; syncRecordingUI();
    }
  }

  function togglePause() {
    if (!state.recording) return;
    state.paused = !state.paused; if (state.paused) setMeter(0);
    els.pauseButton.textContent = state.paused ? 'Carry on' : 'Pause';
    setStatus(state.paused ? 'Paused' : 'I’m listening', state.paused ? 'Press Carry on when you are ready.' : 'Keep talking.');
  }

  async function importFile(file) {
    if (!file) return;
    setError(''); state.transcribing = true; syncRecordingUI(); setStatus('Writing it down', 'Listening to ' + file.name + '…');
    try {
      const record = await createRecording(); state.currentRecording = record;
      localStorage.setItem('activeRecordingId', record.id);
      const form = new FormData(); form.append('file', file, file.name); form.append('task', 'transcriptions');
      if (els.language.value) form.append('language', els.language.value);
      if (els.prompt.value.trim()) form.append('prompt', els.prompt.value.trim());
      const finished = await api('/api/recordings/' + record.id + '/transcribe', { method: 'POST', body: form });
      state.currentRecording = finished;
      localStorage.removeItem('activeRecordingId'); localStorage.removeItem('activeRecordingDraft');
      setTranscript(finished.transcript); setStatus('All done!', 'The file is saved in My words.');
    } catch (error) { setError(error.message); setStatus('Something went wrong', 'You can try again.'); }
    finally { state.transcribing = false; els.fileInput.value = ''; syncRecordingUI(); }
  }

  function newRecordingView() {
    if (state.recording) return;
    stopSpeech(); exitReadingFocus();
    state.currentRecording = null; state.captureBaseTranscript = ''; state.continuation = false;
    setTranscript(''); setError(''); setStatus('Ready when you are', 'Press the microphone and talk normally.');
  }

  function editorText() {
    return [...els.sentenceEditor.querySelectorAll('textarea')].map((item) => item.value.trim()).filter(Boolean).join(' ').trim();
  }

  function autoGrowEditor(textarea) {
    textarea.style.height = 'auto';
    textarea.style.height = Math.max(64, textarea.scrollHeight) + 'px';
  }

  function renderSentenceEditor(text) {
    els.sentenceEditor.replaceChildren();
    const sentences = splitSentences(text);
    for (const [index, sentence] of (sentences.length ? sentences : [text]).entries()) {
      const row = document.createElement('label'); row.className = 'sentence-edit-row';
      const number = document.createElement('span'); number.className = 'sentence-number'; number.textContent = String(index + 1);
      const textarea = document.createElement('textarea');
      textarea.value = sentence; textarea.rows = 2; textarea.spellcheck = true; textarea.setAttribute('aria-label', 'Sentence ' + (index + 1));
      textarea.addEventListener('input', () => {
        autoGrowEditor(textarea);
        state.transcript = editorText();
        els.wordCount.textContent = wordCount(state.transcript) + ' words';
        scheduleEditAutosave();
      });
      row.append(number, textarea); els.sentenceEditor.appendChild(row); autoGrowEditor(textarea);
    }
  }

  function openEditor() {
    if (!state.currentRecording || !state.transcript || state.recording) return;
    state.editSnapshot = state.transcript;
    const localDraft = localStorage.getItem('editDraft:' + state.currentRecording.id);
    const draft = state.currentRecording.draft_text || localDraft || state.transcript;
    state.transcript = draft;
    renderSentenceEditor(draft);
    els.transcriptView.classList.add('hidden'); els.editorWrap.classList.remove('hidden');
    els.editSaveStatus.textContent = draft !== state.editSnapshot ? 'Recovered unsaved edits' : 'Changes save automatically';
    els.sentenceEditor.querySelector('textarea')?.focus();
  }

  function closeEditor() {
    els.editorWrap.classList.add('hidden'); els.transcriptView.classList.remove('hidden');
    renderTranscript();
  }

  async function saveEditDraft() {
    if (!state.currentRecording) return;
    const edited = editorText();
    state.transcript = edited;
    localStorage.setItem('editDraft:' + state.currentRecording.id, edited);
    els.editSaveStatus.textContent = 'Saving…';
    try {
      const updated = await api('/api/recordings/' + state.currentRecording.id + '/draft', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: edited }),
      });
      state.currentRecording = { ...state.currentRecording, draft_text: updated.draft_text };
      els.editSaveStatus.textContent = 'Saved';
    } catch {
      els.editSaveStatus.textContent = 'Saved on this device';
    }
  }

  function scheduleEditAutosave() {
    clearTimeout(state.editSaveTimer);
    els.editSaveStatus.textContent = 'Saving soon…';
    state.editSaveTimer = setTimeout(saveEditDraft, 700);
  }

  async function saveEdit() {
    clearTimeout(state.editSaveTimer);
    const edited = editorText();
    try {
      const updated = await api('/api/recordings/' + state.currentRecording.id, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ transcript_edited: edited }),
      });
      localStorage.removeItem('editDraft:' + state.currentRecording.id);
      state.currentRecording = updated; setTranscript(updated.transcript); closeEditor();
      showToast('Words saved');
    } catch (error) { setError(error.message); }
  }

  async function undoEdit() {
    clearTimeout(state.editSaveTimer);
    const original = state.editSnapshot;
    localStorage.removeItem('editDraft:' + state.currentRecording.id);
    try {
      await api('/api/recordings/' + state.currentRecording.id + '/draft', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '' }),
      });
    } catch {}
    state.transcript = original;
    closeEditor();
    setTranscript(original);
  }

  function stopSpeech() {
    state.playbackToken += 1;
    if (state.currentAudio) { try { state.currentAudio.pause(); } catch {} }
    if (state.currentAudioUrl) URL.revokeObjectURL(state.currentAudioUrl);
    state.currentAudio = null; state.currentAudioUrl = null;
  }

  async function speakText(text) {
    if (!text.trim()) return;
    stopSpeech();
    try {
      const response = await fetch('/api/speech', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: text, recording_id: state.currentRecording?.id || null, voice: els.voice.value, speed: Number(els.speechSpeed.value) }),
      });
      if (!response.ok) throw new Error((await response.json()).detail || ('HTTP ' + response.status));
      const blob = await response.blob(); const url = URL.createObjectURL(blob); const audio = new Audio(url);
      state.currentAudio = audio; state.currentAudioUrl = url;
      audio.addEventListener('ended', stopSpeech, { once: true }); await audio.play();
    } catch (error) { setError('Read-aloud failed: ' + error.message); }
  }

  async function playAudioUrl(url, token) {
    const response = await fetch(url);
    if (!response.ok) throw new Error('Voice recording is not available');
    const blob = await response.blob(); const objectUrl = URL.createObjectURL(blob);
    const audio = new Audio(objectUrl);
    state.currentAudio = audio; state.currentAudioUrl = objectUrl;
    await new Promise((resolve, reject) => {
      audio.addEventListener('ended', resolve, { once: true });
      audio.addEventListener('error', reject, { once: true });
      audio.play().catch(reject);
    });
    if (state.playbackToken !== token) return false;
    URL.revokeObjectURL(objectUrl); state.currentAudioUrl = null; state.currentAudio = null;
    return true;
  }

  async function playRecording() {
    if (!state.currentRecording?.has_audio) return;
    stopSpeech();
    const token = ++state.playbackToken;
    try {
      const data = await api('/api/recordings/' + state.currentRecording.id + '/audio-segments', { cache: 'no-store' });
      for (const segment of data.segments || []) {
        if (state.playbackToken !== token) break;
        const keepGoing = await playAudioUrl(segment.url, token);
        if (!keepGoing) break;
      }
    } catch (error) { setError(error.message); }
  }

  async function toggleFavourite() {
    if (!state.currentRecording) return;
    try {
      const updated = await api('/api/recordings/' + state.currentRecording.id, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ is_favourite: !state.currentRecording.is_favourite }),
      });
      state.currentRecording = updated; renderTranscript();
    } catch (error) { setError(error.message); }
  }

  async function useMyWords() {
    if (!state.transcript) return;
    const title = state.currentRecording?.title || 'My words';
    if (navigator.share) {
      try {
        await navigator.share({ title, text: state.transcript });
        if (state.currentRecording) api('/api/events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event_type: 'share', recording_id: state.currentRecording.id }) }).catch(() => {});
        showToast('Shared');
        return;
      } catch (error) {
        if (error?.name === 'AbortError') return;
      }
    }
    try {
      await navigator.clipboard.writeText(state.transcript);
      if (state.currentRecording) api('/api/events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event_type: 'copy', recording_id: state.currentRecording.id }) }).catch(() => {});
      showToast('Copied — paste your words anywhere');
    } catch (error) {
      setError('I could not copy your words: ' + error.message);
    }
  }

  function enterReadingFocus() {
    if (!state.transcript) return;
    closeEditor();
    document.body.classList.add('reading-focus');
    els.focusExitButton.classList.remove('hidden');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function exitReadingFocus() {
    document.body.classList.remove('reading-focus');
    els.focusExitButton.classList.add('hidden');
  }

  async function checkRecoverable() {
    try {
      const record = await api('/api/recoverable', { cache: 'no-store' });
      if (!record || !record.transcript) return;
      state.recoverableRecording = record;
      els.recoveryDetail.textContent = record.word_count + ' words were saved as a draft.';
      els.recoveryBanner.classList.remove('hidden');
    } catch {}
  }

  function recoverWords() {
    const record = state.recoverableRecording;
    if (!record) return;
    state.currentRecording = record;
    setTranscript(record.draft_text || record.transcript);
    els.recoveryBanner.classList.add('hidden');
    setStatus('Your words are back', 'Press Keep talking to carry on, or edit what you already have.');
    switchPage('talk');
    showToast('Draft recovered');
  }

  function dismissRecovery() {
    els.recoveryBanner.classList.add('hidden');
  }

  async function installApp() {
    if (state.installPrompt) {
      state.installPrompt.prompt();
      await state.installPrompt.userChoice;
      state.installPrompt = null;
      els.installHint.textContent = 'Talk to Type is ready from your home screen.';
      return;
    }
    const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
    els.installHint.textContent = ios
      ? 'On iPhone/iPad: Share → Add to Home Screen.'
      : 'Use your browser menu and choose Install app or Add to Home screen.';
  }

  function switchPage(name) {
    document.querySelectorAll('.page').forEach((page) => page.classList.toggle('active', page.id === 'page-' + name));
    document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => {
    if (state.recording || state.transcribing) {
      showToast('Finish this recording before changing page');
      return;
    }
    exitReadingFocus();
    switchPage(tab.dataset.page);
  }));

  els.recordButton.addEventListener('click', () => state.recording ? stopRecording() : startRecording(false));
  els.keepTalkingButton.addEventListener('click', () => startRecording(true));
  els.pauseButton.addEventListener('click', togglePause);
  els.hearButton.addEventListener('click', () => speakText(state.transcript));
  els.playRecordingButton.addEventListener('click', playRecording);
  els.editButton.addEventListener('click', openEditor);
  els.saveEditButton.addEventListener('click', saveEdit);
  els.cancelEditButton.addEventListener('click', undoEdit);
  els.favouriteButton.addEventListener('click', toggleFavourite);
  els.useWordsButton.addEventListener('click', useMyWords);
  els.focusButton.addEventListener('click', enterReadingFocus);
  els.focusExitButton.addEventListener('click', exitReadingFocus);
  els.followWordsButton.addEventListener('click', () => {
    state.autoFollow = true;
    updateFollowButton();
    maybeAutoFollow();
  });
  els.recoverButton.addEventListener('click', recoverWords);
  els.dismissRecoveryButton.addEventListener('click', dismissRecovery);
  els.newButton.addEventListener('click', newRecordingView);
  els.installAppButton.addEventListener('click', installApp);
  els.fileInput.addEventListener('change', () => importFile(els.fileInput.files?.[0]));
  els.refreshHistoryButton.addEventListener('click', loadHistory);
  els.historyFavourites.addEventListener('change', loadHistory);
  els.historySearch.addEventListener('input', () => { clearTimeout(state.searchTimer); state.searchTimer = setTimeout(loadHistory, 250); });
  els.loadProgressButton.addEventListener('click', loadProgress);
  els.progressDays.addEventListener('change', () => { if (!els.progressContent.classList.contains('hidden')) loadProgress(); });
  els.saveRetentionButton.addEventListener('click', saveRetention);
  els.applyRetentionButton.addEventListener('click', applyRetentionNow);
  els.refreshAdminButton.addEventListener('click', loadAdminStatus);
  els.refreshRecycleButton.addEventListener('click', loadRecycleBin);
  els.downloadBackupButton.addEventListener('click', downloadBackup);
  els.deleteAudioImmediately.addEventListener('change', () => {
    els.retentionDays.disabled = els.deleteAudioImmediately.checked;
    if (els.deleteAudioImmediately.checked) els.retentionDays.value = '0';
  });
  els.voice.addEventListener('change', () => localStorage.setItem('voice', els.voice.value));
  els.parentPin.value = sessionStorage.getItem('parentPin') || '';

  window.addEventListener('scroll', () => {
    const current = window.scrollY;
    if (state.recording && Date.now() - state.programmaticScrollAt > 700 && current < state.lastScrollY - 10) {
      state.autoFollow = false;
      updateFollowButton();
    }
    state.lastScrollY = current;
  }, { passive: true });

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    state.installPrompt = event;
    els.installHint.textContent = 'Ready to install on this device.';
  });

  window.addEventListener('appinstalled', () => {
    state.installPrompt = null;
    els.installHint.textContent = 'Installed on this device.';
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && document.body.classList.contains('reading-focus')) exitReadingFocus();
  });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }

  checkHealth();
  loadVoices();
  renderTranscript();
  syncRecordingUI();
  checkRecoverable();

})();
