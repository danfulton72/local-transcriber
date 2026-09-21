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
    startedAt: 0,
    timer: null,
    transcript: '',
    currentRecording: null,
    editSnapshot: '',
    currentAudio: null,
    currentAudioUrl: null,
    searchTimer: null,
  };

  const els = {
    healthBadge: $('healthBadge'),
    recordButton: $('recordButton'), recordButtonText: $('recordButtonText'), meter: $('meter'),
    statusText: $('statusText'), statusDetail: $('statusDetail'), timer: $('timer'), pauseButton: $('pauseButton'),
    errorBox: $('errorBox'), transcriptView: $('transcriptView'), wordCount: $('wordCount'),
    editorWrap: $('editorWrap'), transcriptEditor: $('transcriptEditor'), saveEditButton: $('saveEditButton'), cancelEditButton: $('cancelEditButton'),
    hearButton: $('hearButton'), playRecordingButton: $('playRecordingButton'), editButton: $('editButton'), favouriteButton: $('favouriteButton'), copyButton: $('copyButton'), newButton: $('newButton'),
    language: $('language'), chunkSeconds: $('chunkSeconds'), voice: $('voice'), speechSpeed: $('speechSpeed'), prompt: $('prompt'), fileInput: $('fileInput'),
    historyList: $('historyList'), historySearch: $('historySearch'), historyFavourites: $('historyFavourites'), refreshHistoryButton: $('refreshHistoryButton'),
    progressDays: $('progressDays'), parentPin: $('parentPin'), loadProgressButton: $('loadProgressButton'), progressContent: $('progressContent'),
    metricGrid: $('metricGrid'), correctionsList: $('correctionsList'), dailyChart: $('dailyChart'), longestPiece: $('longestPiece'),
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

  function renderTranscript() {
    const text = state.transcript.trim();
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
      for (const sentence of splitSentences(text)) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'sentence';
        button.textContent = sentence + ' ';
        button.title = 'Tap to hear this sentence';
        button.addEventListener('click', () => speakText(sentence));
        els.transcriptView.appendChild(button);
      }
    }
    const hasText = Boolean(text);
    els.hearButton.disabled = !hasText;
    els.editButton.disabled = !hasText || state.recording || !state.currentRecording;
    els.copyButton.disabled = !hasText;
    els.playRecordingButton.disabled = !state.currentRecording?.has_audio;
    els.favouriteButton.disabled = !state.currentRecording;
    els.favouriteButton.textContent = state.currentRecording?.is_favourite ? '★ Favourite' : '☆ Favourite';
  }

  function setTranscript(text) {
    state.transcript = String(text || '').trim();
    renderTranscript();
  }

  function normalizeToken(token) {
    return token.toLocaleLowerCase().replace(/[^\p{L}\p{N}']/gu, '');
  }

  function appendLiveTranscript(newText) {
    const incoming = String(newText || '').trim();
    if (!incoming) return;
    const existing = state.transcript.trim();
    if (!existing) return setTranscript(incoming);
    const a = existing.split(/\s+/);
    const b = incoming.split(/\s+/);
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
    const rest = b.slice(overlap).join(' ').trim();
    if (rest) setTranscript(existing + ' ' + rest);
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

  async function startRecording() {
    setError('');
    stopSpeech();
    if (!window.isSecureContext && !['localhost', '127.0.0.1'].includes(location.hostname)) return setError('The microphone needs HTTPS.');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      const ctx = new AudioContext();
      await ctx.resume();
      const source = ctx.createMediaStreamSource(stream);
      const processor = ctx.createScriptProcessor(4096, 1, 1);
      const mute = ctx.createGain(); mute.gain.value = 0;
      let record;
      try { record = await createRecording(); } catch (error) {
        stream.getTracks().forEach((t) => t.stop());
        await ctx.close();
        throw error;
      }
      state.currentRecording = record;
      state.stream = stream; state.audioContext = ctx; state.source = source; state.processor = processor; state.mute = mute;
      state.sampleRate = ctx.sampleRate; state.fullBuffers = []; resetLive(); state.recording = true; state.paused = false;
      setTranscript('');
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
      startTimer(); syncRecordingUI(); setStatus('I’m listening', 'Your words will appear a few seconds behind you.');
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
        appendLiveTranscript(result.text);
        state.liveCompleted += 1;
        state.liveProcessingSeconds += Number(result.processing_seconds || 0);
        setStatus(state.recording ? 'I’m listening' : 'Nearly done', state.liveQueue.length ? (state.liveQueue.length + ' little bits waiting') : 'Writing your latest words…');
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
    state.transcribing = true; syncRecordingUI(); setStatus('Nearly done', 'Saving your voice and the last few words…');
    await waitForLiveDrain();
    try {
      const wav = encodeWav(mergeBuffers(state.fullBuffers), state.sampleRate);
      const audioForm = new FormData(); audioForm.append('file', wav, 'recording.wav');
      await api('/api/recordings/' + state.currentRecording.id + '/audio', { method: 'POST', body: audioForm });
      const finished = await api('/api/recordings/' + state.currentRecording.id + '/finish', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transcript: state.transcript, duration_seconds: elapsed, processing_seconds: state.liveProcessingSeconds }),
      });
      state.currentRecording = finished; setTranscript(finished.transcript); setStatus('All done!', 'You can hear it, edit it, or find it later in My words.');
    } catch (error) { setError('I wrote the words, but saving the finished recording failed: ' + error.message); }
    finally { state.transcribing = false; state.fullBuffers = []; syncRecordingUI(); }
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
      const form = new FormData(); form.append('file', file, file.name); form.append('task', 'transcriptions');
      if (els.language.value) form.append('language', els.language.value);
      if (els.prompt.value.trim()) form.append('prompt', els.prompt.value.trim());
      const finished = await api('/api/recordings/' + record.id + '/transcribe', { method: 'POST', body: form });
      state.currentRecording = finished; setTranscript(finished.transcript); setStatus('All done!', 'The file is saved in My words.');
    } catch (error) { setError(error.message); setStatus('Something went wrong', 'You can try again.'); }
    finally { state.transcribing = false; els.fileInput.value = ''; syncRecordingUI(); }
  }

  function newRecordingView() {
    if (state.recording) return;
    stopSpeech(); state.currentRecording = null; setTranscript(''); setError(''); setStatus('Ready when you are', 'Press the microphone and talk normally.');
  }

  function openEditor() {
    if (!state.currentRecording || !state.transcript) return;
    state.editSnapshot = state.transcript; els.transcriptEditor.value = state.transcript;
    els.transcriptView.classList.add('hidden'); els.editorWrap.classList.remove('hidden'); els.transcriptEditor.focus();
  }

  function closeEditor() {
    els.editorWrap.classList.add('hidden'); els.transcriptView.classList.remove('hidden');
  }

  async function saveEdit() {
    const edited = els.transcriptEditor.value.trim();
    try {
      const updated = await api('/api/recordings/' + state.currentRecording.id, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ transcript_edited: edited }),
      });
      state.currentRecording = updated; setTranscript(updated.transcript); closeEditor();
    } catch (error) { setError(error.message); }
  }

  function stopSpeech() {
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

  async function playRecording() {
    if (!state.currentRecording?.has_audio) return;
    stopSpeech();
    try {
      const response = await fetch('/api/recordings/' + state.currentRecording.id + '/audio');
      if (!response.ok) throw new Error('Voice recording is not available');
      const blob = await response.blob(); const url = URL.createObjectURL(blob); const audio = new Audio(url);
      state.currentAudio = audio; state.currentAudioUrl = url; audio.addEventListener('ended', stopSpeech, { once: true }); await audio.play();
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

  async function copyTranscript() {
    if (!state.transcript) return;
    await navigator.clipboard.writeText(state.transcript);
    if (state.currentRecording) api('/api/events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event_type: 'copy', recording_id: state.currentRecording.id }) }).catch(() => {});
    els.copyButton.textContent = '✓ Copied'; setTimeout(() => { els.copyButton.textContent = '📋 Copy'; }, 1200);
  }

  function switchPage(name) {
    document.querySelectorAll('.page').forEach((page) => page.classList.toggle('active', page.id === 'page-' + name));
    document.querySelectorAll('.tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.page === name));
    if (name === 'history') loadHistory();
  }

  function friendlyDate(value) {
    const date = new Date(value); const now = new Date();
    const sameDay = date.toDateString() === now.toDateString();
    const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
    const day = sameDay ? 'Today' : (date.toDateString() === yesterday.toDateString() ? 'Yesterday' : date.toLocaleDateString([], { day: 'numeric', month: 'short' }));
    return day + ' at ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  async function loadHistory() {
    els.historyList.innerHTML = '<p class="muted">Loading…</p>';
    const params = new URLSearchParams();
    if (els.historySearch.value.trim()) params.set('q', els.historySearch.value.trim());
    if (els.historyFavourites.checked) params.set('favourite', 'true');
    try {
      const records = await api('/api/recordings?' + params.toString(), { cache: 'no-store' });
      renderHistory(records);
    } catch (error) { els.historyList.innerHTML = '<p class="error">' + escapeHtml(error.message) + '</p>'; }
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  }

  function renderHistory(records) {
    if (!records.length) { els.historyList.innerHTML = '<p class="muted">No saved recordings yet.</p>'; return; }
    els.historyList.replaceChildren();
    for (const record of records) {
      const card = document.createElement('article'); card.className = 'history-card';
      const title = document.createElement('h3'); title.textContent = (record.is_favourite ? '★ ' : '') + (record.title || 'New recording'); card.appendChild(title);
      const meta = document.createElement('div'); meta.className = 'history-meta';
      const dateSpan = document.createElement('span'); dateSpan.textContent = friendlyDate(record.created_at); meta.appendChild(dateSpan);
      const wordSpan = document.createElement('span'); wordSpan.textContent = record.word_count + ' words'; meta.appendChild(wordSpan);
      const timeSpan = document.createElement('span'); timeSpan.textContent = formatTime(record.duration_seconds) + ' talking'; meta.appendChild(timeSpan);
      card.appendChild(meta);
      const snippet = document.createElement('p'); snippet.className = 'snippet'; snippet.textContent = record.transcript.slice(0, 260) + (record.transcript.length > 260 ? '…' : ''); card.appendChild(snippet);
      const actions = document.createElement('div'); actions.className = 'history-actions';
      const open = document.createElement('button'); open.textContent = 'Open'; open.addEventListener('click', () => openHistoryRecording(record)); actions.appendChild(open);
      const star = document.createElement('button'); star.textContent = record.is_favourite ? '★ Unfavourite' : '☆ Favourite'; star.addEventListener('click', async () => { await api('/api/recordings/' + record.id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ is_favourite: !record.is_favourite }) }); loadHistory(); }); actions.appendChild(star);
      const del = document.createElement('button'); del.textContent = 'Move to bin'; del.addEventListener('click', async () => { if (!confirm('Move this recording to the bin?')) return; await api('/api/recordings/' + record.id, { method: 'DELETE' }); loadHistory(); }); actions.appendChild(del);
      card.appendChild(actions); els.historyList.appendChild(card);
    }
  }

  function openHistoryRecording(record) {
    state.currentRecording = record; setTranscript(record.transcript); setStatus('Saved recording', friendlyDate(record.created_at)); switchPage('talk');
  }

  async function loadProgress() {
    const pin = els.parentPin.value.trim(); sessionStorage.setItem('parentPin', pin);
    const headers = pin ? { 'X-Parent-Pin': pin } : {};
    try {
      const data = await api('/api/progress?days=' + els.progressDays.value, { headers, cache: 'no-store' });
      renderProgress(data); els.progressContent.classList.remove('hidden');
    } catch (error) { els.progressContent.classList.add('hidden'); alert(error.message); }
  }

  function renderProgress(data) {
    const metrics = [
      [data.sessions, 'recording sessions'], [data.minutes_spoken, 'minutes spoken'], [data.words_dictated, 'words dictated'],
      [data.average_session_minutes, 'average minutes'], [data.edited_sessions, 'sessions edited'], [data.read_aloud_uses, 'read-aloud uses'],
    ];
    els.metricGrid.replaceChildren();
    for (const [value, label] of metrics) {
      const box = document.createElement('div'); box.className = 'metric';
      const strong = document.createElement('strong'); strong.textContent = value;
      const span = document.createElement('span'); span.textContent = label;
      box.append(strong, span); els.metricGrid.appendChild(box);
    }
    els.correctionsList.replaceChildren();
    if (!data.top_corrections.length) els.correctionsList.innerHTML = '<p class="muted">No repeated corrections yet.</p>';
    for (const item of data.top_corrections) {
      const row = document.createElement('div'); row.className = 'correction-row';
      const from = document.createElement('span'); from.textContent = item.from;
      const arrow = document.createElement('span'); arrow.textContent = '→';
      const to = document.createElement('span'); to.textContent = item.to;
      const count = document.createElement('strong'); count.textContent = item.count + '×';
      row.append(from, arrow, to, count); els.correctionsList.appendChild(row);
    }
    els.dailyChart.replaceChildren();
    const maxWords = Math.max(1, ...data.daily.map((d) => d.words));
    for (const day of data.daily) {
      const row = document.createElement('div'); row.className = 'day-row';
      const label = document.createElement('span'); label.textContent = new Date(day.date + 'T12:00:00').toLocaleDateString([], { day: 'numeric', month: 'short' });
      const track = document.createElement('div'); track.className = 'bar-track';
      const bar = document.createElement('div'); bar.className = 'bar'; bar.style.width = Math.max(3, day.words / maxWords * 100) + '%'; track.appendChild(bar);
      const words = document.createElement('span'); words.textContent = day.words + ' words';
      row.append(label, track, words); els.dailyChart.appendChild(row);
    }
    if (!data.daily.length) els.dailyChart.innerHTML = '<p class="muted">No sessions in this period yet.</p>';
    els.longestPiece.replaceChildren();
    if (data.longest_piece) {
      const title = document.createElement('strong'); title.textContent = data.longest_piece.title || 'Recording';
      const p = document.createElement('p'); p.textContent = data.longest_piece.words + ' words'; els.longestPiece.append(title, p);
    } else els.longestPiece.innerHTML = '<p class="muted">No recordings yet.</p>';
  }

  document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => switchPage(tab.dataset.page)));
  els.recordButton.addEventListener('click', () => state.recording ? stopRecording() : startRecording());
  els.pauseButton.addEventListener('click', togglePause);
  els.hearButton.addEventListener('click', () => speakText(state.transcript));
  els.playRecordingButton.addEventListener('click', playRecording);
  els.editButton.addEventListener('click', openEditor);
  els.saveEditButton.addEventListener('click', saveEdit);
  els.cancelEditButton.addEventListener('click', () => { els.transcriptEditor.value = state.editSnapshot; closeEditor(); });
  els.favouriteButton.addEventListener('click', toggleFavourite);
  els.copyButton.addEventListener('click', copyTranscript);
  els.newButton.addEventListener('click', newRecordingView);
  els.fileInput.addEventListener('change', () => importFile(els.fileInput.files?.[0]));
  els.refreshHistoryButton.addEventListener('click', loadHistory);
  els.historyFavourites.addEventListener('change', loadHistory);
  els.historySearch.addEventListener('input', () => { clearTimeout(state.searchTimer); state.searchTimer = setTimeout(loadHistory, 250); });
  els.loadProgressButton.addEventListener('click', loadProgress);
  els.progressDays.addEventListener('change', () => { if (!els.progressContent.classList.contains('hidden')) loadProgress(); });
  els.voice.addEventListener('change', () => localStorage.setItem('voice', els.voice.value));
  els.parentPin.value = sessionStorage.getItem('parentPin') || '';

  checkHealth(); loadVoices(); renderTranscript(); syncRecordingUI();
})();
