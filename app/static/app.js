(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const state = {
    recording: false,
    paused: false,
    transcribing: false,
    stream: null,
    captureStreams: [],
    audioContext: null,
    source: null,
    inputSources: [],
    mixDestination: null,
    processor: null,
    mute: null,
    captureMode: 'microphone',
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
    currentSpeakerAnalysisId: null,
    speakerPolling: false,
    authUser: null,
  };

  const els = {
    loginScreen: $('loginScreen'), loginForm: $('loginForm'), loginUsername: $('loginUsername'), loginPassword: $('loginPassword'),
    loginButton: $('loginButton'), loginMessage: $('loginMessage'), currentUserLabel: $('currentUserLabel'), logoutButton: $('logoutButton'),
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
    language: $('language'), chunkSeconds: $('chunkSeconds'), captureSource: $('captureSource'), captureSourceHint: $('captureSourceHint'),
    voice: $('voice'), speechSpeed: $('speechSpeed'), prompt: $('prompt'), fileInput: $('fileInput'),
    installAppButton: $('installAppButton'), installHint: $('installHint'),
    historyList: $('historyList'), historySearch: $('historySearch'), historyFavourites: $('historyFavourites'), refreshHistoryButton: $('refreshHistoryButton'),
    progressDays: $('progressDays'), parentPin: $('parentPin'), loadProgressButton: $('loadProgressButton'), progressContent: $('progressContent'),
    metricGrid: $('metricGrid'), correctionsList: $('correctionsList'), dailyChart: $('dailyChart'), longestPiece: $('longestPiece'),
    retentionDays: $('retentionDays'), deleteAudioImmediately: $('deleteAudioImmediately'),
    saveRetentionButton: $('saveRetentionButton'), applyRetentionButton: $('applyRetentionButton'), retentionMessage: $('retentionMessage'),
    systemStatus: $('systemStatus'), downloadBackupButton: $('downloadBackupButton'), refreshAdminButton: $('refreshAdminButton'),
    recycleList: $('recycleList'), refreshRecycleButton: $('refreshRecycleButton'),
    speakerServiceStatus: $('speakerServiceStatus'), speakerRecordingSelect: $('speakerRecordingSelect'),
    speakerCountSelect: $('speakerCountSelect'), runSpeakerAnalysisButton: $('runSpeakerAnalysisButton'),
    speakerAnalysisMessage: $('speakerAnalysisMessage'), speakerAnalysisResult: $('speakerAnalysisResult'),
    speakerProfilesList: $('speakerProfilesList'), refreshSpeakerProfilesButton: $('refreshSpeakerProfilesButton'),
    userList: $('userList'), refreshUsersButton: $('refreshUsersButton'), createUserForm: $('createUserForm'),
    newUsername: $('newUsername'), newUserDisplayName: $('newUserDisplayName'), newUserPassword: $('newUserPassword'),
    createUserButton: $('createUserButton'), userAdminMessage: $('userAdminMessage'),
  };

  function userStorageKey(name) {
    return 'user:' + (state.authUser?.id || 'anonymous') + ':' + name;
  }

  function userLocalGet(name) {
    return localStorage.getItem(userStorageKey(name));
  }

  function userLocalSet(name, value) {
    localStorage.setItem(userStorageKey(name), value);
  }

  function userLocalRemove(name) {
    localStorage.removeItem(userStorageKey(name));
  }

  function showLoggedOut(message = '') {
    state.authUser = null;
    state.currentRecording = null;
    state.recoverableRecording = null;
    state.currentSpeakerAnalysisId = null;
    document.body.classList.add('logged-out');
    els.currentUserLabel.textContent = '';
    els.loginMessage.textContent = message;
    els.loginMessage.classList.toggle('hidden', !message);
    els.loginPassword.value = '';
    setTimeout(() => els.loginUsername.focus(), 0);
  }

  function showLoggedIn(user) {
    state.authUser = user;
    state.currentSpeakerAnalysisId = userLocalGet('speakerAnalysisId') || null;
    els.currentUserLabel.textContent = user.display_name || user.username;
    document.body.classList.remove('logged-out');
    els.loginMessage.classList.add('hidden');
  }

  async function loginUser(event) {
    event?.preventDefault();
    els.loginButton.disabled = true;
    els.loginMessage.classList.add('hidden');
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: els.loginUsername.value.trim(),
          password: els.loginPassword.value,
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.detail || 'Sign in failed');
      showLoggedIn(payload.user);
      await startAuthenticatedApp();
    } catch (error) {
      showLoggedOut(error.message);
    } finally {
      els.loginButton.disabled = false;
    }
  }

  async function logoutUser() {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } finally {
      sessionStorage.removeItem('parentPin');
      els.parentPin.value = '';
      setTranscript('');
      showLoggedOut();
    }
  }

  async function startAuthenticatedApp() {
    await Promise.allSettled([checkHealth(), loadVoices()]);
    renderTranscript();
    syncRecordingUI();
    await checkRecoverable();
  }

  async function bootstrapAuth() {
    await checkHealth();
    try {
      const response = await fetch('/api/auth/me', { cache: 'no-store' });
      if (!response.ok) {
        showLoggedOut();
        return;
      }
      const payload = await response.json();
      showLoggedIn(payload.user);
      await startAuthenticatedApp();
    } catch {
      showLoggedOut('Could not check sign-in status.');
    }
  }

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
    if (state.currentRecording) {
      userLocalSet('activeRecordingId', state.currentRecording.id);
      userLocalSet('activeRecordingDraft', state.transcript);
    }
    renderTranscript();
    if (state.recording) scheduleDraftSave();
  }

  function commitLivePending() {
    if (state.livePending) state.confirmedTranscript = joinText(state.confirmedTranscript, state.livePending);
    state.livePending = '';
    state.transcript = state.confirmedTranscript.trim();
    renderTranscript();
  }

  async function api(url, options = {}) {
    const response = await fetch(url, options);
    const type = response.headers.get('content-type') || '';
    const payload = response.status === 204 ? null : (type.includes('application/json') ? await response.json() : await response.text());
    if (!response.ok) {
      const detail = typeof payload === 'string' ? payload : payload?.detail || JSON.stringify(payload);
      if (response.status === 401 && detail === 'Login required') {
        showLoggedOut('Your session ended. Please sign in again.');
      }
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

  function captureModeLabel(mode = els.captureSource?.value || 'microphone') {
    if (mode === 'computer') return 'Computer audio';
    if (mode === 'mixed') return 'Computer + microphone';
    return 'Microphone';
  }

  function updateCaptureSourceUI() {
    const mode = els.captureSource?.value || 'microphone';
    const label = captureModeLabel(mode);
    if (els.captureSourceHint) {
      const description = mode === 'computer'
        ? 'Choose a browser tab, window or screen and enable Share audio when the browser offers it.'
        : (mode === 'mixed'
          ? 'Captures shared computer audio and this device\'s microphone into one recording.'
          : 'Uses this device\'s microphone.');
      els.captureSourceHint.replaceChildren();
      const strong = document.createElement('strong'); strong.textContent = label;
      const span = document.createElement('span'); span.className = 'muted'; span.textContent = description;
      els.captureSourceHint.append(strong, span);
    }
    if (!state.recording && !state.transcribing) {
      els.recordButtonText.textContent = mode === 'microphone' ? 'Start talking' : 'Start capture';
      els.recordButton.setAttribute(
        'aria-label',
        mode === 'microphone' ? 'Start talking' : 'Start ' + label.toLowerCase(),
      );
    }
  }

  async function openCaptureStreams(mode, ctx) {
    if (!navigator.mediaDevices) throw new Error('Audio capture is not supported in this browser.');

    if (mode === 'microphone') {
      const mic = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      return { stream: mic, streams: [mic], sources: [] };
    }

    if (!navigator.mediaDevices.getDisplayMedia) {
      throw new Error('Computer audio capture is not supported by this browser. Try Chrome or Edge on a computer.');
    }

    let display;
    try {
      display = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
        systemAudio: 'include',
        surfaceSwitching: 'include',
        selfBrowserSurface: 'exclude',
      });
    } catch (error) {
      if (error?.name === 'NotAllowedError') throw new Error('Computer audio sharing was cancelled or not allowed.');
      throw error;
    }

    const sharedAudio = display.getAudioTracks();
    if (!sharedAudio.length) {
      display.getTracks().forEach((track) => track.stop());
      throw new Error('No shared audio was provided. Choose a tab/screen with Share audio enabled, or use the microphone.');
    }

    if (mode === 'computer') {
      const audioOnly = new MediaStream(sharedAudio);
      return { stream: audioOnly, streams: [display], sources: [] };
    }

    let mic;
    try {
      mic = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (error) {
      display.getTracks().forEach((track) => track.stop());
      throw error;
    }

    const destination = ctx.createMediaStreamDestination();
    const displaySource = ctx.createMediaStreamSource(new MediaStream(sharedAudio));
    const micSource = ctx.createMediaStreamSource(mic);
    displaySource.connect(destination);
    micSource.connect(destination);

    return {
      stream: destination.stream,
      streams: [display, mic],
      sources: [displaySource, micSource],
      destination,
    };
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
    els.recordButtonText.textContent = state.recording
      ? 'Stop & finish'
      : ((els.captureSource?.value || 'microphone') === 'microphone' ? 'Start talking' : 'Start capture');
    els.recordButton.disabled = state.transcribing;
    els.pauseButton.classList.toggle('hidden', !state.recording);
    els.pauseButton.textContent = state.paused ? 'Carry on' : 'Pause';
    els.language.disabled = state.recording || state.transcribing;
    els.chunkSeconds.disabled = state.recording || state.transcribing;
    if (els.captureSource) els.captureSource.disabled = state.recording || state.transcribing;
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
    userLocalSet('activeRecordingId', state.currentRecording.id);
    userLocalSet('activeRecordingDraft', draft);
    const updated = await api('/api/recordings/' + state.currentRecording.id + '/draft', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: draft, active_capture: state.recording || state.transcribing }),
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
    const mode = els.captureSource?.value || 'microphone';
    if (!window.isSecureContext && !['localhost', '127.0.0.1'].includes(location.hostname)) {
      return setError(mode === 'microphone' ? 'The microphone needs HTTPS.' : 'Computer audio capture needs HTTPS.');
    }

    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      const ctx = new AudioContext();
      state.audioContext = ctx;

      // getDisplayMedia must stay directly tied to the button press. Ask for
      // sharing before awaiting AudioContext.resume() so transient activation
      // is not lost on stricter browsers.
      const capture = await openCaptureStreams(mode, ctx);
      await ctx.resume();
      const stream = capture.stream;
      const source = ctx.createMediaStreamSource(stream);
      const processor = ctx.createScriptProcessor(4096, 1, 1);
      const mute = ctx.createGain(); mute.gain.value = 0;

      let record = reuseExisting ? state.currentRecording : null;
      try {
        if (!record) record = await createRecording();
      } catch (error) {
        capture.streams.forEach((item) => item.getTracks().forEach((track) => track.stop()));
        capture.sources.forEach((item) => { try { item.disconnect(); } catch {} });
        try { capture.destination?.disconnect(); } catch {}
        await ctx.close();
        throw error;
      }

      const displayedText = reuseExisting ? state.transcript.trim() : '';
      const savedBase = reuseExisting ? String(record.transcript_edited ?? record.transcript_original ?? '').trim() : '';
      state.currentRecording = record;
      state.captureBaseTranscript = savedBase;
      state.continuation = Boolean(reuseExisting && savedBase);
      state.stream = stream;
      state.captureStreams = capture.streams;
      state.audioContext = ctx;
      state.source = source;
      state.inputSources = capture.sources;
      state.mixDestination = capture.destination || null;
      state.processor = processor;
      state.mute = mute;
      state.captureMode = mode;
      state.sampleRate = ctx.sampleRate;
      state.fullBuffers = [];
      resetLive();
      state.recording = true;
      state.paused = false;
      state.autoFollow = true;
      state.confirmedTranscript = displayedText;
      state.transcript = displayedText;
      userLocalSet('activeRecordingId', record.id);
      userLocalSet('activeRecordingDraft', displayedText);
      renderTranscript();

      const displayStream = capture.streams.find((item) => item.getVideoTracks().length);
      const displayTrack = displayStream?.getVideoTracks()[0];
      if (displayTrack) {
        displayTrack.addEventListener('ended', () => {
          if (state.recording && state.captureMode !== 'microphone') stopRecording();
        }, { once: true });
      }

      processor.onaudioprocess = (event) => {
        if (!state.recording || state.paused) return setMeter(0);
        const input = event.inputBuffer.getChannelData(0);
        const chunk = new Float32Array(input);
        state.fullBuffers.push(chunk);
        state.liveBuffers.push(chunk);
        state.liveSampleCount += chunk.length;
        state.liveFreshSamples += chunk.length;
        maybeFlushLiveChunk();
        let sum = 0;
        for (let i = 0; i < input.length; i += 1) sum += input[i] * input[i];
        setMeter(Math.sqrt(sum / input.length));
      };

      source.connect(processor);
      processor.connect(mute);
      mute.connect(ctx.destination);
      startTimer();
      syncRecordingUI();

      const label = captureModeLabel(mode);
      const detail = reuseExisting
        ? 'Your new words will be added to this piece.'
        : (mode === 'microphone'
          ? 'Your words will appear a few seconds behind you.'
          : (mode === 'mixed'
            ? 'Shared computer audio and microphone are being captured together.'
            : 'Shared computer audio is being captured directly.'));
      setStatus(reuseExisting ? 'Keep going' : (mode === 'microphone' ? 'I’m listening' : 'Capturing ' + label.toLowerCase()), detail);
      scheduleDraftSave(true);
    } catch (error) {
      cleanupRecording();
      setError(error?.message || 'I could not open the selected audio source.');
    }
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

    if (finalChunk && window.TalkToTypeAudio?.analyzeFinalTail) {
      const freshSamples = Math.min(state.liveFreshSamples, merged.length);
      const freshTail = merged.slice(Math.max(0, merged.length - freshSamples));
      const analysis = window.TalkToTypeAudio.analyzeFinalTail(freshTail, state.sampleRate);
      if (!analysis.hasSpeech) {
        state.liveBuffers = [];
        state.liveSampleCount = 0;
        state.liveFreshSamples = 0;
        console.info(
          '[Talk to Type] Skipped quiet final tail before Whisper',
          {
            durationMs: Math.round(analysis.durationMs),
            activeMs: Math.round(analysis.activeMs),
            overallRms: Number(analysis.overallRms.toFixed(5)),
            peakFrameRms: Number(analysis.peakFrameRms.toFixed(5)),
          },
        );
        return false;
      }
    }

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
    try { state.source?.disconnect(); } catch {}
    for (const inputSource of state.inputSources || []) { try { inputSource.disconnect(); } catch {} }
    try { state.mixDestination?.disconnect(); } catch {}
    try { state.mute?.disconnect(); } catch {}
    const streams = state.captureStreams?.length ? state.captureStreams : (state.stream ? [state.stream] : []);
    for (const stream of streams) stream.getTracks().forEach((track) => track.stop());
    if (state.audioContext && state.audioContext.state !== 'closed') state.audioContext.close().catch(() => {});
    state.stream = null;
    state.captureStreams = [];
    state.audioContext = null;
    state.source = null;
    state.inputSources = [];
    state.mixDestination = null;
    state.processor = null;
    state.mute = null;
    state.recording = false;
    state.paused = false;
    syncRecordingUI();
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
      audioForm.append('duration_seconds', String(elapsed));
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
      userLocalRemove('activeRecordingId');
      userLocalRemove('activeRecordingDraft');
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
      userLocalSet('activeRecordingId', record.id);
      const form = new FormData(); form.append('file', file, file.name); form.append('task', 'transcriptions');
      if (els.language.value) form.append('language', els.language.value);
      if (els.prompt.value.trim()) form.append('prompt', els.prompt.value.trim());
      const finished = await api('/api/recordings/' + record.id + '/transcribe', { method: 'POST', body: form });
      state.currentRecording = finished;
      userLocalRemove('activeRecordingId'); userLocalRemove('activeRecordingDraft');
      setTranscript(finished.transcript); setStatus('All done!', 'The file is saved in My words.');
    } catch (error) { setError(error.message); setStatus('Something went wrong', 'You can try again.'); }
    finally { state.transcribing = false; els.fileInput.value = ''; syncRecordingUI(); }
  }

  function newRecordingView() {
    if (state.recording) return;
    stopSpeech(); exitReadingFocus();
    state.currentRecording = null; state.captureBaseTranscript = ''; state.continuation = false;
    setTranscript(''); setError('');
    const mode = els.captureSource?.value || 'microphone';
    setStatus(
      'Ready when you are',
      mode === 'microphone'
        ? 'Press the microphone and talk normally.'
        : 'Press Start capture, then choose what to share and enable Share audio.',
    );
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
        userLocalSet('editDraft:' + state.currentRecording.id, state.transcript);
        els.wordCount.textContent = wordCount(state.transcript) + ' words';
        scheduleEditAutosave();
      });
      row.append(number, textarea); els.sentenceEditor.appendChild(row); autoGrowEditor(textarea);
    }
  }

  function openEditor() {
    if (!state.currentRecording || !state.transcript || state.recording) return;
    state.editSnapshot = state.transcript;
    const localDraft = userLocalGet('editDraft:' + state.currentRecording.id);
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
    userLocalSet('editDraft:' + state.currentRecording.id, edited);
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
      userLocalRemove('editDraft:' + state.currentRecording.id);
      state.currentRecording = updated; setTranscript(updated.transcript); closeEditor();
      showToast('Words saved');
    } catch (error) { setError(error.message); }
  }

  async function undoEdit() {
    clearTimeout(state.editSaveTimer);
    const original = state.editSnapshot;
    userLocalRemove('editDraft:' + state.currentRecording.id);
    try {
      await api('/api/recordings/' + state.currentRecording.id + '/draft', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '' }),
      });
    } catch {}
    state.currentRecording = { ...state.currentRecording, draft_text: null };
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

  async function playRecording() {
    if (!state.currentRecording?.has_audio) return;

    stopSpeech();
    const token = state.playbackToken;
    const buttonText = els.playRecordingButton.textContent;
    els.playRecordingButton.disabled = true;
    els.playRecordingButton.textContent = 'Checking voice…';

    try {
      const manifest = await api(
        '/api/recordings/' + state.currentRecording.id + '/audio-segments',
        { cache: 'no-store' },
      );
      if (!manifest.complete) {
        throw new Error(
          'This voice recording is incomplete: ' +
          manifest.available_count + ' of ' + manifest.segment_count +
          ' voice parts are available.'
        );
      }
      if (!manifest.segment_count) {
        throw new Error('No saved voice audio is available for this piece.');
      }
      if (state.playbackToken !== token) return;

      const audio = new Audio(
        '/api/recordings/' + state.currentRecording.id +
        '/audio-combined?play=' + Date.now()
      );
      audio.preload = 'metadata';
      state.currentAudio = audio;
      state.currentAudioUrl = null;
      els.playRecordingButton.textContent = 'Playing voice…';

      const result = await new Promise((resolve, reject) => {
        audio.addEventListener('ended', () => resolve('ended'), { once: true });
        audio.addEventListener('pause', () => {
          if (!audio.ended) resolve('paused');
        }, { once: true });
        audio.addEventListener('error', () => {
          reject(new Error('The complete voice recording could not be played.'));
        }, { once: true });
        audio.play().catch(reject);
      });

      if (state.playbackToken === token && result === 'ended') {
        const duration = Number(manifest.duration_seconds || 0);
        showToast(
          manifest.segment_count > 1
            ? ('Played all ' + manifest.segment_count + ' voice parts' + (duration ? ' · ' + formatTime(duration) : ''))
            : 'Voice playback finished'
        );
      }
    } catch (error) {
      if (state.playbackToken === token) setError(error.message);
    } finally {
      if (state.currentAudio && state.playbackToken === token) {
        state.currentAudio = null;
      }
      els.playRecordingButton.disabled = false;
      els.playRecordingButton.textContent = buttonText;
    }
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
      let record = await api('/api/recoverable', { cache: 'no-store' });
      const localId = userLocalGet('activeRecordingId');
      const localDraft = (userLocalGet('activeRecordingDraft') || '').trim();

      if (!record && localId) {
        try { record = await api('/api/recordings/' + localId, { cache: 'no-store' }); } catch {}
      }
      if (!record) return;

      if (localId === record.id && localDraft && wordCount(localDraft) >= wordCount(record.transcript || '')) {
        record = { ...record, transcript: localDraft, draft_text: localDraft, word_count: wordCount(localDraft) };
      }
      if (!record.transcript || record.status === 'ready') return;

      const noticeToken = recoveryNoticeToken(record);
      if (noticeToken && userLocalGet('dismissedRecoveryNotice') === noticeToken) return;

      state.recoverableRecording = record;
      els.recoveryDetail.textContent = record.word_count + ' words were saved as a draft.';
      els.recoveryBanner.classList.remove('hidden');
    } catch {}
  }

  function recoveryNoticeToken(record) {
    if (!record?.id) return '';
    const activity = record.last_activity_at || '';
    let hash = 2166136261;
    const text = String(record.draft_text || record.transcript || '');
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return record.id + ':' + activity + ':' + (hash >>> 0).toString(16);
  }

  async function acknowledgeRecovery(record) {
    if (!record?.id) return;
    const token = recoveryNoticeToken(record);
    if (token) userLocalSet('dismissedRecoveryNotice', token);
    try {
      await api('/api/recordings/' + record.id + '/recovery-acknowledged', { method: 'POST' });
    } catch {}
  }

  function recoverWords() {
    const record = state.recoverableRecording;
    if (!record) return;
    acknowledgeRecovery(record);
    state.currentRecording = record;
    setTranscript(record.draft_text || record.transcript);
    els.recoveryBanner.classList.add('hidden');
    setStatus('Your words are back', 'Press Keep talking to carry on, or edit what you already have.');
    switchPage('talk');
    showToast('Draft recovered');
  }

  function dismissRecovery() {
    const record = state.recoverableRecording;
    if (record) acknowledgeRecovery(record);
    state.recoverableRecording = null;
    els.recoveryBanner.classList.add('hidden');
    showToast('Recovery reminder dismissed');
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

  function parentHeaders() {
    const pin = els.parentPin.value.trim();
    sessionStorage.setItem('parentPin', pin);
    return pin ? { 'X-Parent-Pin': pin } : {};
  }

  async function loadProgress() {
    const headers = parentHeaders();
    try {
      const data = await api('/api/progress?days=' + els.progressDays.value, { headers, cache: 'no-store' });
      renderProgress(data);
      els.progressContent.classList.remove('hidden');
      await loadParentTools();
    } catch (error) {
      els.progressContent.classList.add('hidden');
      alert(error.message);
    }
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

  function formatBytes(bytes) {
    const value = Number(bytes || 0);
    if (value < 1024) return value + ' B';
    if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KB';
    if (value < 1024 * 1024 * 1024) return (value / (1024 * 1024)).toFixed(1) + ' MB';
    return (value / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
  }

  async function loadParentTools() {
    await Promise.allSettled([loadAdminStatus(), loadRecycleBin(), loadSpeakerTools(), loadUsers()]);
  }

  async function loadUsers() {
    try {
      const users = await api('/api/admin/users', { headers: parentHeaders(), cache: 'no-store' });
      renderUsers(users);
    } catch (error) {
      els.userList.replaceChildren();
      const p = document.createElement('p'); p.className = 'error'; p.textContent = error.message;
      els.userList.appendChild(p);
    }
  }

  function renderUsers(users) {
    els.userList.replaceChildren();
    for (const user of users) {
      const row = document.createElement('div'); row.className = 'user-row';

      const main = document.createElement('div'); main.className = 'user-row-main';
      const name = document.createElement('strong');
      name.textContent = user.display_name + (user.is_current ? ' · current' : '');
      const meta = document.createElement('span'); meta.className = 'user-row-meta';
      meta.textContent = '@' + user.username + ' · ' + user.recordings + ' recording' + (user.recordings === 1 ? '' : 's') + (user.is_active ? '' : ' · inactive');
      main.append(name, meta);

      const display = document.createElement('input');
      display.value = user.display_name;
      display.setAttribute('aria-label', 'Display name for ' + user.username);

      const password = document.createElement('input');
      password.type = 'password';
      password.placeholder = 'New password (optional)';
      password.autocomplete = 'new-password';
      password.setAttribute('aria-label', 'New password for ' + user.username);

      const actions = document.createElement('div'); actions.className = 'button-row';
      const save = document.createElement('button'); save.type = 'button'; save.textContent = 'Save';
      save.addEventListener('click', async () => {
        const body = { display_name: display.value.trim() };
        if (password.value) body.password = password.value;
        try {
          await api('/api/admin/users/' + user.id, {
            method: 'PATCH',
            headers: { ...parentHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
          password.value = '';
          showToast('User updated');
          await loadUsers();
          if (user.is_current && body.display_name) {
            state.authUser.display_name = body.display_name;
            els.currentUserLabel.textContent = body.display_name;
          }
        } catch (error) {
          els.userAdminMessage.textContent = error.message;
        }
      });

      const toggle = document.createElement('button'); toggle.type = 'button';
      toggle.textContent = user.is_active ? 'Deactivate' : 'Reactivate';
      toggle.className = user.is_active ? 'danger' : '';
      toggle.disabled = Boolean(user.is_current && user.is_active);
      toggle.addEventListener('click', async () => {
        if (user.is_active && !confirm('Deactivate ' + user.display_name + '? They will no longer be able to sign in.')) return;
        try {
          await api('/api/admin/users/' + user.id, {
            method: 'PATCH',
            headers: { ...parentHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ is_active: !user.is_active }),
          });
          showToast(user.is_active ? 'User deactivated' : 'User reactivated');
          await loadUsers();
        } catch (error) {
          els.userAdminMessage.textContent = error.message;
        }
      });

      actions.append(save, toggle);
      row.append(main, display, password, actions);
      els.userList.appendChild(row);
    }
  }

  async function createUser(event) {
    event.preventDefault();
    els.createUserButton.disabled = true;
    els.userAdminMessage.textContent = '';
    try {
      await api('/api/admin/users', {
        method: 'POST',
        headers: { ...parentHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: els.newUsername.value.trim(),
          display_name: els.newUserDisplayName.value.trim(),
          password: els.newUserPassword.value,
        }),
      });
      els.createUserForm.reset();
      els.userAdminMessage.textContent = 'User added.';
      await loadUsers();
    } catch (error) {
      els.userAdminMessage.textContent = error.message;
    } finally {
      els.createUserButton.disabled = false;
    }
  }

  async function loadSpeakerTools() {
    await Promise.allSettled([loadSpeakerStatusAndRecordings(), loadSpeakerProfiles()]);
    if (state.currentSpeakerAnalysisId && !state.speakerPolling) {
      pollSpeakerAnalysis(state.currentSpeakerAnalysisId, true);
    }
  }

  async function loadSpeakerStatusAndRecordings() {
    const headers = parentHeaders();
    try {
      const [status, recordings] = await Promise.all([
        api('/api/admin/speakers/status', { headers, cache: 'no-store' }),
        api('/api/admin/speakers/recordings', { headers, cache: 'no-store' }),
      ]);

      const service = status.service || {};
      if (!status.reachable) {
        els.speakerServiceStatus.textContent = 'Unavailable';
        els.speakerServiceStatus.className = 'pill speaker-warning';
        els.speakerAnalysisMessage.textContent = 'Speaker analyzer is not reachable.';
      } else if (!service.configured) {
        els.speakerServiceStatus.textContent = 'Needs HF token';
        els.speakerServiceStatus.className = 'pill speaker-warning';
        els.speakerAnalysisMessage.textContent = 'Accept the pyannote Community-1 terms and add HF_TOKEN to .env.';
      } else {
        els.speakerServiceStatus.textContent = service.loaded ? 'Ready' : 'Ready · model loads on first use';
        els.speakerServiceStatus.className = 'pill speaker-ready';
        if (!state.speakerPolling) els.speakerAnalysisMessage.textContent = '';
      }

      const selected = els.speakerRecordingSelect.value;
      els.speakerRecordingSelect.replaceChildren();
      const placeholder = document.createElement('option');
      placeholder.value = ''; placeholder.textContent = 'Choose a recording…';
      els.speakerRecordingSelect.appendChild(placeholder);
      for (const recording of recordings) {
        const option = document.createElement('option');
        option.value = recording.id;
        const duration = recording.duration_seconds ? ' · ' + formatTime(recording.duration_seconds) : '';
        option.textContent = (recording.title || 'Recording') + ' · ' + friendlyDate(recording.created_at) + duration;
        els.speakerRecordingSelect.appendChild(option);
      }
      if ([...els.speakerRecordingSelect.options].some((option) => option.value === selected)) {
        els.speakerRecordingSelect.value = selected;
      }
    } catch (error) {
      els.speakerServiceStatus.textContent = 'Unavailable';
      els.speakerServiceStatus.className = 'pill speaker-warning';
      els.speakerAnalysisMessage.textContent = error.message;
    }
  }

  async function loadSpeakerProfiles() {
    try {
      const profiles = await api('/api/admin/speakers/profiles', { headers: parentHeaders(), cache: 'no-store' });
      renderSpeakerProfiles(profiles);
    } catch (error) {
      els.speakerProfilesList.replaceChildren();
      const p = document.createElement('p'); p.className = 'error'; p.textContent = error.message;
      els.speakerProfilesList.appendChild(p);
    }
  }

  function renderSpeakerProfiles(profiles) {
    els.speakerProfilesList.replaceChildren();
    if (!profiles.length) {
      const p = document.createElement('p'); p.className = 'muted'; p.textContent = 'No remembered speakers yet.';
      els.speakerProfilesList.appendChild(p);
      return;
    }
    for (const profile of profiles) {
      const row = document.createElement('div'); row.className = 'speaker-profile-row';
      const input = document.createElement('input'); input.value = profile.name; input.setAttribute('aria-label', 'Remembered speaker name');

      const meta = document.createElement('span'); meta.className = 'muted';
      meta.textContent =
        profile.sample_count + '/' + profile.max_samples + ' voice samples · profile ' + profile.profile_quality;

      const save = document.createElement('button'); save.type = 'button'; save.textContent = 'Save name';
      save.addEventListener('click', async () => {
        const name = input.value.trim();
        if (!name) return;
        await api('/api/admin/speakers/profiles/' + profile.id, {
          method: 'PATCH',
          headers: { ...parentHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ name }),
        });
        showToast('Speaker name saved');
        await loadSpeakerProfiles();
        if (state.currentSpeakerAnalysisId) await refreshCurrentSpeakerAnalysis();
      });

      const forget = document.createElement('button'); forget.type = 'button'; forget.className = 'danger'; forget.textContent = 'Forget voiceprint';
      forget.addEventListener('click', async () => {
        if (!confirm('Forget the saved voiceprint for ' + profile.name + '? Past conversation labels will stay.')) return;
        await api('/api/admin/speakers/profiles/' + profile.id, { method: 'DELETE', headers: parentHeaders() });
        showToast('Voiceprint forgotten');
        await loadSpeakerProfiles();
        if (state.currentSpeakerAnalysisId) await refreshCurrentSpeakerAnalysis();
      });

      const samples = document.createElement('details'); samples.className = 'voice-sample-details';
      const summary = document.createElement('summary');
      summary.textContent = 'Review ' + profile.sample_count + ' voice sample' + (profile.sample_count === 1 ? '' : 's');
      samples.appendChild(summary);

      const list = document.createElement('div'); list.className = 'voice-sample-list';
      for (const sample of profile.samples || []) {
        const sampleRow = document.createElement('div'); sampleRow.className = 'voice-sample-row';
        const info = document.createElement('div');
        const title = document.createElement('strong'); title.textContent = sample.source_recording_title || 'Saved voice sample';
        const detail = document.createElement('span'); detail.className = 'muted';
        const speech = sample.speech_seconds == null ? 'legacy sample' : (sample.speech_seconds.toFixed(1) + 's speech');
        detail.textContent = speech + ' · ' + friendlyDate(sample.created_at);
        info.append(title, detail);

        const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'danger small'; remove.textContent = 'Remove sample';
        remove.disabled = profile.sample_count <= 1;
        remove.title = profile.sample_count <= 1 ? 'Use Forget voiceprint to remove the final sample.' : 'Remove this sample from future matching';
        remove.addEventListener('click', async () => {
          if (!confirm('Remove this voice sample from ' + profile.name + '?')) return;
          try {
            await api('/api/admin/speakers/profiles/' + profile.id + '/samples/' + sample.id, {
              method: 'DELETE', headers: parentHeaders(),
            });
            showToast('Voice sample removed');
            await loadSpeakerProfiles();
            if (state.currentSpeakerAnalysisId) await refreshCurrentSpeakerAnalysis();
          } catch (error) {
            showToast(error.message);
          }
        });

        sampleRow.append(info, remove);
        list.appendChild(sampleRow);
      }
      samples.appendChild(list);

      row.append(input, meta, save, forget, samples);
      els.speakerProfilesList.appendChild(row);
    }
  }

  async function runSpeakerAnalysis() {
    const recordingId = els.speakerRecordingSelect.value;
    if (!recordingId) {
      els.speakerAnalysisMessage.textContent = 'Choose a saved recording first.';
      return;
    }
    const count = els.speakerCountSelect.value ? Number(els.speakerCountSelect.value) : null;
    els.runSpeakerAnalysisButton.disabled = true;
    els.speakerAnalysisMessage.textContent = 'Starting speaker analysis…';
    els.speakerAnalysisResult.replaceChildren();
    try {
      const job = await api('/api/admin/speakers/analyze/' + recordingId, {
        method: 'POST',
        headers: { ...parentHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ num_speakers: count }),
      });
      state.currentSpeakerAnalysisId = job.id;
      userLocalSet('speakerAnalysisId', job.id);
      await pollSpeakerAnalysis(job.id);
    } catch (error) {
      els.speakerAnalysisMessage.textContent = error.message;
    } finally {
      els.runSpeakerAnalysisButton.disabled = false;
    }
  }

  async function pollSpeakerAnalysis(analysisId, quiet = false) {
    if (state.speakerPolling) return;
    state.speakerPolling = true;
    try {
      for (let attempt = 0; attempt < 900; attempt += 1) {
        const analysis = await api('/api/admin/speakers/analyses/' + analysisId, { headers: parentHeaders(), cache: 'no-store' });
        if (analysis.status === 'completed') {
          state.currentSpeakerAnalysisId = analysis.id;
          userLocalSet('speakerAnalysisId', analysis.id);
          renderSpeakerAnalysis(analysis);
          await loadSpeakerProfiles();
          return;
        }
        if (analysis.status === 'error') {
          els.speakerAnalysisMessage.textContent = analysis.error || 'Speaker analysis failed.';
          return;
        }
        if (!quiet || attempt > 0) {
          els.speakerAnalysisMessage.textContent = analysis.status === 'queued'
            ? 'Speaker analysis is queued…'
            : 'Finding speakers and transcribing their turns…';
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
      els.speakerAnalysisMessage.textContent = 'Analysis is still running. Reload the parent area to check it again.';
    } catch (error) {
      els.speakerAnalysisMessage.textContent = error.message;
    } finally {
      state.speakerPolling = false;
    }
  }

  async function refreshCurrentSpeakerAnalysis() {
    if (!state.currentSpeakerAnalysisId) return;
    try {
      const analysis = await api('/api/admin/speakers/analyses/' + state.currentSpeakerAnalysisId, { headers: parentHeaders(), cache: 'no-store' });
      if (analysis.status === 'completed') renderSpeakerAnalysis(analysis);
    } catch {}
  }

  function renderSpeakerAnalysis(analysis) {
    els.speakerAnalysisMessage.textContent =
      analysis.speaker_count + ' speaker' + (analysis.speaker_count === 1 ? '' : 's') +
      ' found · processed in ' + analysis.processing_seconds + 's';
    els.speakerAnalysisResult.replaceChildren();

    const speakerHeading = document.createElement('h4'); speakerHeading.textContent = 'Speaker labels';
    const speakerGrid = document.createElement('div'); speakerGrid.className = 'speaker-detection-grid';

    for (const detection of analysis.detections) {
      const card = document.createElement('div'); card.className = 'speaker-detection-card';
      const top = document.createElement('div'); top.className = 'speaker-detection-top';
      const title = document.createElement('strong'); title.textContent = 'Person ' + detection.person_index;
      const badge = document.createElement('span'); badge.className = detection.profile_id ? 'speaker-match matched' : 'speaker-match';
      badge.textContent = detection.profile_id
        ? ('Recognised · similarity ' + Number(detection.match_score || 0).toFixed(2))
        : 'Not remembered';
      top.append(title, badge);

      const input = document.createElement('input'); input.value = detection.display_name; input.setAttribute('aria-label', 'Speaker label');
      const actions = document.createElement('div'); actions.className = 'button-row';
      const save = document.createElement('button'); save.type = 'button'; save.textContent = 'Save tag';
      save.addEventListener('click', async () => {
        const name = input.value.trim();
        if (!name) return;
        await api('/api/admin/speakers/analyses/' + analysis.id + '/detections/' + encodeURIComponent(detection.speaker_key), {
          method: 'PATCH',
          headers: { ...parentHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ display_name: name }),
        });
        showToast('Speaker tag saved');
        await refreshCurrentSpeakerAnalysis();
      });
      const remember = document.createElement('button'); remember.type = 'button'; remember.className = 'primary';
      remember.textContent = detection.profile_id ? 'Add voice sample' : 'Remember this speaker';
      remember.disabled = !detection.can_remember;
      remember.title = detection.can_remember
        ? 'Add this conversation as another confirmed voice sample'
        : 'Need at least 3 seconds of this person speaking before learning their voice.';
      const speechInfo = document.createElement('span'); speechInfo.className = 'muted small-note';
      speechInfo.textContent = Number(detection.speech_seconds || 0).toFixed(1) + 's attributed speech';
      remember.addEventListener('click', async () => {
        const name = input.value.trim();
        if (!name) return;
        try {
          const saved = await api('/api/admin/speakers/analyses/' + analysis.id + '/detections/' + encodeURIComponent(detection.speaker_key) + '/remember', {
            method: 'POST',
            headers: { ...parentHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ name }),
          });
          showToast(saved.already_saved
            ? 'This voice sample was already saved'
            : ('Voice sample added · ' + saved.sample_count + ' total'));
          await Promise.all([loadSpeakerProfiles(), refreshCurrentSpeakerAnalysis()]);
        } catch (error) {
          showToast(error.message);
        }
      });
      actions.append(save, remember);
      card.append(top, input, speechInfo, actions);
      speakerGrid.appendChild(card);
    }

    const transcriptHeading = document.createElement('h4'); transcriptHeading.textContent = 'Conversation';
    const conversation = document.createElement('div'); conversation.className = 'speaker-conversation';
    for (const turn of analysis.turns) {
      if (!turn.text) continue;
      const row = document.createElement('div'); row.className = 'speaker-turn';
      const meta = document.createElement('div'); meta.className = 'speaker-turn-meta';
      const who = document.createElement('strong'); who.textContent = turn.display_name;
      const when = document.createElement('span'); when.className = 'muted'; when.textContent = formatTime(turn.start_seconds);
      meta.append(who, when);
      const text = document.createElement('p'); text.textContent = turn.text;
      row.append(meta, text); conversation.appendChild(row);
    }
    if (!conversation.children.length) {
      const p = document.createElement('p'); p.className = 'muted'; p.textContent = 'No spoken turns were transcribed.';
      conversation.appendChild(p);
    }

    els.speakerAnalysisResult.append(speakerHeading, speakerGrid, transcriptHeading, conversation);
  }

  async function loadAdminStatus() {
    const status = await api('/api/admin/status', { headers: parentHeaders(), cache: 'no-store' });
    els.retentionDays.value = String(status.retention?.audio_retention_days || 0);
    els.deleteAudioImmediately.checked = Boolean(status.retention?.delete_audio_after_transcription);
    els.retentionDays.disabled = els.deleteAudioImmediately.checked;

    const rows = [
      ['Database', status.database ? 'Connected' : 'Problem', status.database],
      ['Speech gateway', status.speech_gateway ? ('Ready' + (status.speech_gateway_version ? ' · v' + status.speech_gateway_version : '')) : 'Problem', status.speech_gateway],
      ['Saved recordings', String(status.recordings), true],
      ['Recycle bin', String(status.recycle_bin), true],
      ['Voice files', status.audio_files + ' · ' + formatBytes(status.audio_bytes), true],
      ['Last app backup', status.last_backup_at ? friendlyDate(status.last_backup_at) : 'Not downloaded yet', Boolean(status.last_backup_at)],
    ];
    els.systemStatus.replaceChildren();
    for (const [label, value, good] of rows) {
      const row = document.createElement('div'); row.className = 'status-row';
      const name = document.createElement('span'); name.textContent = label;
      const val = document.createElement('span'); val.className = good ? 'status-good' : 'status-bad'; val.textContent = value;
      row.append(name, val); els.systemStatus.appendChild(row);
    }
  }

  async function saveRetention() {
    const immediate = els.deleteAudioImmediately.checked;
    const days = immediate ? 0 : Number(els.retentionDays.value);
    els.retentionMessage.textContent = 'Saving…';
    try {
      const policy = await api('/api/admin/retention', {
        method: 'PATCH',
        headers: { ...parentHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ audio_retention_days: days, delete_audio_after_transcription: immediate }),
      });
      els.retentionDays.value = String(policy.audio_retention_days || 0);
      els.retentionDays.disabled = Boolean(policy.delete_audio_after_transcription);
      els.retentionMessage.textContent = policy.delete_audio_after_transcription
        ? 'Future voice audio will be removed once transcription is saved.'
        : (policy.audio_retention_days ? 'Voice audio older than ' + policy.audio_retention_days + ' days will be removed.' : 'Voice audio will be kept until you delete it.');
      await loadAdminStatus();
    } catch (error) {
      els.retentionMessage.textContent = error.message;
    }
  }

  async function applyRetentionNow() {
    if (!confirm('Apply the current voice-audio retention rule now? Transcripts and history will stay.')) return;
    els.applyRetentionButton.disabled = true;
    try {
      const result = await api('/api/admin/retention/apply', { method: 'POST', headers: parentHeaders() });
      els.retentionMessage.textContent = result.removed_recordings
        ? 'Removed stored voice audio from ' + result.removed_recordings + ' recording(s).'
        : 'Nothing needed cleaning up.';
      await loadAdminStatus();
      if (state.currentRecording) {
        try {
          const refreshed = await api('/api/recordings/' + state.currentRecording.id, { cache: 'no-store' });
          state.currentRecording = refreshed; renderTranscript();
        } catch {}
      }
    } catch (error) {
      els.retentionMessage.textContent = error.message;
    } finally {
      els.applyRetentionButton.disabled = false;
    }
  }

  async function loadRecycleBin() {
    els.recycleList.innerHTML = '<p class="muted">Loading…</p>';
    try {
      const records = await api('/api/admin/recycle-bin', { headers: parentHeaders(), cache: 'no-store' });
      renderRecycleBin(records);
    } catch (error) {
      els.recycleList.innerHTML = '<p class="error">' + escapeHtml(error.message) + '</p>';
    }
  }

  function renderRecycleBin(records) {
    els.recycleList.replaceChildren();
    if (!records.length) {
      els.recycleList.innerHTML = '<p class="muted">Recycle bin is empty.</p>';
      return;
    }
    for (const record of records) {
      const card = document.createElement('article'); card.className = 'recycle-card';
      const title = document.createElement('h4'); title.textContent = record.title || 'Recording';
      const meta = document.createElement('div'); meta.className = 'history-meta';
      const deleted = document.createElement('span'); deleted.textContent = record.deleted_at ? 'Deleted ' + friendlyDate(record.deleted_at) : 'Deleted';
      const words = document.createElement('span'); words.textContent = record.word_count + ' words';
      meta.append(deleted, words);
      const snippet = document.createElement('p'); snippet.className = 'snippet';
      snippet.textContent = record.transcript.slice(0, 220) + (record.transcript.length > 220 ? '…' : '');
      const actions = document.createElement('div'); actions.className = 'recycle-actions';
      const restore = document.createElement('button'); restore.textContent = '↩ Restore';
      restore.addEventListener('click', async () => {
        try {
          await api('/api/admin/recycle-bin/' + record.id + '/restore', { method: 'POST', headers: parentHeaders() });
          await Promise.all([loadRecycleBin(), loadAdminStatus()]);
        } catch (error) { alert(error.message); }
      });
      const remove = document.createElement('button'); remove.className = 'danger'; remove.textContent = 'Permanently delete';
      remove.addEventListener('click', async () => {
        if (!confirm('Permanently delete this recording, transcript history and any saved voice audio? This cannot be undone.')) return;
        try {
          await api('/api/admin/recycle-bin/' + record.id, { method: 'DELETE', headers: parentHeaders() });
          await Promise.all([loadRecycleBin(), loadAdminStatus()]);
        } catch (error) { alert(error.message); }
      });
      actions.append(restore, remove); card.append(title, meta, snippet, actions); els.recycleList.appendChild(card);
    }
  }

  async function downloadBackup() {
    els.downloadBackupButton.disabled = true;
    els.downloadBackupButton.classList.add('backup-working');
    const originalText = els.downloadBackupButton.textContent;
    els.downloadBackupButton.textContent = 'Preparing backup…';
    try {
      const response = await fetch('/api/admin/backup', { headers: parentHeaders() });
      if (!response.ok) {
        const type = response.headers.get('content-type') || '';
        const payload = type.includes('application/json') ? await response.json() : await response.text();
        throw new Error(typeof payload === 'string' ? payload : payload.detail || 'Backup failed');
      }
      const blob = await response.blob();
      const disposition = response.headers.get('content-disposition') || '';
      const match = disposition.match(/filename="?([^"]+)"?/i);
      const filename = match?.[1] || 'local-transcriber-backup.zip';
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a'); link.href = url; link.download = filename;
      document.body.appendChild(link); link.click(); link.remove(); URL.revokeObjectURL(url);
      await loadAdminStatus();
    } catch (error) {
      alert(error.message);
    } finally {
      els.downloadBackupButton.disabled = false;
      els.downloadBackupButton.classList.remove('backup-working');
      els.downloadBackupButton.textContent = originalText;
    }
  }

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
  els.loginForm.addEventListener('submit', loginUser);
  els.logoutButton.addEventListener('click', logoutUser);
  els.loadProgressButton.addEventListener('click', loadProgress);
  els.progressDays.addEventListener('change', () => { if (!els.progressContent.classList.contains('hidden')) loadProgress(); });
  els.runSpeakerAnalysisButton.addEventListener('click', runSpeakerAnalysis);
  els.refreshSpeakerProfilesButton.addEventListener('click', loadSpeakerProfiles);
  els.refreshUsersButton.addEventListener('click', loadUsers);
  els.createUserForm.addEventListener('submit', createUser);
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
  els.captureSource.addEventListener('change', () => {
    localStorage.setItem('captureSource', els.captureSource.value);
    updateCaptureSourceUI();
    if (!state.currentRecording) newRecordingView();
  });
  els.parentPin.value = sessionStorage.getItem('parentPin') || '';
  const savedCaptureSource = localStorage.getItem('captureSource');
  if (savedCaptureSource && [...els.captureSource.options].some((option) => option.value === savedCaptureSource)) {
    els.captureSource.value = savedCaptureSource;
  }
  updateCaptureSourceUI();

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

  renderTranscript();
  syncRecordingUI();
  bootstrapAuth();

})();
