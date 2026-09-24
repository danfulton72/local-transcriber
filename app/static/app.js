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
    currentAudioKind: null,
    playbackRecordingId: null,
    playbackDuration: 0,
    playbackFollow: true,
    playbackActiveTurnId: null,
    editingSpeakerTurnId: null,
    editingSpeakerIdentityTurnId: null,
    speakerTurnSaveTimer: null,
    speakerTurnSaveChain: Promise.resolve(),
    playbackToken: 0,
    searchTimer: null,
    autoFollow: true,
    programmaticScrollAt: 0,
    lastScrollY: window.scrollY,
    installPrompt: null,
    currentSpeakerAnalysisId: null,
    speakerPolling: false,
    speakerTurns: [],
    speakerProfiles: [],
    knownSpeakerProfiles: [],
    speakerPreviewAudio: null,
    speakerPreviewUrl: null,
    speakerPreviewKey: null,
    speakerPreviewButton: null,
    authUser: null,
  };

  const els = {
    loginScreen: $('loginScreen'), loginForm: $('loginForm'), loginUsername: $('loginUsername'), loginPassword: $('loginPassword'),
    loginButton: $('loginButton'), loginMessage: $('loginMessage'), currentUserLabel: $('currentUserLabel'), logoutButton: $('logoutButton'),
    healthBadge: $('healthBadge'), menuButton: $('menuButton'), closeMenuButton: $('closeMenuButton'),
    appDrawer: $('appDrawer'), drawerBackdrop: $('drawerBackdrop'),
    recordButton: $('recordButton'), recordButtonIcon: $('recordButtonIcon'), recordButtonText: $('recordButtonText'), meter: $('meter'),
    statusText: $('statusText'), statusDetail: $('statusDetail'), timer: $('timer'), pauseButton: $('pauseButton'),
    errorBox: $('errorBox'), transcriptView: $('transcriptView'), wordCount: $('wordCount'),
    recordingTitleRow: $('recordingTitleRow'), recordingTitleInput: $('recordingTitleInput'),
    saveRecordingTitleButton: $('saveRecordingTitleButton'), recordingTitleStatus: $('recordingTitleStatus'),
    editorWrap: $('editorWrap'), sentenceEditor: $('sentenceEditor'), editSaveStatus: $('editSaveStatus'), saveEditButton: $('saveEditButton'), cancelEditButton: $('cancelEditButton'),
    hearButton: $('hearButton'), focusButton: $('focusButton'), focusExitButton: $('focusExitButton'), useWordsButton: $('useWordsButton'),
    playRecordingButton: $('playRecordingButton'), editButton: $('editButton'), favouriteButton: $('favouriteButton'), newButton: $('newButton'), keepTalkingButton: $('keepTalkingButton'),
    playbackBar: $('playbackBar'), playbackBackButton: $('playbackBackButton'), playbackToggleButton: $('playbackToggleButton'),
    playbackForwardButton: $('playbackForwardButton'), playbackTime: $('playbackTime'), playbackRate: $('playbackRate'),
    playbackFollowButton: $('playbackFollowButton'), followWordsButton: $('followWordsButton'),
    recoveryBanner: $('recoveryBanner'), recoveryDetail: $('recoveryDetail'), recoverButton: $('recoverButton'), dismissRecoveryButton: $('dismissRecoveryButton'),
    toast: $('toast'),
    language: $('language'), chunkSeconds: $('chunkSeconds'), captureSource: $('captureSource'), captureSourceHint: $('captureSourceHint'),
    voice: $('voice'), speechSpeed: $('speechSpeed'), prompt: $('prompt'), fileInput: $('fileInput'),
    installAppButton: $('installAppButton'), installHint: $('installHint'),
    historyList: $('historyList'), historySearch: $('historySearch'), historyFavourites: $('historyFavourites'), refreshHistoryButton: $('refreshHistoryButton'),
    progressDays: $('progressDays'), progressContent: $('progressContent'), progressRecentList: $('progressRecentList'),
    metricGrid: $('metricGrid'), correctionsList: $('correctionsList'), dailyChart: $('dailyChart'), longestPiece: $('longestPiece'),
    retentionDays: $('retentionDays'), deleteAudioImmediately: $('deleteAudioImmediately'),
    saveRetentionButton: $('saveRetentionButton'), applyRetentionButton: $('applyRetentionButton'), retentionMessage: $('retentionMessage'),
    systemStatus: $('systemStatus'), downloadBackupButton: $('downloadBackupButton'), refreshAdminButton: $('refreshAdminButton'),
    recycleList: $('recycleList'), refreshRecycleButton: $('refreshRecycleButton'),
    speakerServiceStatus: $('speakerServiceStatus'), speakerRecordingSelect: $('speakerRecordingSelect'),
    speakerCountSelect: $('speakerCountSelect'), runSpeakerAnalysisButton: $('runSpeakerAnalysisButton'),
    speakerAnalysisMessage: $('speakerAnalysisMessage'), speakerAnalysisResult: $('speakerAnalysisResult'),
    speakerProfilesList: $('speakerProfilesList'), refreshSpeakerProfilesButton: $('refreshSpeakerProfilesButton'),
    relabelSamplesList: $('relabelSamplesList'), refreshRelabelSamplesButton: $('refreshRelabelSamplesButton'),
    userList: $('userList'), refreshUsersButton: $('refreshUsersButton'), createUserForm: $('createUserForm'),
    newUsername: $('newUsername'), newUserDisplayName: $('newUserDisplayName'), newUserPassword: $('newUserPassword'), newUserIsAdmin: $('newUserIsAdmin'),
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

  function isAdmin() {
    return Boolean(state.authUser?.is_admin);
  }

  function applyRoleVisibility() {
    const allowed = isAdmin();
    document.body.classList.toggle('admin-user', allowed);
    document.querySelectorAll('.admin-only').forEach((node) => {
      node.hidden = !allowed;
    });
    const activeAdminPage = document.querySelector('.page.active.admin-page');
    if (!allowed && activeAdminPage) switchPage('talk');
  }

  function showLoggedOut(message = '') {
    closeDrawer();
    state.authUser = null;
    state.currentRecording = null;
    state.recoverableRecording = null;
    state.currentSpeakerAnalysisId = null;
    document.body.classList.add('logged-out');
    els.currentUserLabel.textContent = '';
    els.loginMessage.textContent = message;
    els.loginMessage.classList.toggle('hidden', !message);
    els.loginPassword.value = '';
    applyRoleVisibility();
    setTimeout(() => els.loginUsername.focus(), 0);
  }

  function showLoggedIn(user) {
    state.authUser = user;
    state.currentSpeakerAnalysisId = userLocalGet('speakerAnalysisId') || null;
    els.currentUserLabel.textContent = user.display_name || user.username;
    document.body.classList.remove('logged-out');
    els.loginMessage.classList.add('hidden');
    applyRoleVisibility();
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
      setTranscript('');
      showLoggedOut();
    }
  }

  async function startAuthenticatedApp() {
    await Promise.allSettled([checkHealth(), loadVoices(), loadKnownSpeakerProfiles()]);
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

  function openDrawer() {
    if (!els.appDrawer || !els.drawerBackdrop) return;
    els.appDrawer.classList.add('open');
    els.appDrawer.setAttribute('aria-hidden', 'false');
    els.drawerBackdrop.classList.remove('hidden');
    els.drawerBackdrop.setAttribute('aria-hidden', 'false');
    els.menuButton?.setAttribute('aria-expanded', 'true');
    document.body.classList.add('drawer-open');
    for (const selector of ['.topbar', '.tabs', 'main', 'footer']) {
      const node = document.querySelector(selector);
      if (node) node.inert = true;
    }
    setTimeout(() => els.closeMenuButton?.focus(), 0);
  }

  function closeDrawer({ restoreFocus = false } = {}) {
    if (!els.appDrawer || !els.drawerBackdrop) return;
    const wasOpen = els.appDrawer.classList.contains('open');
    els.appDrawer.classList.remove('open');
    els.appDrawer.setAttribute('aria-hidden', 'true');
    els.drawerBackdrop.classList.add('hidden');
    els.drawerBackdrop.setAttribute('aria-hidden', 'true');
    els.menuButton?.setAttribute('aria-expanded', 'false');
    document.body.classList.remove('drawer-open');
    for (const selector of ['.topbar', '.tabs', 'main', 'footer']) {
      const node = document.querySelector(selector);
      if (node) node.inert = false;
    }
    if (restoreFocus && wasOpen) els.menuButton?.focus();
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

  function speakerTranscriptText() {
    return (state.speakerTurns || [])
      .map((turn) => String(turn?.text || '').trim())
      .filter(Boolean)
      .join(' ')
      .trim();
  }

  function updatePlaybackFollowButton() {
    const show = state.currentAudioKind === 'recording' && !state.playbackFollow;
    els.playbackFollowButton?.classList.toggle('hidden', !show);
  }

  function syncPlaybackUI() {
    const audio = state.currentAudioKind === 'recording' ? state.currentAudio : null;
    const sameRecording = Boolean(
      audio && state.currentRecording && state.playbackRecordingId === state.currentRecording.id
    );
    const playing = Boolean(sameRecording && !audio.paused && !audio.ended);
    const ended = Boolean(sameRecording && audio.ended);
    const current = sameRecording ? Number(audio.currentTime || 0) : 0;
    const duration = sameRecording
      ? Number((Number.isFinite(audio.duration) ? audio.duration : 0) || state.playbackDuration || 0)
      : Number(state.playbackDuration || 0);

    els.playbackBar?.classList.toggle('hidden', !sameRecording);
    if (els.playbackToggleButton) {
      els.playbackToggleButton.textContent = playing ? '❚❚' : '▶';
      els.playbackToggleButton.setAttribute('aria-label', playing ? 'Pause saved voice' : 'Play saved voice');
    }
    if (els.playbackTime) {
      els.playbackTime.textContent = formatTime(current) + ' / ' + formatTime(duration);
    }
    if (els.playRecordingButton) {
      if (!state.currentRecording?.has_audio) {
        els.playRecordingButton.textContent = '▶ My voice';
      } else if (playing) {
        els.playRecordingButton.textContent = '❚❚ Pause voice';
      } else if (ended) {
        els.playRecordingButton.textContent = '↻ Replay voice';
      } else if (sameRecording) {
        els.playRecordingButton.textContent = '▶ Resume voice';
      } else {
        els.playRecordingButton.textContent = '▶ My voice';
      }
    }
    updatePlaybackFollowButton();
  }

  function setActivePlaybackTurn(turnId, { follow = true } = {}) {
    if (state.playbackActiveTurnId === turnId) return;
    state.playbackActiveTurnId = turnId || null;
    document.querySelectorAll('.transcript-speaker-turn.playback-current').forEach((node) => {
      node.classList.remove('playback-current');
    });
    if (!turnId) return;
    const target = els.transcriptView.querySelector('[data-turn-id="' + turnId + '"]');
    if (!target) return;
    target.classList.add('playback-current');
    if (follow && state.playbackFollow && !state.editingSpeakerTurnId) {
      state.programmaticScrollAt = Date.now();
      requestAnimationFrame(() => target.scrollIntoView({ behavior: 'smooth', block: 'center' }));
    }
  }

  function updatePlaybackFromAudio() {
    const audio = state.currentAudioKind === 'recording' ? state.currentAudio : null;
    if (!audio) return;
    syncPlaybackUI();
    const time = Number(audio.currentTime || 0);
    const turns = Array.isArray(state.speakerTurns) ? state.speakerTurns : [];
    const active = turns.find((turn) => {
      const start = Number(turn.start_seconds || 0);
      const end = Number(turn.end_seconds || start);
      return time >= start && time < Math.max(end, start + 0.05);
    }) || [...turns].reverse().find((turn) => time >= Number(turn.start_seconds || 0));
    setActivePlaybackTurn(active?.id || null);
  }

  function pausePlaybackFollowing() {
    if (state.currentAudioKind !== 'recording') return;
    state.playbackFollow = false;
    updatePlaybackFollowButton();
  }

  async function saveSpeakerTurn(recordingId, turnId, text, statusNode = null) {
    if (!recordingId || !turnId) return;
    const clean = String(text ?? '').trim();
    if (statusNode) statusNode.textContent = 'Saving…';
    try {
      const result = await api(
        '/api/recordings/' + recordingId + '/speaker-turns/' + turnId,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: clean }),
        },
      );
      if (state.currentRecording?.id !== recordingId) return;
      const turn = state.speakerTurns.find((item) => item.id === turnId);
      if (turn) {
        turn.text = result.text;
        turn.edited = result.edited;
        turn.updated_at = result.updated_at;
      }
      state.transcript = result.transcript;
      state.currentRecording = {
        ...state.currentRecording,
        transcript: result.transcript,
        transcript_edited: result.transcript,
        word_count: result.word_count,
      };
      els.wordCount.textContent = result.word_count + ' word' + (result.word_count === 1 ? '' : 's');
      if (statusNode) statusNode.textContent = 'Saved ✓';
    } catch (error) {
      if (statusNode) statusNode.textContent = 'Not saved';
      setError('Could not save this correction: ' + error.message);
    }
  }

  function scheduleSpeakerTurnSave(turnId, textarea, statusNode, immediate = false) {
    const turn = state.speakerTurns.find((item) => item.id === turnId);
    const recordingId = state.currentRecording?.id;
    if (!turn || !recordingId) return;
    turn.text = textarea.value;
    state.transcript = speakerTranscriptText();
    const count = wordCount(state.transcript);
    els.wordCount.textContent = count + ' word' + (count === 1 ? '' : 's');
    if (statusNode) statusNode.textContent = immediate ? 'Saving…' : 'Saving soon…';
    clearTimeout(state.speakerTurnSaveTimer);

    const enqueue = () => {
      const value = textarea.value;
      state.speakerTurnSaveChain = state.speakerTurnSaveChain
        .catch(() => {})
        .then(() => saveSpeakerTurn(recordingId, turnId, value, statusNode));
    };

    if (immediate) {
      enqueue();
    } else {
      state.speakerTurnSaveTimer = setTimeout(enqueue, 650);
    }
  }

  async function saveSpeakerIdentity(turnId, payload) {
    const recordingId = state.currentRecording?.id;
    if (!recordingId || !turnId) return;
    try {
      const result = await api(
        '/api/recordings/' + recordingId + '/speaker-turns/' + turnId + '/identity',
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        },
      );
      if (state.currentRecording?.id !== recordingId) return;
      state.speakerTurns = Array.isArray(result?.turns) ? result.turns : state.speakerTurns;
      state.editingSpeakerIdentityTurnId = null;
      renderTranscript();
      showToast('Speaker name saved');
    } catch (error) {
      setError('Could not save this speaker correction: ' + error.message);
    }
  }

  async function beginSpeakerIdentityEdit(turnId) {
    if (!turnId || state.recording || state.transcribing) return;
    await loadKnownSpeakerProfiles();
    state.editingSpeakerIdentityTurnId = turnId;
    pausePlaybackFollowing();
    renderTranscript();
    requestAnimationFrame(() => {
      const select = els.transcriptView.querySelector(
        '.transcript-speaker-turn[data-turn-id="' + turnId + '"] .speaker-name-select'
      );
      select?.focus();
    });
  }

  function beginSpeakerTurnEdit(turnId) {
    if (!turnId || state.recording || state.transcribing) return;
    state.editingSpeakerTurnId = turnId;
    pausePlaybackFollowing();
    renderTranscript();
    requestAnimationFrame(() => {
      const textarea = els.transcriptView.querySelector(
        '.transcript-speaker-turn[data-turn-id="' + turnId + '"] textarea'
      );
      if (textarea) {
        textarea.focus();
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);
      }
    });
  }

  function finishSpeakerTurnEdit(turnId) {
    if (state.editingSpeakerTurnId !== turnId) return;
    clearTimeout(state.speakerTurnSaveTimer);
    const block = els.transcriptView.querySelector(
      '.transcript-speaker-turn[data-turn-id="' + turnId + '"]'
    );
    const textarea = block?.querySelector('textarea');
    const status = block?.querySelector('.turn-edit-status');
    if (textarea) scheduleSpeakerTurnSave(turnId, textarea, status, true);
    state.editingSpeakerTurnId = null;
    renderTranscript();
  }

  function renderTranscript() {
    const text = state.transcript.trim();
    const liveMode = state.recording || state.transcribing;
    const confirmed = liveMode ? state.confirmedTranscript.trim() : text;
    const pending = liveMode ? state.livePending.trim() : '';
    const labelledTurns = !liveMode && Array.isArray(state.speakerTurns)
      ? state.speakerTurns.filter((turn) => String(turn?.text || '').trim())
      : [];
    syncRecordingTitleUI();
    els.transcriptView.replaceChildren();
    els.transcriptView.classList.toggle('speaker-labelled', labelledTurns.length > 0);
    const count = wordCount(text);
    els.wordCount.textContent = count + ' word' + (count === 1 ? '' : 's');

    if (!text) {
      els.transcriptView.classList.add('empty');
      const p = document.createElement('p');
      p.textContent = 'Your words will appear here.';
      els.transcriptView.appendChild(p);
    } else {
      els.transcriptView.classList.remove('empty');
      if (labelledTurns.length) {
        for (const turn of labelledTurns) {
          const block = document.createElement('section');
          block.className = 'transcript-speaker-turn';
          block.dataset.turnId = turn.id;
          if (turn.id === state.playbackActiveTurnId) block.classList.add('playback-current');
          if (turn.id === state.editingSpeakerTurnId) block.classList.add('editing');

          const meta = document.createElement('div');
          meta.className = 'transcript-speaker-meta';

          const nameWrap = document.createElement('div');
          nameWrap.className = 'transcript-speaker-name-wrap';
          if (turn.id === state.editingSpeakerIdentityTurnId) {
            const currentProfile = state.knownSpeakerProfiles.find(
              (profile) => profile.name.toLocaleLowerCase() === String(turn.display_name || '').toLocaleLowerCase()
            );

            const nameSelect = document.createElement('select');
            nameSelect.className = 'speaker-name-select';
            nameSelect.setAttribute('aria-label', 'Choose a remembered speaker');
            const placeholder = document.createElement('option');
            placeholder.value = '';
            placeholder.textContent = state.knownSpeakerProfiles.length
              ? 'Choose a remembered voice…'
              : 'No remembered voices yet';
            nameSelect.appendChild(placeholder);

            for (const profile of state.knownSpeakerProfiles) {
              const option = document.createElement('option');
              option.value = 'profile:' + profile.id;
              option.textContent = profile.name;
              nameSelect.appendChild(option);
            }

            const newNameOption = document.createElement('option');
            newNameOption.value = 'new';
            newNameOption.textContent = '＋ New name…';
            nameSelect.appendChild(newNameOption);

            const nameInput = document.createElement('input');
            nameInput.className = 'speaker-name-input hidden';
            nameInput.maxLength = 120;
            nameInput.placeholder = 'Type a new speaker name';
            nameInput.setAttribute('aria-label', 'New speaker name');

            if (currentProfile) {
              nameSelect.value = 'profile:' + currentProfile.id;
            }

            const selectionPayload = (scope) => {
              if (nameSelect.value.startsWith('profile:')) {
                return { target_profile_id: nameSelect.value.slice(8), scope };
              }
              if (nameSelect.value === 'new') {
                const name = nameInput.value.trim();
                if (name) return { name, scope };
              }
              setError('Choose a remembered voice or select New name and enter a name.');
              return null;
            };

            const syncNewName = () => {
              const manual = nameSelect.value === 'new';
              nameInput.classList.toggle('hidden', !manual);
              if (manual) {
                requestAnimationFrame(() => nameInput.focus());
              } else {
                nameInput.value = '';
              }
            };
            nameSelect.addEventListener('change', syncNewName);

            const nameActions = document.createElement('div');
            nameActions.className = 'speaker-name-edit-actions';

            const saveTurn = document.createElement('button');
            saveTurn.type = 'button';
            saveTurn.textContent = 'This turn';
            saveTurn.title = 'Use this speaker for only this spoken turn';
            saveTurn.addEventListener('click', () => {
              const payload = selectionPayload('turn');
              if (payload) saveSpeakerIdentity(turn.id, payload);
            });

            const saveAll = document.createElement('button');
            saveAll.type = 'button';
            saveAll.textContent = 'All matching turns';
            saveAll.title = 'Use this speaker for every turn from the same originally detected speaker';
            saveAll.addEventListener('click', () => {
              const payload = selectionPayload('detection');
              if (payload) saveSpeakerIdentity(turn.id, payload);
            });

            const unknown = document.createElement('button');
            unknown.type = 'button';
            unknown.textContent = 'Unknown';
            unknown.addEventListener('click', () => {
              saveSpeakerIdentity(turn.id, { unknown: true, scope: 'turn' });
            });

            const reset = document.createElement('button');
            reset.type = 'button';
            reset.textContent = 'Reset';
            reset.title = 'Restore the original detected speaker identity';
            reset.addEventListener('click', () => {
              saveSpeakerIdentity(turn.id, { clear: true, scope: 'turn' });
            });

            const cancel = document.createElement('button');
            cancel.type = 'button';
            cancel.textContent = 'Cancel';
            cancel.addEventListener('click', () => {
              state.editingSpeakerIdentityTurnId = null;
              renderTranscript();
            });

            nameInput.addEventListener('keydown', (event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                const payload = selectionPayload('turn');
                if (payload) saveSpeakerIdentity(turn.id, payload);
              } else if (event.key === 'Escape') {
                state.editingSpeakerIdentityTurnId = null;
                renderTranscript();
              }
            });
            nameSelect.addEventListener('keydown', (event) => {
              if (event.key === 'Escape') {
                state.editingSpeakerIdentityTurnId = null;
                renderTranscript();
              }
            });

            nameActions.append(saveTurn, saveAll, unknown, reset, cancel);
            nameWrap.append(nameSelect, nameInput, nameActions);
          } else {
            const name = document.createElement('button');
            name.type = 'button';
            name.className = 'transcript-speaker-name-button';
            name.textContent = turn.display_name || 'Speaker';
            name.title = 'Correct this speaker name';
            name.setAttribute('aria-label', 'Correct speaker name ' + (turn.display_name || 'Speaker'));
            if (turn.identity_corrected) name.classList.add('corrected');
            name.addEventListener('click', () => beginSpeakerIdentityEdit(turn.id));
            nameWrap.appendChild(name);
          }

          const metaActions = document.createElement('div');
          metaActions.className = 'transcript-turn-actions';
          const seek = document.createElement('button');
          seek.type = 'button';
          seek.className = 'turn-seek-button';
          seek.textContent = '▶ ' + formatTime(turn.start_seconds || 0);
          seek.title = 'Play from ' + formatTime(turn.start_seconds || 0);
          seek.addEventListener('click', () => playRecording(Number(turn.start_seconds || 0)));

          const read = document.createElement('button');
          read.type = 'button';
          read.className = 'turn-read-button';
          read.textContent = '🔊';
          read.title = 'Hear this turn read aloud';
          read.setAttribute('aria-label', 'Hear ' + (turn.display_name || 'speaker') + ' read aloud');
          read.addEventListener('click', () => speakText(turn.text));
          metaActions.append(seek, read);
          meta.append(nameWrap, metaActions);

          const body = document.createElement('div');
          body.className = 'transcript-speaker-text';
          if (turn.id === state.editingSpeakerTurnId) {
            const textarea = document.createElement('textarea');
            textarea.className = 'turn-inline-editor';
            textarea.value = turn.text;
            textarea.setAttribute('aria-label', 'Edit words spoken by ' + (turn.display_name || 'speaker'));
            textarea.addEventListener('focus', pausePlaybackFollowing);

            const footer = document.createElement('div');
            footer.className = 'turn-edit-footer';
            const status = document.createElement('span');
            status.className = 'turn-edit-status';
            status.textContent = turn.edited ? 'Saved ✓' : 'Original words';
            const done = document.createElement('button');
            done.type = 'button';
            done.className = 'turn-edit-done';
            done.textContent = 'Done';
            done.addEventListener('mousedown', (event) => event.preventDefault());
            done.addEventListener('click', () => finishSpeakerTurnEdit(turn.id));

            textarea.addEventListener('input', () => scheduleSpeakerTurnSave(turn.id, textarea, status));
            textarea.addEventListener('blur', () => scheduleSpeakerTurnSave(turn.id, textarea, status, true));
            footer.append(status, done);
            body.append(textarea, footer);
          } else {
            const edit = document.createElement('button');
            edit.type = 'button';
            edit.className = 'transcript-turn-edit';
            edit.textContent = turn.text;
            edit.title = 'Edit these words while listening';
            edit.addEventListener('click', () => beginSpeakerTurnEdit(turn.id));
            body.appendChild(edit);
          }

          block.append(meta, body);
          els.transcriptView.appendChild(block);
        }
      } else if (confirmed) {
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
    syncPlaybackUI();
  }

  function setTranscript(text, speakerTurns = []) {
    state.transcript = String(text || '').trim();
    state.speakerTurns = Array.isArray(speakerTurns) ? speakerTurns : [];
    state.editingSpeakerTurnId = null;
    state.editingSpeakerIdentityTurnId = null;
    state.playbackActiveTurnId = null;
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

  async function loadKnownSpeakerProfiles() {
    try {
      const profiles = await api('/api/speaker-profiles', { cache: 'no-store' });
      state.knownSpeakerProfiles = Array.isArray(profiles) ? profiles : [];
    } catch {
      state.knownSpeakerProfiles = [];
    }
    return state.knownSpeakerProfiles;
  }

  function syncRecordingTitleUI() {
    if (!els.recordingTitleRow) return;
    const record = state.currentRecording;
    const visible = Boolean(record && record.status === 'ready' && !state.recording && !state.transcribing);
    els.recordingTitleRow.classList.toggle('hidden', !visible);
    if (!visible) {
      if (els.recordingTitleStatus) els.recordingTitleStatus.textContent = '';
      return;
    }
    if (document.activeElement !== els.recordingTitleInput) {
      els.recordingTitleInput.value = record.title || '';
    }
  }

  async function saveRecordingTitle() {
    const record = state.currentRecording;
    if (!record || record.status !== 'ready') return;
    const title = els.recordingTitleInput.value.trim();
    els.saveRecordingTitleButton.disabled = true;
    els.recordingTitleStatus.textContent = 'Saving…';
    try {
      const updated = await api('/api/recordings/' + record.id, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
      });
      if (state.currentRecording?.id !== record.id) return;
      state.currentRecording = updated;
      els.recordingTitleInput.value = updated.title || '';
      els.recordingTitleStatus.textContent = 'Saved ✓';
      showToast('Title saved');
    } catch (error) {
      els.recordingTitleStatus.textContent = 'Not saved';
      setError('Could not save this title: ' + error.message);
    } finally {
      els.saveRecordingTitleButton.disabled = false;
    }
  }

  function captureModeLabel(mode = els.captureSource?.value || 'microphone') {
    if (mode === 'computer') return 'Computer audio';
    if (mode === 'mixed') return 'Computer audio + microphone';
    return 'Microphone';
  }

  function updateCaptureSourceUI() {
    const displaySupported = Boolean(navigator.mediaDevices?.getDisplayMedia);
    if (!displaySupported && els.captureSource && els.captureSource.value !== 'microphone') {
      els.captureSource.value = 'microphone';
      localStorage.setItem('captureSource', 'microphone');
    }
    if (els.captureSource) {
      for (const option of els.captureSource.options) {
        if (option.value !== 'microphone') option.disabled = !displaySupported;
      }
    }
    const mode = els.captureSource?.value || 'microphone';
    const label = captureModeLabel(mode);
    if (els.captureSourceHint) {
      const description = mode === 'computer'
        ? (displaySupported
          ? 'Teams/desktop app: choose Entire Screen + Share system audio. Browser media: choose the tab + Share tab audio.'
          : 'This browser does not offer computer-audio sharing. Use the microphone or a supported desktop browser.')
        : (mode === 'mixed'
          ? (displaySupported
            ? 'Teams/desktop app: choose Entire Screen + Share system audio. Your microphone is mixed into the same recording.'
            : 'This browser does not offer computer-audio sharing. Use the microphone instead.')
          : 'Uses this device\'s microphone.');
      els.captureSourceHint.replaceChildren();
      const strong = document.createElement('strong'); strong.textContent = label;
      const span = document.createElement('span'); span.className = 'muted'; span.textContent = description;
      els.captureSourceHint.append(strong, span);
    }
    if (!state.recording && !state.transcribing) {
      els.recordButtonIcon.textContent = mode === 'microphone' ? '🎙' : (mode === 'mixed' ? '🎧' : '🔊');
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
        windowAudio: 'system',
        monitorTypeSurfaces: 'include',
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
      const surface = display.getVideoTracks()[0]?.getSettings?.().displaySurface || '';
      const guidance = surface === 'monitor'
        ? 'Choose Entire Screen and turn on Share system audio.'
        : 'For Teams/desktop apps choose Entire Screen + Share system audio; for browser media choose the tab + Share tab audio.';
      throw new Error('No computer audio was provided. ' + guidance);
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
    if (els.menuButton) els.menuButton.disabled = state.recording || state.transcribing;
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
        const activeTitle = state.captureMode === 'microphone' ? 'I’m listening' : 'Capturing audio';
        setStatus(state.recording ? activeTitle : 'Nearly done', state.liveQueue.length ? (state.liveQueue.length + ' little bits waiting') : 'Checking your latest words…');
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
    const activeTitle = state.captureMode === 'microphone' ? 'I’m listening' : 'Capturing audio';
    setStatus(state.paused ? 'Paused' : activeTitle, state.paused ? 'Press Carry on when you are ready.' : (state.captureMode === 'microphone' ? 'Keep talking.' : 'Shared audio capture is running.'));
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

  function clearPlaybackHighlight() {
    state.playbackActiveTurnId = null;
    document.querySelectorAll('.transcript-speaker-turn.playback-current').forEach((node) => {
      node.classList.remove('playback-current');
    });
  }

  function stopSpeech() {
    state.playbackToken += 1;
    if (state.currentAudio) {
      try { state.currentAudio.pause(); } catch {}
    }
    if (state.currentAudioUrl) URL.revokeObjectURL(state.currentAudioUrl);
    state.currentAudio = null;
    state.currentAudioUrl = null;
    state.currentAudioKind = null;
    state.playbackRecordingId = null;
    state.playbackDuration = 0;
    state.playbackFollow = true;
    clearPlaybackHighlight();
    els.playbackBar?.classList.add('hidden');
    syncPlaybackUI();
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
      state.currentAudio = audio; state.currentAudioUrl = url; state.currentAudioKind = 'tts';
      audio.addEventListener('ended', stopSpeech, { once: true }); await audio.play();
    } catch (error) { setError('Read-aloud failed: ' + error.message); }
  }

  async function prepareRecordingPlayback(startAt = 0) {
    if (!state.currentRecording?.has_audio) return null;

    stopSpeech();
    const token = state.playbackToken;
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
      if (state.playbackToken !== token) return null;

      const audio = new Audio(
        '/api/recordings/' + state.currentRecording.id +
        '/audio-combined?play=' + Date.now()
      );
      audio.preload = 'metadata';
      state.currentAudio = audio;
      state.currentAudioUrl = null;
      state.currentAudioKind = 'recording';
      state.playbackRecordingId = state.currentRecording.id;
      state.playbackDuration = Number(manifest.duration_seconds || 0);
      state.playbackFollow = true;

      const savedRate = Number(localStorage.getItem('playbackRate') || els.playbackRate?.value || 1);
      const rate = [0.75, 1, 1.25, 1.5].includes(savedRate) ? savedRate : 1;
      audio.playbackRate = rate;
      if (els.playbackRate) els.playbackRate.value = String(rate);

      audio.addEventListener('loadedmetadata', () => {
        if (Number.isFinite(audio.duration) && audio.duration > 0) {
          state.playbackDuration = audio.duration;
        }
        if (startAt > 0) audio.currentTime = Math.min(startAt, Math.max(0, audio.duration || startAt));
        updatePlaybackFromAudio();
      });
      audio.addEventListener('timeupdate', updatePlaybackFromAudio);
      audio.addEventListener('play', syncPlaybackUI);
      audio.addEventListener('pause', syncPlaybackUI);
      audio.addEventListener('ratechange', syncPlaybackUI);
      audio.addEventListener('ended', () => {
        updatePlaybackFromAudio();
        syncPlaybackUI();
        showToast(
          manifest.segment_count > 1
            ? 'Played all ' + manifest.segment_count + ' voice parts'
            : 'Voice playback finished'
        );
      });
      audio.addEventListener('error', () => {
        if (state.playbackToken === token) setError('The complete voice recording could not be played.');
      });

      els.playbackBar?.classList.remove('hidden');
      syncPlaybackUI();
      await audio.play();
      return audio;
    } catch (error) {
      if (state.playbackToken === token) setError(error.message);
      stopSpeech();
      return null;
    } finally {
      els.playRecordingButton.disabled = !state.currentRecording?.has_audio;
      syncPlaybackUI();
    }
  }

  async function playRecording(startAt = null) {
    if (!state.currentRecording?.has_audio) return;

    const audio = (
      state.currentAudioKind === 'recording' &&
      state.playbackRecordingId === state.currentRecording.id
    ) ? state.currentAudio : null;

    if (!audio) {
      await prepareRecordingPlayback(Number(startAt || 0));
      return;
    }

    if (startAt !== null && Number.isFinite(Number(startAt))) {
      audio.currentTime = Math.max(0, Math.min(Number(startAt), audio.duration || Number(startAt)));
      state.playbackFollow = true;
      updatePlaybackFollowButton();
      updatePlaybackFromAudio();
      if (audio.paused || audio.ended) await audio.play();
      return;
    }

    if (audio.ended) {
      audio.currentTime = 0;
      state.playbackFollow = true;
      updatePlaybackFollowButton();
      await audio.play();
    } else if (audio.paused) {
      await audio.play();
    } else {
      audio.pause();
    }
    syncPlaybackUI();
  }

  function seekPlaybackBy(seconds) {
    const audio = state.currentAudioKind === 'recording' ? state.currentAudio : null;
    if (!audio) {
      if (seconds >= 0) playRecording(0);
      return;
    }
    audio.currentTime = Math.max(0, Math.min((audio.duration || Infinity), audio.currentTime + seconds));
    updatePlaybackFromAudio();
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
    if ((name === 'progress' || name === 'tools') && !isAdmin()) {
      showToast('Admin access required');
      name = 'talk';
    }
    if (name !== 'tools') stopSpeakerPreview();
    closeDrawer();
    document.querySelectorAll('.page').forEach((page) => page.classList.toggle('active', page.id === 'page-' + name));
    document.querySelectorAll('.tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.page === name));
    if (name === 'history') loadHistory();
    if (name === 'progress') loadProgress();
    if (name === 'tools') loadTools();
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

  async function openHistoryRecording(record) {
    stopSpeech();
    setError('');
    try {
      const [fresh, speakerData] = await Promise.all([
        api('/api/recordings/' + record.id, { cache: 'no-store' }),
        api('/api/recordings/' + record.id + '/speaker-turns', { cache: 'no-store' }),
      ]);
      state.currentRecording = fresh;
      setTranscript(fresh.transcript, speakerData?.turns || []);
      const speakerDetail = speakerData?.turns?.length
        ? ' · recognised speakers shown'
        : '';
      setStatus('Saved recording', friendlyDate(fresh.created_at) + speakerDetail);
      switchPage('talk');
    } catch (error) {
      setError(error.message);
    }
  }

  async function loadProgress() {
    if (!isAdmin()) return;
    try {
      const [data, recent] = await Promise.all([
        api('/api/progress?days=' + els.progressDays.value, { cache: 'no-store' }),
        api('/api/recordings?limit=20', { cache: 'no-store' }),
      ]);
      renderProgress(data);
      renderProgressRecent(recent);
      els.progressContent.classList.remove('hidden');
    } catch (error) {
      els.progressContent.classList.add('hidden');
      showToast(error.message);
    }
  }

  function renderProgressRecent(records) {
    if (!els.progressRecentList) return;
    els.progressRecentList.replaceChildren();
    if (!records.length) {
      const empty = document.createElement('p');
      empty.className = 'muted';
      empty.textContent = 'No saved conversations yet.';
      els.progressRecentList.appendChild(empty);
      return;
    }
    for (const record of records) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'conversation-list-row';
      const main = document.createElement('span');
      main.className = 'conversation-list-main';
      const title = document.createElement('strong');
      title.textContent = record.title || 'New recording';
      const snippet = document.createElement('span');
      snippet.className = 'muted';
      snippet.textContent = (record.transcript || '').slice(0, 140) + ((record.transcript || '').length > 140 ? '…' : '');
      main.append(title, snippet);
      const meta = document.createElement('span');
      meta.className = 'conversation-list-meta';
      meta.textContent = friendlyDate(record.created_at) + ' · ' + record.word_count + ' words';
      row.append(main, meta);
      row.addEventListener('click', () => openHistoryRecording(record));
      els.progressRecentList.appendChild(row);
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

  async function loadTools() {
    if (!isAdmin()) return;
    await Promise.allSettled([loadAdminStatus(), loadRecycleBin(), loadSpeakerTools(), loadUsers()]);
  }

  async function loadUsers() {
    try {
      const users = await api('/api/admin/users', { cache: 'no-store' });
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
      meta.textContent = '@' + user.username + ' · ' + user.recordings + ' recording' + (user.recordings === 1 ? '' : 's') + (user.is_admin ? ' · admin' : '') + (user.is_active ? '' : ' · inactive');
      main.append(name, meta);

      const display = document.createElement('input');
      display.value = user.display_name;
      display.setAttribute('aria-label', 'Display name for ' + user.username);

      const password = document.createElement('input');
      password.type = 'password';
      password.placeholder = 'New password (optional)';
      password.autocomplete = 'new-password';
      password.setAttribute('aria-label', 'New password for ' + user.username);

      const adminLabel = document.createElement('label');
      adminLabel.className = 'check user-admin-toggle';
      const adminToggle = document.createElement('input');
      adminToggle.type = 'checkbox';
      adminToggle.checked = Boolean(user.is_admin);
      adminToggle.disabled = Boolean(user.is_current && user.is_admin);
      adminLabel.append(adminToggle, document.createTextNode(' Admin'));

      const actions = document.createElement('div'); actions.className = 'button-row';
      const save = document.createElement('button'); save.type = 'button'; save.textContent = 'Save';
      save.addEventListener('click', async () => {
        const body = {
          display_name: display.value.trim(),
          is_admin: adminToggle.checked,
        };
        if (password.value) body.password = password.value;
        try {
          await api('/api/admin/users/' + user.id, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
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
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ is_active: !user.is_active }),
          });
          showToast(user.is_active ? 'User deactivated' : 'User reactivated');
          await loadUsers();
        } catch (error) {
          els.userAdminMessage.textContent = error.message;
        }
      });

      actions.append(save, toggle);
      row.append(main, display, password, adminLabel, actions);
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
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: els.newUsername.value.trim(),
          display_name: els.newUserDisplayName.value.trim(),
          password: els.newUserPassword.value,
          is_admin: Boolean(els.newUserIsAdmin?.checked),
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
    await Promise.allSettled([loadSpeakerStatusAndRecordings(), loadSpeakerProfiles(), loadRelabelSamples()]);
    if (state.currentSpeakerAnalysisId && !state.speakerPolling) {
      pollSpeakerAnalysis(state.currentSpeakerAnalysisId, true);
    }
  }

  async function loadSpeakerStatusAndRecordings() {
    try {
      const [status, recordings] = await Promise.all([
        api('/api/admin/speakers/status', { cache: 'no-store' }),
        api('/api/admin/speakers/recordings', { cache: 'no-store' }),
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
      } else if (service.status === 'device_error') {
        els.speakerServiceStatus.textContent = 'GPU problem';
        els.speakerServiceStatus.className = 'pill speaker-warning';
        els.speakerAnalysisMessage.textContent = service.device_error || 'The selected GPU is not compatible with the speaker analyzer.';
      } else {
        const gpu = Array.isArray(service.gpus)
          ? service.gpus.find((item) => String(service.device || '').endsWith(':' + item.index))
            || service.gpus[0]
          : null;
        const gpuText = gpu?.name ? ' · ' + gpu.name : '';
        const swapText = service.arbitrated ? ' · managed by llama-swap' : '';
        els.speakerServiceStatus.textContent = (service.loaded ? 'Ready' : 'Ready · model loads on first use') + gpuText + swapText;
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
      const profiles = await api('/api/admin/speakers/profiles', { cache: 'no-store' });
      state.speakerProfiles = profiles;
      renderSpeakerProfiles(profiles);
    } catch (error) {
      els.speakerProfilesList.replaceChildren();
      const p = document.createElement('p'); p.className = 'error'; p.textContent = error.message;
      els.speakerProfilesList.appendChild(p);
    }
  }

  async function toggleRememberedSamplePreview(profile, sample, button) {
    const previewKey = 'profile:' + profile.id + ':sample:' + sample.id;
    if (
      state.speakerPreviewKey === previewKey &&
      state.speakerPreviewAudio &&
      !state.speakerPreviewAudio.paused
    ) {
      stopSpeakerPreview();
      return;
    }

    stopSpeakerPreview();
    button.disabled = true;
    button.textContent = 'Loading sample…';

    try {
      const response = await fetch(
        '/api/admin/speakers/profiles/' + profile.id +
        '/samples/' + sample.id + '/sample-audio',
        { cache: 'no-store' },
      );
      if (!response.ok) {
        let detail = 'Could not load this remembered voice sample.';
        try {
          const payload = await response.json();
          detail = payload.detail || detail;
        } catch {}
        throw new Error(detail);
      }

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      state.speakerPreviewAudio = audio;
      state.speakerPreviewUrl = url;
      state.speakerPreviewKey = previewKey;
      state.speakerPreviewButton = button;

      button.disabled = false;
      button.textContent = '■ Stop sample';
      button.setAttribute('aria-pressed', 'true');

      audio.addEventListener('ended', () => {
        if (state.speakerPreviewKey === previewKey) stopSpeakerPreview();
      }, { once: true });
      audio.addEventListener('error', () => {
        if (state.speakerPreviewKey === previewKey) {
          stopSpeakerPreview();
          showToast('Could not play this remembered voice sample');
        }
      }, { once: true });

      await audio.play();
    } catch (error) {
      stopSpeakerPreview();
      showToast(error.message);
    }
  }

  function renderSpeakerProfiles(profiles) {
    stopSpeakerPreview();
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
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name }),
        });
        showToast('Speaker name saved');
        await loadSpeakerProfiles();
        if (state.currentSpeakerAnalysisId) await refreshCurrentSpeakerAnalysis();
      });

      const forget = document.createElement('button'); forget.type = 'button'; forget.className = 'danger'; forget.textContent = 'Forget voiceprint';
      forget.addEventListener('click', async () => {
        if (!confirm('Forget the saved voiceprint for ' + profile.name + '? Past conversation labels will stay.')) return;
        await api('/api/admin/speakers/profiles/' + profile.id, { method: 'DELETE' });
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

        const sampleActions = document.createElement('div');
        sampleActions.className = 'voice-sample-actions';

        const preview = document.createElement('button');
        preview.type = 'button';
        preview.className = 'speaker-preview-button voice-sample-preview';
        const previewSeconds = Number(sample.preview_seconds || 0);
        preview.dataset.idleLabel = previewSeconds
          ? ('▶ Hear · ' + previewSeconds.toFixed(1) + 's')
          : '▶ Hear';
        preview.textContent = preview.dataset.idleLabel;
        preview.disabled = !sample.can_preview;
        preview.title = sample.can_preview
          ? 'Play this remembered voice sample'
          : (sample.source_recording_title === 'Shared voice sample'
              ? 'This sample came from another user; its source audio stays private.'
              : 'The source audio for this sample is not available.');
        preview.setAttribute('aria-pressed', 'false');
        preview.addEventListener('click', () => toggleRememberedSamplePreview(profile, sample, preview));

        const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'danger small'; remove.textContent = 'Remove sample';
        remove.disabled = profile.sample_count <= 1;
        remove.title = profile.sample_count <= 1 ? 'Use Forget voiceprint to remove the final sample.' : 'Remove this sample from future matching';
        remove.addEventListener('click', async () => {
          if (!confirm('Remove this voice sample from ' + profile.name + '?')) return;
          try {
            stopSpeakerPreview();
            await api('/api/admin/speakers/profiles/' + profile.id + '/samples/' + sample.id, {
              method: 'DELETE', });
            showToast('Voice sample removed');
            await loadSpeakerProfiles();
            if (state.currentSpeakerAnalysisId) await refreshCurrentSpeakerAnalysis();
          } catch (error) {
            showToast(error.message);
          }
        });

        sampleActions.append(preview, remove);
        sampleRow.append(info, sampleActions);
        list.appendChild(sampleRow);
      }
      samples.appendChild(list);

      row.append(input, meta, save, forget, samples);
      els.speakerProfilesList.appendChild(row);
    }
  }

  function identityPayload(value, scope) {
    const payload = { scope };
    if (value === 'clear') payload.clear = true;
    else if (value === 'unknown') payload.unknown = true;
    else if (value.startsWith('profile:')) payload.target_profile_id = value.slice(8);
    else if (value.startsWith('detection:')) payload.target_detection_id = value.slice(10);
    return payload;
  }

  async function applyTurnIdentityCorrection(analysis, turn, value, scope) {
    try {
      const updated = await api(
        '/api/admin/speakers/analyses/' + analysis.id + '/turns/' + turn.id + '/identity',
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(identityPayload(value, scope)),
        },
      );
      renderSpeakerAnalysis(updated);
      await loadRelabelSamples();
      showToast(scope === 'detection' ? 'Speaker identity corrected for matching turns' : 'Speaker identity corrected');
    } catch (error) {
      showToast(error.message);
    }
  }

  async function toggleRelabelSamplePreview(sample, button) {
    const previewKey = 'relabel:' + sample.id;
    if (
      state.speakerPreviewKey === previewKey &&
      state.speakerPreviewAudio &&
      !state.speakerPreviewAudio.paused
    ) {
      stopSpeakerPreview();
      return;
    }

    stopSpeakerPreview();
    button.disabled = true;
    button.textContent = 'Loading sample…';
    try {
      const response = await fetch(
        '/api/admin/speakers/relabels/' + sample.id + '/sample-audio',
        { cache: 'no-store' },
      );
      if (!response.ok) {
        let detail = 'Could not load this relabelled voice sample.';
        try {
          const payload = await response.json();
          detail = payload.detail || detail;
        } catch {}
        throw new Error(detail);
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      state.speakerPreviewAudio = audio;
      state.speakerPreviewUrl = url;
      state.speakerPreviewKey = previewKey;
      state.speakerPreviewButton = button;
      button.disabled = false;
      button.textContent = '■ Stop sample';
      button.setAttribute('aria-pressed', 'true');
      audio.addEventListener('ended', () => {
        if (state.speakerPreviewKey === previewKey) stopSpeakerPreview();
      }, { once: true });
      audio.addEventListener('error', () => {
        if (state.speakerPreviewKey === previewKey) {
          stopSpeakerPreview();
          showToast('Could not play this relabelled voice sample');
        }
      }, { once: true });
      await audio.play();
    } catch (error) {
      stopSpeakerPreview();
      showToast(error.message);
    }
  }

  async function loadRelabelSamples() {
    if (!els.relabelSamplesList) return;
    try {
      const samples = await api('/api/admin/speakers/relabels', { cache: 'no-store' });
      renderRelabelSamples(samples);
    } catch (error) {
      els.relabelSamplesList.replaceChildren();
      const p = document.createElement('p'); p.className = 'error'; p.textContent = error.message;
      els.relabelSamplesList.appendChild(p);
    }
  }

  function renderRelabelSamples(samples) {
    stopSpeakerPreview();
    els.relabelSamplesList.replaceChildren();
    if (!samples.length) {
      const p = document.createElement('p'); p.className = 'muted';
      p.textContent = 'No manually relabelled voice samples yet.';
      els.relabelSamplesList.appendChild(p);
      return;
    }

    for (const sample of samples) {
      const row = document.createElement('div'); row.className = 'relabel-sample-row';
      const info = document.createElement('div'); info.className = 'relabel-sample-info';
      const title = document.createElement('strong');
      title.textContent = sample.original_display_name + ' → ' + sample.corrected_display_name;
      const detail = document.createElement('span'); detail.className = 'muted';
      detail.textContent =
        (sample.recording_title || 'Recording') + ' · ' +
        formatTime(sample.start_seconds) + ' · ' +
        friendlyDate(sample.created_at);
      const status = document.createElement('span');
      status.className = 'speaker-match ' + (sample.status === 'approved' ? 'matched' : '');
      status.textContent = sample.status === 'approved'
        ? 'Approved for training'
        : sample.status === 'excluded'
          ? 'Excluded'
          : 'Needs review';
      info.append(title, detail, status);

      const actions = document.createElement('div'); actions.className = 'voice-sample-actions';
      const hear = document.createElement('button'); hear.type = 'button'; hear.className = 'speaker-preview-button';
      hear.dataset.idleLabel = '▶ Hear · ' + Number(sample.preview_seconds || 0).toFixed(1) + 's';
      hear.textContent = hear.dataset.idleLabel;
      hear.disabled = !sample.can_preview;
      hear.setAttribute('aria-pressed', 'false');
      hear.addEventListener('click', () => toggleRelabelSamplePreview(sample, hear));

      const approve = document.createElement('button'); approve.type = 'button'; approve.className = 'primary';
      approve.textContent = 'Approve for training';
      approve.disabled = !sample.training_ready || sample.status === 'approved';
      approve.title = sample.training_ready
        ? 'Mark this corrected sample as ready for a future retraining pass'
        : 'Assign this turn to a remembered speaker before approving it for training.';
      approve.addEventListener('click', async () => {
        await api('/api/admin/speakers/relabels/' + sample.id, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'approved' }),
        });
        await loadRelabelSamples();
      });

      const exclude = document.createElement('button'); exclude.type = 'button';
      exclude.textContent = sample.status === 'excluded' ? 'Excluded' : 'Exclude';
      exclude.disabled = sample.status === 'excluded';
      exclude.addEventListener('click', async () => {
        await api('/api/admin/speakers/relabels/' + sample.id, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'excluded' }),
        });
        await loadRelabelSamples();
      });

      const undo = document.createElement('button'); undo.type = 'button'; undo.className = 'danger';
      undo.textContent = 'Undo correction';
      undo.addEventListener('click', async () => {
        if (!confirm('Undo this speaker correction and restore the original detected identity?')) return;
        await api('/api/admin/speakers/relabels/' + sample.id + '/correction', {
          method: 'DELETE',
          });
        await loadRelabelSamples();
        if (state.currentSpeakerAnalysisId) await refreshCurrentSpeakerAnalysis();
      });

      actions.append(hear, approve, exclude, undo);
      row.append(info, actions);
      els.relabelSamplesList.appendChild(row);
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
        headers: { 'Content-Type': 'application/json' },
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
        const analysis = await api('/api/admin/speakers/analyses/' + analysisId, { cache: 'no-store' });
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
      const analysis = await api('/api/admin/speakers/analyses/' + state.currentSpeakerAnalysisId, { cache: 'no-store' });
      if (analysis.status === 'completed') renderSpeakerAnalysis(analysis);
    } catch {}
  }

  function stopSpeakerPreview() {
    if (state.speakerPreviewAudio) {
      try { state.speakerPreviewAudio.pause(); } catch {}
    }
    if (state.speakerPreviewUrl) URL.revokeObjectURL(state.speakerPreviewUrl);
    if (state.speakerPreviewButton) {
      state.speakerPreviewButton.textContent = state.speakerPreviewButton.dataset.idleLabel || '▶ Hear sample';
      state.speakerPreviewButton.setAttribute('aria-pressed', 'false');
      state.speakerPreviewButton.disabled = false;
    }
    state.speakerPreviewAudio = null;
    state.speakerPreviewUrl = null;
    state.speakerPreviewKey = null;
    state.speakerPreviewButton = null;
  }

  async function toggleSpeakerPreview(analysis, detection, button) {
    const previewKey = analysis.id + ':' + detection.speaker_key;
    if (
      state.speakerPreviewKey === previewKey &&
      state.speakerPreviewAudio &&
      !state.speakerPreviewAudio.paused
    ) {
      stopSpeakerPreview();
      return;
    }

    stopSpeakerPreview();
    button.disabled = true;
    button.textContent = 'Loading sample…';

    try {
      const response = await fetch(
        '/api/admin/speakers/analyses/' + analysis.id +
        '/detections/' + encodeURIComponent(detection.speaker_key) + '/sample-audio',
        { cache: 'no-store' },
      );
      if (!response.ok) {
        let detail = 'Could not load this voice sample.';
        try {
          const payload = await response.json();
          detail = payload.detail || detail;
        } catch {}
        throw new Error(detail);
      }

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      state.speakerPreviewAudio = audio;
      state.speakerPreviewUrl = url;
      state.speakerPreviewKey = previewKey;
      state.speakerPreviewButton = button;

      button.disabled = false;
      button.textContent = '■ Stop sample';
      button.setAttribute('aria-pressed', 'true');

      audio.addEventListener('ended', () => {
        if (state.speakerPreviewKey === previewKey) stopSpeakerPreview();
      }, { once: true });
      audio.addEventListener('error', () => {
        if (state.speakerPreviewKey === previewKey) {
          stopSpeakerPreview();
          showToast('Could not play this voice sample');
        }
      }, { once: true });

      await audio.play();
    } catch (error) {
      stopSpeakerPreview();
      showToast(error.message);
    }
  }

  function renderSpeakerAnalysis(analysis) {
    stopSpeakerPreview();
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

      const preview = document.createElement('button');
      preview.type = 'button';
      preview.className = 'speaker-preview-button';
      const previewSeconds = Number(detection.preview_seconds || 0);
      preview.dataset.idleLabel = previewSeconds
        ? ('▶ Hear sample · ' + previewSeconds.toFixed(1) + 's')
        : '▶ Hear sample';
      preview.textContent = preview.dataset.idleLabel;
      preview.disabled = !detection.can_preview;
      preview.title = detection.can_preview
        ? 'Play the longest continuous section attributed to this speaker'
        : 'No playable attributed speech is available for this speaker.';
      preview.setAttribute('aria-pressed', 'false');
      preview.addEventListener('click', () => toggleSpeakerPreview(analysis, detection, preview));

      const actions = document.createElement('div'); actions.className = 'button-row speaker-label-actions';
      const save = document.createElement('button'); save.type = 'button'; save.textContent = 'Save tag';
      save.addEventListener('click', async () => {
        const name = input.value.trim();
        if (!name) return;
        await api('/api/admin/speakers/analyses/' + analysis.id + '/detections/' + encodeURIComponent(detection.speaker_key), {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
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
            headers: { 'Content-Type': 'application/json' },
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
      card.append(top, input, speechInfo, preview, actions);
      speakerGrid.appendChild(card);
    }

    const transcriptHeading = document.createElement('h4'); transcriptHeading.textContent = 'Conversation';
    const conversation = document.createElement('div'); conversation.className = 'speaker-conversation';
    for (const turn of analysis.turns) {
      if (!turn.text) continue;
      const row = document.createElement('div'); row.className = 'speaker-turn';
      if (turn.identity_corrected) row.classList.add('identity-corrected');
      const meta = document.createElement('div'); meta.className = 'speaker-turn-meta';
      const who = document.createElement('strong'); who.textContent = turn.display_name;
      const when = document.createElement('span'); when.className = 'muted'; when.textContent = formatTime(turn.start_seconds);
      meta.append(who, when);
      const text = document.createElement('p'); text.textContent = turn.text;

      const correction = document.createElement('div'); correction.className = 'speaker-identity-correction';
      const select = document.createElement('select');
      select.setAttribute('aria-label', 'Correct speaker identity');
      const detectedOption = document.createElement('option');
      detectedOption.value = 'clear';
      detectedOption.textContent = 'Detected: ' + (turn.detected_display_name || 'Speaker');
      select.appendChild(detectedOption);
      const unknownOption = document.createElement('option');
      unknownOption.value = 'unknown'; unknownOption.textContent = 'Unknown speaker';
      select.appendChild(unknownOption);

      for (const detection of analysis.detections) {
        if (detection.id === turn.detection_id) continue;
        const option = document.createElement('option');
        option.value = 'detection:' + detection.id;
        option.textContent = 'Detected speaker: ' + detection.display_name;
        select.appendChild(option);
      }
      for (const profile of state.speakerProfiles || []) {
        const option = document.createElement('option');
        option.value = 'profile:' + profile.id;
        option.textContent = 'Remembered: ' + profile.name;
        select.appendChild(option);
      }

      if (turn.identity_override_unknown) select.value = 'unknown';
      else if (turn.identity_override_profile_id) select.value = 'profile:' + turn.identity_override_profile_id;
      else if (turn.identity_override_detection_id) select.value = 'detection:' + turn.identity_override_detection_id;
      else select.value = 'clear';

      const applyTurn = document.createElement('button'); applyTurn.type = 'button';
      applyTurn.textContent = 'Apply to this turn';
      applyTurn.addEventListener('click', () => applyTurnIdentityCorrection(analysis, turn, select.value, 'turn'));

      const applySpeaker = document.createElement('button'); applySpeaker.type = 'button';
      applySpeaker.textContent = 'Apply to all ' + (turn.detected_display_name || 'matching turns');
      applySpeaker.title = 'Apply this correction to every turn from the same original diarized speaker';
      applySpeaker.addEventListener('click', () => applyTurnIdentityCorrection(analysis, turn, select.value, 'detection'));

      const correctedNote = document.createElement('span'); correctedNote.className = 'muted small-note';
      correctedNote.textContent = turn.identity_corrected
        ? 'Manually corrected; original detection retained.'
        : 'Original detected identity.';

      correction.append(select, applyTurn, applySpeaker, correctedNote);
      row.append(meta, text, correction); conversation.appendChild(row);
    }
    if (!conversation.children.length) {
      const p = document.createElement('p'); p.className = 'muted'; p.textContent = 'No spoken turns were transcribed.';
      conversation.appendChild(p);
    }

    els.speakerAnalysisResult.append(speakerHeading, speakerGrid, transcriptHeading, conversation);
  }

  async function loadAdminStatus() {
    const status = await api('/api/admin/status', { cache: 'no-store' });
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
        headers: { 'Content-Type': 'application/json' },
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
      const result = await api('/api/admin/retention/apply', { method: 'POST' });
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
      const records = await api('/api/admin/recycle-bin', { cache: 'no-store' });
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
          await api('/api/admin/recycle-bin/' + record.id + '/restore', { method: 'POST' });
          await Promise.all([loadRecycleBin(), loadAdminStatus()]);
        } catch (error) { alert(error.message); }
      });
      const remove = document.createElement('button'); remove.className = 'danger'; remove.textContent = 'Permanently delete';
      remove.addEventListener('click', async () => {
        if (!confirm('Permanently delete this recording, transcript history and any saved voice audio? This cannot be undone.')) return;
        try {
          await api('/api/admin/recycle-bin/' + record.id, { method: 'DELETE' });
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
      const response = await fetch('/api/admin/backup');
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

  els.menuButton?.addEventListener('click', openDrawer);
  els.closeMenuButton?.addEventListener('click', () => closeDrawer({ restoreFocus: true }));
  els.drawerBackdrop?.addEventListener('click', () => closeDrawer({ restoreFocus: true }));
  document.querySelectorAll('.drawer-page-link').forEach((button) => {
    button.addEventListener('click', () => {
      if (state.recording || state.transcribing) {
        showToast('Finish this recording before changing page');
        closeDrawer({ restoreFocus: true });
        return;
      }
      const page = button.dataset.drawerPage;
      if (page) switchPage(page);
    });
  });

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
  els.playRecordingButton.addEventListener('click', () => playRecording());
  els.playbackToggleButton?.addEventListener('click', () => playRecording());
  els.playbackBackButton?.addEventListener('click', () => seekPlaybackBy(-5));
  els.playbackForwardButton?.addEventListener('click', () => seekPlaybackBy(5));
  els.playbackRate?.addEventListener('change', () => {
    const rate = Number(els.playbackRate.value || 1);
    localStorage.setItem('playbackRate', String(rate));
    if (state.currentAudioKind === 'recording' && state.currentAudio) {
      state.currentAudio.playbackRate = rate;
    }
  });
  els.playbackFollowButton?.addEventListener('click', () => {
    state.playbackFollow = true;
    updatePlaybackFollowButton();
    updatePlaybackFromAudio();
    const target = state.playbackActiveTurnId
      ? els.transcriptView.querySelector('[data-turn-id="' + state.playbackActiveTurnId + '"]')
      : null;
    if (target) {
      state.programmaticScrollAt = Date.now();
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  });
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
  els.saveRecordingTitleButton.addEventListener('click', saveRecordingTitle);
  els.recordingTitleInput.addEventListener('input', () => {
    els.recordingTitleStatus.textContent = 'Unsaved';
  });
  els.recordingTitleInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      saveRecordingTitle();
    } else if (event.key === 'Escape') {
      els.recordingTitleInput.value = state.currentRecording?.title || '';
      els.recordingTitleStatus.textContent = '';
      els.recordingTitleInput.blur();
    }
  });
  els.progressDays.addEventListener('change', () => { if (isAdmin()) loadProgress(); });
  els.runSpeakerAnalysisButton.addEventListener('click', runSpeakerAnalysis);
  els.refreshSpeakerProfilesButton.addEventListener('click', loadSpeakerProfiles);
  els.refreshRelabelSamplesButton?.addEventListener('click', loadRelabelSamples);
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
  const savedCaptureSource = localStorage.getItem('captureSource');
  if (savedCaptureSource && [...els.captureSource.options].some((option) => option.value === savedCaptureSource)) {
    els.captureSource.value = savedCaptureSource;
  }
  const savedPlaybackRate = localStorage.getItem('playbackRate');
  if (savedPlaybackRate && els.playbackRate && [...els.playbackRate.options].some((option) => option.value === savedPlaybackRate)) {
    els.playbackRate.value = savedPlaybackRate;
  }
  updateCaptureSourceUI();

  els.transcriptView?.addEventListener('scroll', () => {
    const manualScroll = Date.now() - state.programmaticScrollAt > 700;
    if (!manualScroll) return;
    if (state.recording) {
      state.autoFollow = false;
      updateFollowButton();
    }
    if (
      state.currentAudioKind === 'recording' &&
      state.currentAudio &&
      !state.currentAudio.paused
    ) {
      pausePlaybackFollowing();
    }
  }, { passive: true });

  window.addEventListener('scroll', () => {
    const current = window.scrollY;
    const manualScroll = Date.now() - state.programmaticScrollAt > 700 && Math.abs(current - state.lastScrollY) > 10;
    if (state.recording && manualScroll && current < state.lastScrollY) {
      state.autoFollow = false;
      updateFollowButton();
    }
    if (
      manualScroll &&
      state.currentAudioKind === 'recording' &&
      state.currentAudio &&
      !state.currentAudio.paused
    ) {
      pausePlaybackFollowing();
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
    if (event.key !== 'Escape') return;
    if (document.body.classList.contains('reading-focus')) {
      exitReadingFocus();
      return;
    }
    if (els.appDrawer?.classList.contains('open')) closeDrawer({ restoreFocus: true });
  });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }

  renderTranscript();
  syncRecordingUI();
  bootstrapAuth();

})();
