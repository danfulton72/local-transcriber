(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  // Whisper and pyannote both work at 16 kHz mono; capturing at the browser's
  // native 44.1/48 kHz only triples upload size, disk use and memory.
  const CAPTURE_SAMPLE_RATE = 16000;
  // Full-quality audio is uploaded in segments while recording so a long
  // session never has to be held (or re-encoded) in the tab all at once.
  const AUDIO_SEGMENT_SECONDS = 60;
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
    sampleRate: CAPTURE_SAMPLE_RATE,
    stopping: false,
    segmentBuffers: [],
    segmentSampleCount: 0,
    segmentIndex: 0,
    segmentQueue: [],
    segmentUploading: false,
    segmentUploadError: null,
    segmentDrainResolvers: [],
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
    health: null,
    liveTranscribedUpTo: 0,
    pausedAt: 0,
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
    speakerPolling: false,
    relabelView: 'pending',
    meetingNotesStatus: null,
    toolsTab: null,
    toolsHealth: {},
    voicesExpanded: new Set(),
    meetings: {
      recordings: [], filter: 'todo', selectedId: null, analysis: null, notes: null,
      analysingId: null, analysisStage: '', analysisError: '', showTurns: false,
      notesPolling: null, jobKind: null,
    },
    speakerTurns: [],
    speakerProfiles: [],
    knownSpeakerProfiles: [],
    speakerPreviewAudio: null,
    speakerPreviewUrl: null,
    speakerPreviewKey: null,
    speakerPreviewButton: null,
    authUser: null,
    actingAs: null,
  };

  const els = {
    loginScreen: $('loginScreen'), loginForm: $('loginForm'), loginUsername: $('loginUsername'), loginPassword: $('loginPassword'),
    loginButton: $('loginButton'), loginMessage: $('loginMessage'), currentUserLabel: $('currentUserLabel'), logoutButton: $('logoutButton'),
    healthBadge: $('healthBadge'), menuButton: $('menuButton'), closeMenuButton: $('closeMenuButton'),
    actAsControl: $('actAsControl'), actAsSelect: $('actAsSelect'), actAsBanner: $('actAsBanner'),
    actAsName: $('actAsName'), actAsDetail: $('actAsDetail'), stopActAsButton: $('stopActAsButton'),
    appDrawer: $('appDrawer'), drawerBackdrop: $('drawerBackdrop'),
    recordButton: $('recordButton'), recordButtonIcon: $('recordButtonIcon'), recordButtonText: $('recordButtonText'), meter: $('meter'),
    statusText: $('statusText'), statusDetail: $('statusDetail'), timer: $('timer'), pauseButton: $('pauseButton'),
    errorBox: $('errorBox'), transcriptView: $('transcriptView'), wordCount: $('wordCount'),
    recordingTitleRow: $('recordingTitleRow'), recordingTitleInput: $('recordingTitleInput'),
    saveRecordingTitleButton: $('saveRecordingTitleButton'), recordingTitleStatus: $('recordingTitleStatus'),
    editorWrap: $('editorWrap'), sentenceEditor: $('sentenceEditor'), editSaveStatus: $('editSaveStatus'), saveEditButton: $('saveEditButton'), cancelEditButton: $('cancelEditButton'),
    hearButton: $('hearButton'), focusButton: $('focusButton'), focusExitButton: $('focusExitButton'), useWordsButton: $('useWordsButton'),
    playRecordingButton: $('playRecordingButton'), editButton: $('editButton'), favouriteButton: $('favouriteButton'), newButton: $('newButton'), keepTalkingButton: $('keepTalkingButton'),
    talkDock: $('talkDock'), lagChip: $('lagChip'), moreActions: $('moreActions'), cardActions: $('cardActions'), dockActions: $('dockActions'),
    topbarActions: $('topbarActions'), drawerViewAsSlot: $('drawerViewAsSlot'), drawerSignedIn: $('drawerSignedIn'),
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
    recycleList: $('recycleList'), backupNotice: $('backupNotice'), systemHealthTiles: $('systemHealthTiles'),
    toolsHealthList: $('toolsHealthList'), toolsRefreshButton: $('toolsRefreshButton'),
    meetingsSearch: $('meetingsSearch'), meetingsList: $('meetingsList'),
    meetingDetailTitle: $('meetingDetailTitle'), meetingDetailMeta: $('meetingDetailMeta'), meetingSteps: $('meetingSteps'),
    stepSpeakersChip: $('stepSpeakersChip'), stepSpeakersBody: $('stepSpeakersBody'), stepSpeakersFoot: $('stepSpeakersFoot'),
    stepNotesChip: $('stepNotesChip'), stepNotesHint: $('stepNotesHint'), meetingNotesEmpty: $('meetingNotesEmpty'),
    meetingNotesModel: $('meetingNotesModel'), stepNotebookChip: $('stepNotebookChip'), stepNotebookFoot: $('stepNotebookFoot'),
    meetingTurns: $('meetingTurns'), meetingTurnsCloseButton: $('meetingTurnsCloseButton'),
    speakerAnalysisResult: $('speakerAnalysisResult'),
    speakerProfilesList: $('speakerProfilesList'), voicesSearch: $('voicesSearch'),
    relabelSamplesList: $('relabelSamplesList'),
    relabelPendingViewButton: $('relabelPendingViewButton'), relabelHistoryViewButton: $('relabelHistoryViewButton'),
    relabelHistoryFilters: $('relabelHistoryFilters'), relabelFromDate: $('relabelFromDate'),
    relabelToDate: $('relabelToDate'), relabelStatusFilter: $('relabelStatusFilter'),
    relabelClearFiltersButton: $('relabelClearFiltersButton'), relabelSamplesSummary: $('relabelSamplesSummary'),
    notebookPickerDialog: $('notebookPickerDialog'), notebookPickerForm: $('notebookPickerForm'),
    notebookPickerMessage: $('notebookPickerMessage'), notebookPickerList: $('notebookPickerList'),
    notebookPickerRefreshButton: $('notebookPickerRefreshButton'), notebookPickerConfirmButton: $('notebookPickerConfirmButton'),
    meetingNotesGenerateButton: $('meetingNotesGenerateButton'),
    meetingNotesResendButton: $('meetingNotesResendButton'), meetingNotesDownloadButton: $('meetingNotesDownloadButton'),
    meetingNotesMessage: $('meetingNotesMessage'), meetingNotesPreview: $('meetingNotesPreview'),
    meetingNotesLinkRow: $('meetingNotesLinkRow'), meetingNotesLink: $('meetingNotesLink'),
    meetingNotesExportBadgeText: $('meetingNotesExportBadgeText'),
    userList: $('userList'), createUserForm: $('createUserForm'),
    addUserToggleButton: $('addUserToggleButton'), cancelCreateUserButton: $('cancelCreateUserButton'),
    newUsername: $('newUsername'), newUserDisplayName: $('newUserDisplayName'), newUserPassword: $('newUserPassword'), newUserIsAdmin: $('newUserIsAdmin'),
    createUserButton: $('createUserButton'), userAdminMessage: $('userAdminMessage'),
  };

  function effectiveUser() {
    return state.actingAs || state.authUser;
  }

  function userStorageKey(name) {
    return 'user:' + (effectiveUser()?.id || 'anonymous') + ':' + name;
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

  function isActingAs() {
    return Boolean(state.actingAs?.id);
  }

  function applyActAsUI() {
    const acting = isActingAs();
    document.body.classList.toggle('acting-as-user', acting);
    els.actAsBanner?.classList.toggle('hidden', !acting);
    if (els.actAsName) els.actAsName.textContent = acting ? (state.actingAs.display_name || state.actingAs.username) : '';
    if (els.actAsDetail) {
      els.actAsDetail.textContent = acting
        ? 'Signed in as ' + (state.authUser?.display_name || state.authUser?.username || 'admin') + '. You can review and correct saved work; new recording and deletion are disabled.'
        : '';
    }
    if (els.actAsSelect) els.actAsSelect.value = acting ? state.actingAs.id : '';
    if (els.currentUserLabel && state.authUser) {
      els.currentUserLabel.textContent = (state.authUser.display_name || state.authUser.username) + (state.authUser.is_admin ? ' · Admin' : '');
    }
    if (els.drawerSignedIn && state.authUser) {
      els.drawerSignedIn.textContent = 'Signed in as ' + (state.authUser.display_name || state.authUser.username) + (state.authUser.is_admin ? ' · Grown-up' : '');
    }
  }

  // Phones get View as in the menu (it does not fit the header), and wide
  // screens show the word actions in the recording dock rather than the card.
  const phoneLayout = window.matchMedia('(max-width: 700px)');
  const wideLayout = window.matchMedia('(min-width: 1180px)');
  function placeResponsiveControls() {
    if (els.actAsControl && els.drawerViewAsSlot && els.topbarActions) {
      if (phoneLayout.matches) {
        if (els.actAsControl.parentElement !== els.drawerViewAsSlot) els.drawerViewAsSlot.appendChild(els.actAsControl);
      } else if (els.actAsControl.parentElement !== els.topbarActions) {
        els.topbarActions.insertBefore(els.actAsControl, els.topbarActions.firstChild);
      }
    }
    const quickActions = document.querySelector('.quick-actions');
    const host = wideLayout.matches ? els.dockActions : els.cardActions;
    if (quickActions && host && quickActions.parentElement !== host) host.appendChild(quickActions);
  }
  placeResponsiveControls();
  phoneLayout.addEventListener?.('change', placeResponsiveControls);
  wideLayout.addEventListener?.('change', placeResponsiveControls);

  function applyRoleVisibility() {
    const allowed = isAdmin();
    document.body.classList.toggle('admin-user', allowed);
    document.querySelectorAll('.admin-only').forEach((node) => {
      node.hidden = !allowed;
    });
    const activeAdminPage = document.querySelector('.page.active.admin-page');
    if (!allowed && activeAdminPage) switchPage('talk');
    applyActAsUI();
  }

  function showLoggedOut(message = '') {
    closeDrawer();
    state.authUser = null;
    state.actingAs = null;
    state.currentRecording = null;
    state.recoverableRecording = null;
    state.meetings.selectedId = null;
    state.meetings.analysis = null;
    state.meetings.notes = null;
    state.toolsTab = null;
    document.body.classList.add('logged-out');
    els.currentUserLabel.textContent = '';
    els.loginMessage.textContent = message;
    els.loginMessage.classList.toggle('hidden', !message);
    els.loginPassword.value = '';
    applyRoleVisibility();
    setTimeout(() => els.loginUsername.focus(), 0);
  }

  function showLoggedIn(user, actingAs = null) {
    state.authUser = user;
    state.actingAs = actingAs;
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
      showLoggedIn(payload.user, payload.acting_as || null);
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
    const tasks = [checkHealth(), loadVoices(), loadKnownSpeakerProfiles()];
    if (isAdmin()) tasks.push(loadActAsOptions());
    await Promise.allSettled(tasks);
    renderTranscript();
    syncRecordingUI();
    if (isActingAs()) {
      state.recoverableRecording = null;
      els.recoveryBanner.classList.add('hidden');
    } else {
      await checkRecoverable();
    }
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
      showLoggedIn(payload.user, payload.acting_as || null);
      await startAuthenticatedApp();
    } catch {
      showLoggedOut('Could not check sign-in status.');
    }
  }

  function renderActAsOptions(users) {
    if (!els.actAsSelect) return;
    const selected = isActingAs() ? state.actingAs.id : '';
    els.actAsSelect.replaceChildren();
    const own = document.createElement('option');
    own.value = '';
    own.textContent = 'My account';
    els.actAsSelect.appendChild(own);
    for (const user of users || []) {
      if (!user.is_active || user.is_admin || user.is_current) continue;
      const option = document.createElement('option');
      option.value = user.id;
      option.textContent = user.display_name + ' (@' + user.username + ')';
      els.actAsSelect.appendChild(option);
    }
    els.actAsSelect.value = selected;
  }

  async function loadActAsOptions() {
    if (!isAdmin()) return [];
    const users = await api('/api/admin/users', { cache: 'no-store' });
    renderActAsOptions(users);
    return users;
  }

  async function switchActAs(userId = '') {
    if (!isAdmin()) return;
    stopSpeech();
    closeEditor();
    state.currentRecording = null;
    state.recoverableRecording = null;
    state.speakerTurns = [];
    setTranscript('');
    els.recoveryBanner.classList.add('hidden');
    try {
      const payload = userId
        ? await api('/api/admin/act-as/' + userId, { method: 'POST' })
        : await api('/api/admin/act-as', { method: 'DELETE' });
      showLoggedIn(payload.user, payload.acting_as || null);
      await startAuthenticatedApp();
      switchPage(payload.acting_as ? 'history' : 'talk');
      showToast(payload.acting_as
        ? 'Now acting as ' + (payload.acting_as.display_name || payload.acting_as.username)
        : 'Returned to your account');
    } catch (error) {
      await loadActAsOptions().catch(() => {});
      setError(error.message);
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
    const count = wordCount(text);
    els.wordCount.textContent = count + ' word' + (count === 1 ? '' : 's');

    // While recording, each chunk only appends text, so update the DOM in
    // place instead of rebuilding every sentence button on every chunk.
    const liveRender = liveMode && !labelledTurns.length && Boolean(text);
    if (liveRender && els.transcriptView.dataset.renderMode === 'live') {
      renderLiveTranscriptIncremental(confirmed, pending);
      updateTranscriptControls(text);
      return;
    }

    els.transcriptView.replaceChildren();
    els.transcriptView.dataset.renderMode = liveRender ? 'live' : 'full';
    els.transcriptView.classList.toggle('speaker-labelled', labelledTurns.length > 0);

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
            } else if (turn.identity_corrected && turn.display_name && turn.display_name !== 'Unknown') {
              nameSelect.value = 'new';
              nameInput.value = turn.display_name;
              nameInput.classList.remove('hidden');
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
          els.transcriptView.appendChild(sentenceButton(sentence));
        }
      }
      if (pending) els.transcriptView.appendChild(livePreview(pending));
    }

    updateTranscriptControls(text);
  }

  function sentenceButton(sentence) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'sentence';
    button.dataset.sentence = sentence;
    button.textContent = sentence + ' ';
    button.title = 'Tap to hear this sentence';
    button.addEventListener('click', () => speakText(sentence));
    return button;
  }

  function livePreview(pending) {
    const preview = document.createElement('span');
    preview.className = 'live-preview';
    preview.textContent = pending;
    preview.setAttribute('aria-label', 'Latest words still being checked');
    return preview;
  }

  function renderLiveTranscriptIncremental(confirmed, pending) {
    const view = els.transcriptView;
    const sentences = confirmed ? splitSentences(confirmed) : [];
    const buttons = [...view.querySelectorAll(':scope > button.sentence')];
    let keep = 0;
    while (keep < buttons.length && keep < sentences.length && buttons[keep].dataset.sentence === sentences[keep]) {
      keep += 1;
    }
    for (let i = keep; i < buttons.length; i += 1) buttons[i].remove();

    let preview = view.querySelector(':scope > .live-preview');
    const fragment = document.createDocumentFragment();
    for (let i = keep; i < sentences.length; i += 1) fragment.appendChild(sentenceButton(sentences[i]));
    view.insertBefore(fragment, preview);

    if (pending) {
      if (!preview) view.appendChild(livePreview(pending));
      else if (preview.textContent !== pending) preview.textContent = pending;
    } else if (preview) {
      preview.remove();
    }
  }

  function updateTranscriptControls(text) {
    const hasText = Boolean(text);
    const canContinue = Boolean(state.currentRecording && hasText && !state.recording && !state.transcribing);
    els.hearButton.disabled = !hasText;
    els.focusButton.disabled = !hasText;
    els.editButton.disabled = !hasText || state.recording || !state.currentRecording;
    els.useWordsButton.disabled = !hasText;
    els.playRecordingButton.disabled = !state.currentRecording?.has_audio;
    els.favouriteButton.disabled = !state.currentRecording;
    els.keepTalkingButton.classList.toggle('hidden', !canContinue);
    els.talkDock?.classList.toggle('can-continue', canContinue);
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

  function renderHealthBadge() {
    if (!els.healthBadge) return;
    let kind = 'checking';
    let text = 'Checking…';
    if (state.recording) {
      kind = 'recording';
      text = 'Recording';
    } else if (state.health === 'online') {
      kind = 'online';
      text = 'Speech ready';
    } else if (state.health === 'degraded') {
      kind = 'degraded';
      text = 'Needs attention';
    } else if (state.health === 'offline') {
      kind = 'degraded';
      text = 'Offline';
    }
    els.healthBadge.className = 'health ' + kind;
    if (els.healthBadge.textContent !== text) els.healthBadge.textContent = text;
  }

  async function checkHealth() {
    try {
      const data = await api('/healthz', { cache: 'no-store' });
      state.health = data.database && data.speech_gateway ? 'online' : 'degraded';
    } catch {
      state.health = 'offline';
    }
    renderHealthBadge();
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
    state.liveTranscribedUpTo = state.startedAt;
    state.timer = setInterval(() => {
      els.timer.textContent = formatTime((Date.now() - state.startedAt) / 1000);
      updateLagChip();
    }, 250);
    updateLagChip();
  }

  // How far the written words trail the speaker: time since the end of the
  // audio in the most recently transcribed chunk. Shown only while recording.
  function updateLagChip() {
    if (!els.lagChip) return;
    const show = state.recording && !state.paused;
    els.lagChip.classList.toggle('hidden', !show);
    if (!show) return;
    const behind = Math.max(0, Math.round((Date.now() - (state.liveTranscribedUpTo || state.startedAt)) / 1000));
    const slow = behind >= 15;
    els.lagChip.classList.toggle('slow', slow);
    const text = slow
      ? 'Words are ' + behind + ' s behind. The speech server is busy.'
      : 'Words about ' + behind + ' s behind you';
    if (els.lagChip.textContent !== text) els.lagChip.textContent = text;
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
    const acting = isActingAs();
    els.recordButton.classList.toggle('recording', state.recording);
    els.recordButtonText.textContent = acting
      ? 'Recording disabled'
      : (state.recording
        ? 'Stop & finish'
        : ((els.captureSource?.value || 'microphone') === 'microphone' ? 'Start talking' : 'Start capture'));
    els.recordButton.disabled = state.transcribing || acting;
    if (els.menuButton) els.menuButton.disabled = state.recording || state.transcribing;
    els.pauseButton.classList.toggle('hidden', !state.recording);
    els.pauseButton.textContent = state.paused ? 'Carry on' : 'Pause';
    els.language.disabled = state.recording || state.transcribing;
    els.chunkSeconds.disabled = state.recording || state.transcribing;
    if (els.captureSource) els.captureSource.disabled = state.recording || state.transcribing;
    if (els.actAsSelect) els.actAsSelect.disabled = state.recording || state.transcribing;
    els.talkDock?.classList.toggle('recording', state.recording);
    if (state.recording && els.moreActions) els.moreActions.open = false;
    renderHealthBadge();
    updateLagChip();
    els.fileInput.disabled = state.recording || state.transcribing || acting;
    els.keepTalkingButton.disabled = acting;
    els.newButton.disabled = acting;
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
    if (isActingAs()) {
      setError('Return to your own account before creating or continuing a recording.');
      return;
    }
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
      const mute = ctx.createGain(); mute.gain.value = 0;

      let record = reuseExisting ? state.currentRecording : null;
      let processor;
      try {
        processor = await createCaptureProcessor(ctx);
        if (!record) record = await createRecording();
      } catch (error) {
        try { processor?.disconnect(); } catch {}
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
      state.sampleRate = CAPTURE_SAMPLE_RATE;
      state.stopping = false;
      state.segmentBuffers = [];
      state.segmentSampleCount = 0;
      state.segmentIndex = 0;
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

  // Prefer an AudioWorklet so capture runs off the main thread; fall back to
  // the deprecated ScriptProcessorNode only where AudioWorklet is missing.
  // Both paths deliver 16 kHz mono Float32 samples to handleCapturedAudio.
  async function createCaptureProcessor(ctx) {
    if (ctx.audioWorklet && typeof AudioWorkletNode !== 'undefined') {
      try {
        await ctx.audioWorklet.addModule('/audio-utils.js');
        await ctx.audioWorklet.addModule('/capture-worklet.js');
        const node = new AudioWorkletNode(ctx, 'talk-to-type-capture', {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [1],
          channelCount: 1,
          channelCountMode: 'explicit',
          channelInterpretation: 'speakers',
          processorOptions: { targetRate: CAPTURE_SAMPLE_RATE },
        });
        node.port.onmessage = (event) => {
          if (event.data?.samples) handleCapturedAudio(event.data.samples, event.data.level);
        };
        return node;
      } catch (error) {
        console.warn('[Talk to Type] AudioWorklet unavailable; using ScriptProcessor fallback', error);
      }
    }
    const node = ctx.createScriptProcessor(4096, 1, 1);
    const resampler = window.TalkToTypeAudio.createResampler(ctx.sampleRate, CAPTURE_SAMPLE_RATE);
    node.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0);
      handleCapturedAudio(resampler.process(input), window.TalkToTypeAudio.rms(input));
    };
    return node;
  }

  // Ask the worklet to hand over its last partial batch and wait (briefly)
  // for it, so the final ~100 ms of speech is not lost on stop.
  function stopCaptureProcessor() {
    const port = state.processor?.port;
    if (!port) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, 300);
      const previous = port.onmessage;
      port.onmessage = (event) => {
        if (event.data?.type === 'stopped') {
          clearTimeout(timer);
          resolve();
          return;
        }
        previous?.call(port, event);
      };
      port.postMessage({ type: 'stop' });
    });
  }

  function handleCapturedAudio(samples, level) {
    if (!state.recording || state.paused) { setMeter(0); return; }
    if (!samples?.length) return;
    state.segmentBuffers.push(samples);
    state.segmentSampleCount += samples.length;
    state.liveBuffers.push(samples);
    state.liveSampleCount += samples.length;
    state.liveFreshSamples += samples.length;
    maybeFlushLiveChunk();
    if (state.segmentSampleCount >= AUDIO_SEGMENT_SECONDS * state.sampleRate) flushAudioSegment();
    setMeter(level || 0);
  }

  function flushAudioSegment() {
    if (!state.segmentBuffers.length || !state.currentRecording) return;
    const samples = mergeBuffers(state.segmentBuffers);
    state.segmentBuffers = [];
    state.segmentSampleCount = 0;
    if (!samples.length) return;
    state.segmentQueue.push({
      recordingId: state.currentRecording.id,
      index: ++state.segmentIndex,
      blob: encodeWav(samples, state.sampleRate),
      duration: samples.length / state.sampleRate,
    });
    processSegmentQueue();
  }

  async function processSegmentQueue() {
    if (state.segmentUploading) return;
    state.segmentUploading = true;
    try {
      while (state.segmentQueue.length) {
        const item = state.segmentQueue[0];
        let lastError = null;
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            const form = new FormData();
            form.append('file', item.blob, 'segment-' + String(item.index).padStart(4, '0') + '.wav');
            form.append('duration_seconds', item.duration.toFixed(3));
            await api('/api/recordings/' + item.recordingId + '/audio', { method: 'POST', body: form });
            lastError = null;
            break;
          } catch (error) {
            lastError = error;
            await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
          }
        }
        if (lastError) {
          // Keep the segment queued; the next flush (or stop) retries it.
          state.segmentUploadError = lastError;
          if (state.recording) setError('Some voice audio is not saved yet. I will keep trying.');
          break;
        }
        state.segmentQueue.shift();
        state.segmentUploadError = null;
      }
    } finally {
      state.segmentUploading = false;
      state.segmentDrainResolvers.splice(0).forEach((resolve) => resolve());
    }
  }

  async function waitForSegmentUploads() {
    while (state.segmentUploading) {
      await new Promise((resolve) => state.segmentDrainResolvers.push(resolve));
    }
    if (state.segmentQueue.length) await processSegmentQueue();
    if (state.segmentQueue.length) {
      throw new Error(state.segmentUploadError?.message || 'Voice audio could not be uploaded.');
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

    // Cut at the quietest moment in the last second before the target rather
    // than mid-word; the overlap and text de-duplication still cover the join.
    const searchFrom = Math.max(Math.round(target * .6), target - Math.round(1.0 * state.sampleRate));
    const sendLength = finalChunk
      ? merged.length
      : (window.TalkToTypeAudio?.findQuietCut
        ? window.TalkToTypeAudio.findQuietCut(merged, state.sampleRate, searchFrom, target)
        : target);
    if (sendLength < Math.round(.25 * state.sampleRate)) return false;
    const audio = merged.slice(0, sendLength);
    const nextStart = finalChunk ? merged.length : Math.max(0, sendLength - overlap);
    const remainder = finalChunk ? new Float32Array(0) : merged.slice(nextStart);
    state.liveBuffers = remainder.length ? [remainder] : [];
    state.liveSampleCount = remainder.length;
    state.liveFreshSamples = finalChunk ? 0 : Math.max(0, remainder.length - overlap);
    state.liveQueue.push({ index: ++state.liveChunkIndex, blob: encodeWav(audio, state.sampleRate), endedAt: Date.now() });
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
        state.liveTranscribedUpTo = Math.max(state.liveTranscribedUpTo || 0, item.endedAt || 0);
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
    if (state.processor) {
      state.processor.onaudioprocess = null;
      if (state.processor.port) state.processor.port.onmessage = null;
      try { state.processor.disconnect(); } catch {}
    }
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
    if (!state.recording || state.stopping) return;
    state.stopping = true;
    const elapsed = Math.max(0, (Date.now() - state.startedAt) / 1000);
    await stopCaptureProcessor();
    state.recording = false;
    flushLiveChunk(true);
    flushAudioSegment();
    cleanupRecording();
    state.stopping = false;
    state.transcribing = true; syncRecordingUI(); setStatus('Nearly done', 'Saving your voice and checking the last few words…');
    await waitForLiveDrain();
    commitLivePending();
    clearTimeout(state.draftSaveTimer);
    try {
      await persistDraftNow();
      await waitForSegmentUploads();

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
      state.transcribing = false; state.segmentBuffers = []; state.segmentSampleCount = 0; syncRecordingUI();
    }
  }

  function togglePause() {
    if (!state.recording) return;
    state.paused = !state.paused; if (state.paused) setMeter(0);
    if (state.paused) {
      state.pausedAt = Date.now();
    } else if (state.pausedAt) {
      state.liveTranscribedUpTo += Date.now() - state.pausedAt;
      state.pausedAt = 0;
    }
    updateLagChip();
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
      const del = document.createElement('button'); del.textContent = 'Move to bin';
      del.disabled = isActingAs();
      del.title = isActingAs() ? 'Return to your account before deleting recordings.' : '';
      del.addEventListener('click', async () => { if (!confirm('Move this recording to the bin?')) return; await api('/api/recordings/' + record.id, { method: 'DELETE' }); loadHistory(); }); actions.appendChild(del);
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
    setToolsTab(state.toolsTab || userLocalGet('toolsTab') || 'meetings');
    renderToolsHealth();
    await Promise.allSettled([
      loadAdminStatus(),
      loadRecycleBin(),
      loadUsers(),
      loadSpeakerStatus(),
      loadMeetingNotesStatus(),
      loadSpeakerProfiles(),
      loadRelabelSamples(),
      loadMeetings(),
    ]);
  }

  // ---------------------------------------------------------------------
  // Tools page: tabs, badges and service health
  // ---------------------------------------------------------------------

  const TOOLS_TABS = ['meetings', 'voices', 'users', 'system'];

  function setToolsTab(name, focus = false) {
    const tab = TOOLS_TABS.includes(name) ? name : 'meetings';
    state.toolsTab = tab;
    try { userLocalSet('toolsTab', tab); } catch {}
    for (const item of TOOLS_TABS) {
      const button = $('toolsTab-' + item);
      const panel = $('toolsPanel-' + item);
      const on = item === tab;
      button.setAttribute('aria-selected', String(on));
      button.tabIndex = on ? 0 : -1;
      panel.hidden = !on;
      if (on && focus) button.focus();
    }
  }

  function setToolsBadge(name, value) {
    const badge = $('toolsBadge-' + name);
    if (!badge) return;
    badge.hidden = !value;
    if (value && name !== 'system') badge.textContent = String(value);
  }

  // Each service is { label, level: 'ok' | 'bad' | 'off' | 'checking', value, detail }.
  // 'off' means not configured, which is not treated as a problem.
  const HEALTH_ORDER = ['gateway', 'database', 'speaker', 'llm', 'notebook'];
  const HEALTH_LABELS = {
    gateway: 'Speech gateway',
    database: 'Database',
    speaker: 'Speaker analyzer',
    llm: 'Notes model',
    notebook: 'Open Notebook',
  };

  function setHealth(key, level, value, detail = '') {
    state.toolsHealth[key] = { level, value, detail };
    renderToolsHealth();
  }

  function renderToolsHealth() {
    const health = state.toolsHealth;
    els.toolsHealthList.replaceChildren();
    els.systemHealthTiles.replaceChildren();
    let problems = 0;
    for (const key of HEALTH_ORDER) {
      const item = health[key] || { level: 'checking', value: 'Checking…', detail: '' };
      if (item.level === 'bad') problems += 1;

      const li = document.createElement('li');
      li.className = 'health-dot-item health-' + item.level;
      const dot = document.createElement('span'); dot.className = 'health-dot'; dot.setAttribute('aria-hidden', 'true');
      const label = item.level === 'bad' ? document.createElement('button') : document.createElement('span');
      if (item.level === 'bad') {
        label.type = 'button';
        label.className = 'health-link';
        label.addEventListener('click', () => setToolsTab('system', true));
      }
      label.textContent = HEALTH_LABELS[key];
      label.title = item.value + (item.detail ? ' · ' + item.detail : '');
      const status = document.createElement('span'); status.className = 'sr-only'; status.textContent = ': ' + item.value;
      li.append(dot, label, status);
      els.toolsHealthList.appendChild(li);

      const tile = document.createElement('div');
      tile.className = 'health-tile health-' + item.level;
      const name = document.createElement('span'); name.className = 'health-tile-name'; name.textContent = HEALTH_LABELS[key];
      const value = document.createElement('strong'); value.className = 'health-tile-value'; value.textContent = item.value;
      const detail = document.createElement('span'); detail.className = 'muted small-note'; detail.textContent = item.detail || '';
      tile.append(name, value, detail);
      els.systemHealthTiles.appendChild(tile);
    }
    setToolsBadge('system', problems ? '!' : '');
  }

  // ---------------------------------------------------------------------
  // Users
  // ---------------------------------------------------------------------

  async function loadUsers() {
    try {
      const users = await api('/api/admin/users', { cache: 'no-store' });
      renderUsers(users);
      renderActAsOptions(users);
    } catch (error) {
      els.userList.replaceChildren(tableMessageRow(5, error.message, 'error'));
    }
  }

  function tableMessageRow(columns, message, className = 'muted') {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = columns;
    cell.className = className;
    cell.textContent = message;
    row.appendChild(cell);
    return row;
  }

  function toggleCreateUserForm(open) {
    els.createUserForm.hidden = !open;
    els.addUserToggleButton.setAttribute('aria-expanded', String(open));
    if (open) els.newUsername.focus();
    else els.createUserForm.reset();
  }

  function renderUsers(users) {
    els.userList.replaceChildren();
    for (const user of users) {
      const row = document.createElement('tr');

      const nameCell = document.createElement('td');
      const name = document.createElement('strong'); name.textContent = user.display_name;
      nameCell.appendChild(name);
      if (user.is_current) {
        const you = document.createElement('span'); you.className = 'chip chip-analysed chip-inline'; you.textContent = 'You';
        nameCell.appendChild(you);
      }
      const handle = document.createElement('div'); handle.className = 'muted small-note'; handle.textContent = '@' + user.username;
      nameCell.appendChild(handle);

      const role = document.createElement('td'); role.textContent = user.is_admin ? 'Admin' : 'User';
      const recordings = document.createElement('td'); recordings.textContent = String(user.recordings);
      const status = document.createElement('td');
      const statusText = document.createElement('span');
      statusText.className = user.is_active ? 'status-good' : 'status-bad';
      statusText.textContent = user.is_active ? 'Active' : 'Inactive';
      status.appendChild(statusText);

      const actions = document.createElement('td'); actions.className = 'table-actions';
      const edit = document.createElement('button'); edit.type = 'button'; edit.className = 'quiet'; edit.textContent = 'Edit';
      edit.setAttribute('aria-expanded', 'false');

      const editRow = document.createElement('tr'); editRow.className = 'table-expand-row'; editRow.hidden = true;
      const editCell = document.createElement('td'); editCell.colSpan = 5;
      const form = document.createElement('div'); form.className = 'user-edit-grid';
      const displayLabel = document.createElement('label'); displayLabel.className = 'admin-label'; displayLabel.textContent = 'Display name';
      const display = document.createElement('input'); display.value = user.display_name; displayLabel.appendChild(display);
      const passwordLabel = document.createElement('label'); passwordLabel.className = 'admin-label'; passwordLabel.textContent = 'New password';
      const password = document.createElement('input'); password.type = 'password'; password.placeholder = 'Leave blank to keep';
      password.autocomplete = 'new-password'; passwordLabel.appendChild(password);
      const adminLabel = document.createElement('label'); adminLabel.className = 'check admin-check';
      const adminToggle = document.createElement('input'); adminToggle.type = 'checkbox';
      adminToggle.checked = Boolean(user.is_admin);
      adminToggle.disabled = Boolean(user.is_current && user.is_admin);
      adminLabel.append(adminToggle, document.createTextNode(' Admin access'));
      const editButtons = document.createElement('div'); editButtons.className = 'button-row';
      const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Cancel';
      const save = document.createElement('button'); save.type = 'button'; save.className = 'primary'; save.textContent = 'Save';
      editButtons.append(cancel, save);
      form.append(displayLabel, passwordLabel, adminLabel, editButtons);
      editCell.appendChild(form); editRow.appendChild(editCell);

      const setEditing = (open) => {
        editRow.hidden = !open;
        edit.setAttribute('aria-expanded', String(open));
        if (open) display.focus();
      };
      edit.addEventListener('click', () => setEditing(editRow.hidden));
      cancel.addEventListener('click', () => {
        display.value = user.display_name; password.value = ''; adminToggle.checked = Boolean(user.is_admin);
        setEditing(false);
      });
      save.addEventListener('click', async () => {
        const body = { display_name: display.value.trim(), is_admin: adminToggle.checked };
        if (password.value) body.password = password.value;
        try {
          await api('/api/admin/users/' + user.id, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
          showToast('Person updated');
          if (user.is_current && body.display_name) {
            state.authUser.display_name = body.display_name;
            els.currentUserLabel.textContent = body.display_name;
          }
          await loadUsers();
        } catch (error) {
          els.userAdminMessage.textContent = error.message;
        }
      });
      actions.appendChild(edit);

      if (user.is_active && !user.is_admin && !user.is_current) {
        const manage = document.createElement('button'); manage.type = 'button'; manage.className = 'quiet';
        manage.textContent = 'Manage as user';
        manage.title = 'Open this person’s My words and Progress';
        manage.addEventListener('click', () => switchActAs(user.id));
        actions.appendChild(manage);
      }

      const toggle = document.createElement('button'); toggle.type = 'button';
      toggle.className = user.is_active ? 'quiet danger-text' : 'quiet';
      toggle.textContent = user.is_active ? 'Deactivate' : 'Reactivate';
      toggle.disabled = Boolean(user.is_current && user.is_active);
      if (toggle.disabled) toggle.title = 'You can’t deactivate the account you’re signed in with.';
      toggle.addEventListener('click', async () => {
        if (user.is_active && !confirm('Deactivate ' + user.display_name + '? They will no longer be able to sign in.')) return;
        try {
          await api('/api/admin/users/' + user.id, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ is_active: !user.is_active }),
          });
          showToast(user.is_active ? 'Person deactivated' : 'Person reactivated');
          await loadUsers();
        } catch (error) {
          els.userAdminMessage.textContent = error.message;
        }
      });
      actions.appendChild(toggle);

      row.append(nameCell, role, recordings, status, actions);
      els.userList.append(row, editRow);
    }
    if (!users.length) els.userList.appendChild(tableMessageRow(5, 'No people yet.'));
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
      toggleCreateUserForm(false);
      showToast('Person added');
      await loadUsers();
    } catch (error) {
      els.userAdminMessage.textContent = error.message;
    } finally {
      els.createUserButton.disabled = false;
    }
  }

  // ---------------------------------------------------------------------
  // Speaker analyzer status and remembered voices
  // ---------------------------------------------------------------------

  async function loadSpeakerStatus() {
    try {
      const status = await api('/api/admin/speakers/status', { cache: 'no-store' });
      const service = status.service || {};
      if (!status.reachable) {
        setHealth('speaker', 'bad', 'Not reachable', 'Check the speaker-analyzer container');
      } else if (!service.configured) {
        setHealth('speaker', 'bad', 'Needs HF token', 'Accept the pyannote terms and set HF_TOKEN');
      } else if (service.status === 'device_error') {
        setHealth('speaker', 'bad', 'GPU problem', service.device_error || 'Incompatible GPU');
      } else {
        const gpu = Array.isArray(service.gpus)
          ? service.gpus.find((item) => String(service.device || '').endsWith(':' + item.index)) || service.gpus[0]
          : null;
        setHealth('speaker', 'ok', 'Ready', (gpu?.name || '') + (service.arbitrated ? ' · via llama-swap' : ''));
      }
    } catch (error) {
      setHealth('speaker', 'bad', 'Not reachable', error.message || '');
    }
    if (state.meetings.selectedId) renderMeetingDetail();
  }

  async function loadSpeakerProfiles() {
    try {
      const profiles = await api('/api/admin/speakers/profiles', { cache: 'no-store' });
      state.speakerProfiles = profiles;
      renderSpeakerProfiles();
      if (state.meetings.analysis) renderMeetingDetail();
    } catch (error) {
      els.speakerProfilesList.replaceChildren(tableMessageRow(5, error.message, 'error'));
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
    button.textContent = 'Loading…';

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
      button.textContent = '■ Stop';
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

  function sampleMeter(count, max) {
    const meter = document.createElement('span');
    meter.className = 'sample-meter';
    meter.setAttribute('role', 'img');
    meter.setAttribute('aria-label', count + ' of ' + max + ' samples');
    for (let index = 0; index < max; index += 1) {
      const cell = document.createElement('span');
      if (index < count) cell.className = 'filled';
      meter.appendChild(cell);
    }
    return meter;
  }

  async function afterProfileChange(message) {
    showToast(message);
    await loadSpeakerProfiles();
    if (state.meetings.analysis) await refreshCurrentSpeakerAnalysis();
  }

  function renderSpeakerProfiles() {
    stopSpeakerPreview();
    const profiles = state.speakerProfiles || [];
    const query = (els.voicesSearch.value || '').trim().toLocaleLowerCase();
    const shown = profiles.filter((profile) => !query || profile.name.toLocaleLowerCase().includes(query));
    els.speakerProfilesList.replaceChildren();
    if (!profiles.length) {
      els.speakerProfilesList.appendChild(tableMessageRow(5, 'No remembered voices yet. Name a speaker in Meetings to start one.'));
      return;
    }
    if (!shown.length) {
      els.speakerProfilesList.appendChild(tableMessageRow(5, 'No voices match “' + els.voicesSearch.value.trim() + '”.'));
      return;
    }

    for (const profile of shown) {
      const row = document.createElement('tr');
      const quality = String(profile.profile_quality || '');

      const nameCell = document.createElement('td');
      const name = document.createElement('strong'); name.textContent = profile.name;
      nameCell.appendChild(name);

      const samplesCell = document.createElement('td');
      const samplesWrap = document.createElement('span'); samplesWrap.className = 'sample-meter-wrap';
      const samplesText = document.createElement('span'); samplesText.className = 'muted small-note';
      samplesText.textContent = profile.sample_count + '/' + profile.max_samples;
      samplesWrap.append(sampleMeter(profile.sample_count, profile.max_samples), samplesText);
      samplesCell.appendChild(samplesWrap);

      const qualityCell = document.createElement('td');
      const qualityChip = document.createElement('span');
      qualityChip.className = 'chip ' + (quality === 'starter' ? 'chip-todo' : 'chip-analysed');
      qualityChip.textContent = quality ? quality.charAt(0).toUpperCase() + quality.slice(1) : '—';
      qualityCell.appendChild(qualityChip);

      const updatedCell = document.createElement('td'); updatedCell.className = 'muted';
      updatedCell.textContent = profile.updated_at ? friendlyDate(profile.updated_at) : '';

      const actions = document.createElement('td'); actions.className = 'table-actions';
      const samplesButton = document.createElement('button'); samplesButton.type = 'button'; samplesButton.className = 'quiet';
      samplesButton.textContent = 'Samples'; samplesButton.setAttribute('aria-expanded', 'false');
      const rename = document.createElement('button'); rename.type = 'button'; rename.className = 'quiet'; rename.textContent = 'Rename';
      const forget = document.createElement('button'); forget.type = 'button'; forget.className = 'quiet danger-text'; forget.textContent = 'Forget';
      actions.append(samplesButton, rename, forget);

      // Rename in place
      rename.addEventListener('click', () => {
        const input = document.createElement('input'); input.value = profile.name;
        input.setAttribute('aria-label', 'New name for ' + profile.name);
        const saveName = document.createElement('button'); saveName.type = 'button'; saveName.className = 'primary small'; saveName.textContent = 'Save';
        const cancelName = document.createElement('button'); cancelName.type = 'button'; cancelName.className = 'small'; cancelName.textContent = 'Cancel';
        const editor = document.createElement('span'); editor.className = 'inline-rename';
        editor.append(input, saveName, cancelName);
        nameCell.replaceChildren(editor);
        input.focus(); input.select();
        const restore = () => nameCell.replaceChildren(name);
        cancelName.addEventListener('click', restore);
        const commit = async () => {
          const value = input.value.trim();
          if (!value || value === profile.name) { restore(); return; }
          try {
            await api('/api/admin/speakers/profiles/' + profile.id, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ name: value }),
            });
            await afterProfileChange('Voice renamed');
          } catch (error) {
            showToast(error.message);
          }
        };
        saveName.addEventListener('click', commit);
        input.addEventListener('keydown', (event) => {
          if (event.key === 'Enter') { event.preventDefault(); commit(); }
          if (event.key === 'Escape') restore();
        });
      });

      forget.addEventListener('click', async () => {
        if (!confirm('Forget the saved voice for ' + profile.name + '? Past conversation labels will stay.')) return;
        try {
          await api('/api/admin/speakers/profiles/' + profile.id, { method: 'DELETE' });
          await afterProfileChange('Voice forgotten');
        } catch (error) {
          showToast(error.message);
        }
      });

      // Samples expand below the row
      const expandRow = document.createElement('tr'); expandRow.className = 'table-expand-row';
      const expandedKey = profile.id;
      expandRow.hidden = !state.voicesExpanded.has(expandedKey);
      samplesButton.setAttribute('aria-expanded', String(!expandRow.hidden));
      const expandCell = document.createElement('td'); expandCell.colSpan = 5;
      const list = document.createElement('div'); list.className = 'voice-sample-grid';
      for (const sample of profile.samples || []) {
        const sampleRow = document.createElement('div'); sampleRow.className = 'voice-sample-card';
        const info = document.createElement('div');
        const title = document.createElement('strong'); title.textContent = sample.source_recording_title || 'Saved voice sample';
        const detail = document.createElement('span'); detail.className = 'muted small-note';
        const speech = sample.speech_seconds == null ? 'legacy sample' : (Number(sample.speech_seconds).toFixed(0) + 's');
        detail.textContent = speech + (sample.source_recording_owner ? ' · owner ' + sample.source_recording_owner : '') + ' · ' + friendlyDate(sample.created_at);
        info.append(title, detail);

        const sampleActions = document.createElement('div'); sampleActions.className = 'voice-sample-actions';
        const preview = document.createElement('button'); preview.type = 'button'; preview.className = 'quiet speaker-preview-button voice-sample-preview';
        preview.dataset.idleLabel = '▶ Hear';
        preview.textContent = preview.dataset.idleLabel;
        preview.disabled = !sample.can_preview;
        preview.title = sample.can_preview ? 'Play this sample' : 'The source audio for this sample is not available.';
        preview.setAttribute('aria-pressed', 'false');
        preview.addEventListener('click', () => toggleRememberedSamplePreview(profile, sample, preview));

        const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'quiet danger-text'; remove.textContent = 'Remove';
        remove.disabled = profile.sample_count <= 1;
        remove.title = profile.sample_count <= 1 ? 'Use Forget to remove the final sample.' : 'Remove this sample from future matching';
        remove.addEventListener('click', async () => {
          if (!confirm('Remove this voice sample from ' + profile.name + '?')) return;
          try {
            stopSpeakerPreview();
            await api('/api/admin/speakers/profiles/' + profile.id + '/samples/' + sample.id, { method: 'DELETE' });
            await afterProfileChange('Voice sample removed');
          } catch (error) {
            showToast(error.message);
          }
        });
        sampleActions.append(preview, remove);
        sampleRow.append(info, sampleActions);
        list.appendChild(sampleRow);
      }
      if (!(profile.samples || []).length) {
        const none = document.createElement('p'); none.className = 'muted small-note'; none.textContent = 'No samples stored.';
        list.appendChild(none);
      }
      expandCell.appendChild(list); expandRow.appendChild(expandCell);
      samplesButton.addEventListener('click', () => {
        expandRow.hidden = !expandRow.hidden;
        if (expandRow.hidden) state.voicesExpanded.delete(expandedKey);
        else state.voicesExpanded.add(expandedKey);
        samplesButton.setAttribute('aria-expanded', String(!expandRow.hidden));
      });

      row.append(nameCell, samplesCell, qualityCell, updatedCell, actions);
      els.speakerProfilesList.append(row, expandRow);
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
      state.meetings.analysis = updated;
      renderMeetingDetail();
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

  // Local calendar day -> ISO instant, so the date range follows the admin's clock.
  function localDayBoundary(value, endOfDay) {
    if (!value) return null;
    const [year, month, day] = value.split('-').map(Number);
    const date = endOfDay
      ? new Date(year, month - 1, day, 23, 59, 59, 999)
      : new Date(year, month - 1, day, 0, 0, 0, 0);
    return date.toISOString();
  }

  function setRelabelView(view) {
    state.relabelView = view;
    const history = view === 'history';
    els.relabelPendingViewButton.setAttribute('aria-pressed', String(!history));
    els.relabelHistoryViewButton.setAttribute('aria-pressed', String(history));
    els.relabelHistoryFilters.hidden = !history;
    loadRelabelSamples();
  }

  async function loadRelabelSamples() {
    if (!els.relabelSamplesList) return;
    const params = new URLSearchParams();
    if (state.relabelView === 'history') {
      if (els.relabelStatusFilter.value) params.set('status', els.relabelStatusFilter.value);
      const from = localDayBoundary(els.relabelFromDate.value, false);
      const to = localDayBoundary(els.relabelToDate.value, true);
      if (from) params.set('created_from', from);
      if (to) params.set('created_to', to);
    } else {
      params.set('status', 'pending');
    }
    try {
      const [samples, summary] = await Promise.all([
        api('/api/admin/speakers/relabels?' + params.toString(), { cache: 'no-store' }),
        api('/api/admin/speakers/relabels/summary', { cache: 'no-store' }),
      ]);
      els.relabelPendingViewButton.textContent = 'Needs review (' + summary.pending + ')';
      els.relabelHistoryViewButton.textContent = 'History (' + summary.total + ')';
      setToolsBadge('voices', summary.pending);
      if (state.relabelView === 'history') {
        const filtered = Boolean(params.toString());
        els.relabelSamplesSummary.textContent = filtered
          ? samples.length + ' of ' + summary.total + ' samples match these filters.'
          : 'All ' + summary.total + ' samples · ' + summary.approved + ' approved · ' +
            summary.excluded + ' excluded · ' + summary.pending + ' waiting for review.';
      } else {
        els.relabelSamplesSummary.textContent = summary.pending
          ? 'Approve or exclude each sample; reviewed samples move to History.'
          : '';
      }
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
      p.textContent = state.relabelView === 'history'
        ? 'No relabelled samples match these filters.'
        : 'Nothing waiting for review. Reviewed samples are in History.';
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
        (sample.recording_owner ? sample.recording_owner + ' · ' : '') +
        (sample.recording_title || 'Recording') + ' · ' +
        formatTime(sample.start_seconds) + ' · relabelled ' +
        friendlyDate(sample.created_at) +
        (sample.reviewed_at && sample.status !== 'pending' ? ' · reviewed ' + friendlyDate(sample.reviewed_at) : '');
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
        if (state.relabelView === 'pending') showToast('Approved · moved to History');
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
        if (state.relabelView === 'pending') showToast('Excluded · moved to History');
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
        await refreshCurrentSpeakerAnalysis();
      });

      const reopen = document.createElement('button'); reopen.type = 'button';
      reopen.textContent = 'Back to review';
      reopen.title = 'Return this sample to the Needs review queue';
      reopen.hidden = sample.status === 'pending';
      reopen.addEventListener('click', async () => {
        await api('/api/admin/speakers/relabels/' + sample.id, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'pending' }),
        });
        await loadRelabelSamples();
      });

      actions.append(hear, approve, exclude, reopen, undo);
      row.append(info, actions);
      els.relabelSamplesList.appendChild(row);
    }
  }

  // ---------------------------------------------------------------------
  // Meetings: conversation strip and the three steps
  // ---------------------------------------------------------------------

  const ACTIVE_JOB = ['queued', 'processing'];

  // A running notes job is either writing notes or only sending saved ones.
  function sendingOnly(notes) {
    if (!ACTIVE_JOB.includes(notes?.status)) return false;
    return state.meetings.jobKind === 'send' || notes.stage === 'Sending to Open Notebook';
  }

  function currentMeeting() {
    return state.meetings.recordings.find((item) => item.id === state.meetings.selectedId) || null;
  }

  function meetingNotesRecordingId() {
    return state.meetings.selectedId;
  }

  function meetingStage(recording) {
    if (recording.open_notebook_exported && !recording.export_outdated) return 'sent';
    if (recording.open_notebook_exported) return 'outdated';
    if (recording.notes_ready) return 'notes';
    if (recording.analysed) return 'analysed';
    return 'todo';
  }

  const STAGE_CHIPS = {
    sent: ['chip-sent', '✓ In Open Notebook'],
    outdated: ['chip-notes', 'Newer notes not sent'],
    notes: ['chip-notes', 'Notes not sent'],
    analysed: ['chip-analysed', 'Analysed'],
    todo: ['chip-todo', 'Not analysed'],
  };

  function speechLength(seconds) {
    const value = Number(seconds || 0);
    if (value < 60) return Math.round(value) + 's';
    return Math.round(value / 60) + ' min';
  }

  function stepChip(element, className, text) {
    element.className = 'chip step-chip ' + className;
    element.textContent = text;
  }

  async function loadMeetings() {
    try {
      const recordings = await api('/api/admin/speakers/recordings?view=all', { cache: 'no-store' });
      state.meetings.recordings = recordings;
      if (!state.meetings.selectedId) {
        try { state.meetings.selectedId = userLocalGet('meetingsSelected') || null; } catch {}
      }
      if (state.meetings.selectedId && !recordings.some((item) => item.id === state.meetings.selectedId)) {
        state.meetings.selectedId = null;
      }
      renderMeetingsList();
      if (state.meetings.selectedId) await loadMeetingDetail();
      else renderMeetingDetail();
    } catch (error) {
      els.meetingsList.replaceChildren();
      const li = document.createElement('li'); li.className = 'error'; li.textContent = error.message;
      els.meetingsList.appendChild(li);
    }
  }

  // Re-read list flags (analysed / notes / sent) without reloading the detail.
  async function refreshMeetingsList() {
    try {
      state.meetings.recordings = await api('/api/admin/speakers/recordings?view=all', { cache: 'no-store' });
      renderMeetingsList();
    } catch {}
  }

  function renderMeetingsList() {
    const { recordings, filter, selectedId } = state.meetings;
    const query = (els.meetingsSearch.value || '').trim().toLocaleLowerCase();
    const counts = { todo: 0, sent: 0, all: recordings.length };
    for (const recording of recordings) {
      if (meetingStage(recording) === 'sent') counts.sent += 1; else counts.todo += 1;
    }
    for (const name of ['todo', 'sent', 'all']) {
      const button = $('meetingsFilter-' + name);
      const label = { todo: 'To do', sent: 'Sent', all: 'All' }[name];
      button.textContent = label + ' (' + counts[name] + ')';
      button.setAttribute('aria-pressed', String(filter === name));
    }
    setToolsBadge('meetings', counts.todo);

    const shown = recordings.filter((recording) => {
      const stage = meetingStage(recording);
      if (filter === 'todo' && stage === 'sent') return false;
      if (filter === 'sent' && stage !== 'sent') return false;
      return !query || (recording.title || '').toLocaleLowerCase().includes(query);
    });

    els.meetingsList.replaceChildren();
    for (const recording of shown) {
      const li = document.createElement('li');
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'meeting-card';
      if (recording.id === selectedId) card.setAttribute('aria-current', 'true');
      const title = document.createElement('span'); title.className = 'meeting-card-title'; title.textContent = recording.title || 'Recording';
      const meta = document.createElement('span'); meta.className = 'meeting-card-meta';
      const who = document.createElement('span'); who.className = 'muted';
      const owner = recording.owner_display_name || recording.owner_username || '';
      who.textContent = [owner, recording.duration_seconds ? speechLength(recording.duration_seconds) : ''].filter(Boolean).join(' · ');
      const [chipClass, chipText] = STAGE_CHIPS[meetingStage(recording)];
      const chip = document.createElement('span'); chip.className = 'chip ' + chipClass; chip.textContent = chipText;
      meta.append(who, chip);
      card.append(title, meta);
      card.addEventListener('click', () => selectMeeting(recording.id));
      li.appendChild(card);
      els.meetingsList.appendChild(li);
    }
    if (!shown.length) {
      const li = document.createElement('li'); li.className = 'meetings-empty muted';
      li.textContent = query
        ? 'No conversations match “' + els.meetingsSearch.value.trim() + '”.'
        : filter === 'todo' ? 'Nothing left to do. Every conversation is in Open Notebook.'
          : filter === 'sent' ? 'Nothing sent to Open Notebook yet.'
            : 'No saved conversations with voice audio yet.';
      els.meetingsList.appendChild(li);
    }
  }

  function setMeetingsFilter(filter) {
    state.meetings.filter = filter;
    renderMeetingsList();
  }

  async function selectMeeting(recordingId) {
    if (state.meetings.selectedId === recordingId) return;
    stopSpeakerPreview();
    state.meetings.selectedId = recordingId;
    state.meetings.analysis = null;
    state.meetings.notes = null;
    state.meetings.analysisError = '';
    state.meetings.showTurns = false;
    try { userLocalSet('meetingsSelected', recordingId); } catch {}
    renderMeetingsList();
    renderMeetingDetail();
    await loadMeetingDetail();
  }

  async function loadMeetingDetail() {
    const recording = currentMeeting();
    if (!recording) { renderMeetingDetail(); return; }
    const [analysis, notes] = await Promise.all([
      recording.latest_analysis_id
        ? api('/api/admin/speakers/analyses/' + recording.latest_analysis_id, { cache: 'no-store' }).catch(() => null)
        : Promise.resolve(null),
      api('/api/admin/meeting-notes/recordings/' + recording.id, { cache: 'no-store' }).catch(() => null),
    ]);
    if (state.meetings.selectedId !== recording.id) return;
    state.meetings.analysis = analysis;
    state.meetings.notes = notes;
    renderMeetingDetail();
    if (notes && ACTIVE_JOB.includes(notes.status)) pollMeetingNotes(recording.id);
  }

  async function refreshCurrentSpeakerAnalysis() {
    const analysis = state.meetings.analysis;
    if (!analysis) return;
    try {
      const fresh = await api('/api/admin/speakers/analyses/' + analysis.id, { cache: 'no-store' });
      if (state.meetings.analysis?.id !== fresh.id) return;
      state.meetings.analysis = fresh;
      renderMeetingDetail();
    } catch {}
  }

  // Speakers still called "Person N": notes can't give their action items an owner.
  // Named-but-not-remembered speakers keep their edit card but aren't counted.
  function unnamedDetections(analysis) {
    return (analysis?.detections || []).filter(
      (detection) => !detection.profile_id && /^Person \d+$/.test(detection.display_name),
    );
  }

  function renderMeetingDetail() {
    const recording = currentMeeting();
    if (!recording) {
      els.meetingDetailTitle.textContent = 'Choose a conversation';
      els.meetingDetailMeta.textContent = 'Pick one from the list above to analyse speakers, write notes and send them to Open Notebook.';
      els.meetingSteps.hidden = true;
      els.meetingTurns.hidden = true;
      return;
    }
    const { analysis, notes } = state.meetings;
    els.meetingDetailTitle.textContent = recording.title || 'Recording';
    const when = new Date(recording.created_at);
    const whenText = Number.isNaN(when.getTime())
      ? ''
      : when.toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    els.meetingDetailMeta.textContent = [
      recording.owner_display_name ? 'Recorded by ' + recording.owner_display_name : '',
      whenText,
      recording.duration_seconds ? speechLength(recording.duration_seconds) : '',
      analysis ? analysis.speaker_count + ' speaker' + (analysis.speaker_count === 1 ? '' : 's') : '',
    ].filter(Boolean).join(' · ');
    els.meetingSteps.hidden = false;

    renderSpeakersStep(recording, analysis);
    renderNotesStep(recording, analysis, notes);
    renderNotebookStep(notes);

    // Outline the next thing to do.
    const hasNotes = Boolean(notes?.has_notes);
    const next = !analysis ? 'stepSpeakers'
      : !hasNotes ? 'stepNotes'
        : (!notes.exported || notes.export_outdated) ? 'stepNotebook' : '';
    for (const id of ['stepSpeakers', 'stepNotes', 'stepNotebook']) {
      $(id).classList.toggle('is-next', id === next);
    }

    els.meetingTurns.hidden = !(state.meetings.showTurns && analysis);
    if (state.meetings.showTurns && analysis) renderTurns(analysis);
  }

  function speakerCountSelect(id) {
    const label = document.createElement('label'); label.className = 'inline-select';
    label.textContent = 'Expected speakers';
    const select = document.createElement('select'); select.id = id;
    for (const [value, text] of [['', 'Auto'], ['2', '2'], ['3', '3'], ['4', '4'], ['5', '5'], ['6', '6']]) {
      const option = document.createElement('option'); option.value = value; option.textContent = text;
      select.appendChild(option);
    }
    label.appendChild(select);
    return { label, select };
  }

  function renderSpeakersStep(recording, analysis) {
    const body = els.stepSpeakersBody;
    const foot = els.stepSpeakersFoot;
    body.replaceChildren();
    foot.replaceChildren();
    const speakerHealth = state.toolsHealth.speaker;
    const analyserDown = speakerHealth?.level === 'bad';

    if (state.meetings.analysingId === recording.id) {
      stepChip(els.stepSpeakersChip, 'chip-todo', 'Analysing…');
      const p = document.createElement('p'); p.className = 'muted';
      p.textContent = state.meetings.analysisStage || 'Finding speakers and transcribing their turns…';
      body.appendChild(p);
      return;
    }

    if (!analysis) {
      stepChip(els.stepSpeakersChip, 'chip-notes', 'To do');
      const p = document.createElement('p'); p.className = 'muted small-note';
      p.textContent = 'Not analysed yet. Analysis works out who spoke when and matches remembered voices.';
      body.appendChild(p);
      if (state.meetings.analysisError) {
        const error = document.createElement('p'); error.className = 'speaker-alert small-note'; error.textContent = state.meetings.analysisError;
        body.appendChild(error);
      }
      if (analyserDown) {
        const warn = document.createElement('p'); warn.className = 'speaker-alert small-note';
        warn.textContent = 'Speaker analyzer: ' + speakerHealth.value + (speakerHealth.detail ? ' · ' + speakerHealth.detail : '');
        body.appendChild(warn);
      }
      const { label, select } = speakerCountSelect('meetingSpeakerCount');
      const run = document.createElement('button'); run.type = 'button'; run.className = 'primary'; run.textContent = 'Analyse conversation';
      run.disabled = analyserDown;
      run.addEventListener('click', () => runSpeakerAnalysis(select.value ? Number(select.value) : null));
      body.append(label, run);
      return;
    }

    const unnamed = unnamedDetections(analysis);
    if (unnamed.length) stepChip(els.stepSpeakersChip, 'chip-notes', unnamed.length + ' unnamed');
    else stepChip(els.stepSpeakersChip, 'chip-analysed', 'Done');

    const detections = [...analysis.detections].sort((a, b) => a.person_index - b.person_index);
    for (const detection of detections) {
      body.appendChild(detection.profile_id
        ? matchedSpeakerRow(analysis, detection)
        : unnamedSpeakerCard(analysis, detection));
    }
    if (!detections.length) {
      const p = document.createElement('p'); p.className = 'muted small-note'; p.textContent = 'No speakers were found in this recording.';
      body.appendChild(p);
    }

    const review = document.createElement('button'); review.type = 'button'; review.className = 'quiet link-button';
    const turns = (analysis.turns || []).filter((turn) => turn.text).length;
    review.textContent = state.meetings.showTurns ? 'Hide turns' : 'Review ' + turns + ' turns →';
    review.setAttribute('aria-expanded', String(Boolean(state.meetings.showTurns)));
    review.setAttribute('aria-controls', 'meetingTurns');
    review.addEventListener('click', () => {
      state.meetings.showTurns = !state.meetings.showTurns;
      renderMeetingDetail();
      if (state.meetings.showTurns) els.meetingTurns.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    const { label, select } = speakerCountSelect('meetingReanalyseCount');
    const rerun = document.createElement('button'); rerun.type = 'button'; rerun.textContent = 'Re-analyse';
    rerun.disabled = analyserDown;
    rerun.addEventListener('click', () => {
      if (!confirm('Re-analyse this conversation? Speaker labels and turn corrections start again from a fresh analysis.')) return;
      runSpeakerAnalysis(select.value ? Number(select.value) : null);
    });
    const rerunGroup = document.createElement('span'); rerunGroup.className = 'reanalyse-group';
    rerunGroup.append(label, rerun);
    foot.append(review, rerunGroup);
  }

  function hearButton(analysis, detection) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'quiet speaker-preview-button';
    button.dataset.idleLabel = '▶ Hear';
    button.textContent = button.dataset.idleLabel;
    button.setAttribute('aria-label', 'Hear ' + detection.display_name);
    button.setAttribute('aria-pressed', 'false');
    button.disabled = !detection.can_preview;
    button.title = detection.can_preview
      ? 'Play the longest continuous section attributed to this speaker'
      : 'No playable speech is available for this speaker.';
    button.addEventListener('click', () => toggleSpeakerPreview(analysis, detection, button));
    return button;
  }

  function matchedSpeakerRow(analysis, detection) {
    const row = document.createElement('div'); row.className = 'speaker-row speaker-matched';
    const info = document.createElement('div'); info.className = 'speaker-row-info';
    const name = document.createElement('strong'); name.textContent = detection.display_name;
    const profile = (state.speakerProfiles || []).find((item) => item.id === detection.profile_id);
    const samples = profile ? profile.sample_count + '/' + profile.max_samples + ' samples' : '';
    const meta = document.createElement('span'); meta.className = 'muted small-note';
    meta.textContent = ['Matched', speechLength(detection.speech_seconds), samples].filter(Boolean).join(' · ');
    info.append(name, meta);

    const actions = document.createElement('div'); actions.className = 'speaker-row-actions';
    actions.appendChild(hearButton(analysis, detection));
    const saved = Boolean(profile?.samples?.some((sample) => sample.source_detection_id === detection.id));
    if (saved) {
      const done = document.createElement('span'); done.className = 'sample-saved small-note';
      done.textContent = '✓ Sample saved';
      done.title = 'This conversation is already one of ' + detection.display_name + '’s voice samples.';
      actions.appendChild(done);
    } else {
      const add = document.createElement('button'); add.type = 'button'; add.className = 'quiet';
      add.textContent = '+ Add sample';
      const full = Boolean(profile && profile.sample_count >= profile.max_samples);
      add.disabled = !detection.can_remember || full;
      add.title = full
        ? detection.display_name + ' already has ' + profile.max_samples + ' samples. Remove one under Voices first.'
        : !detection.can_remember
          ? 'Needs at least 3 seconds of this person speaking.'
          : 'Add this conversation as another sample of ' + detection.display_name + '’s voice, so they are recognised more reliably.';
      add.setAttribute('aria-label', 'Add this clip to ' + detection.display_name + '’s voice');
      add.addEventListener('click', async () => {
        add.disabled = true;
        try {
          const result = await api(
            '/api/admin/speakers/analyses/' + analysis.id + '/detections/' + encodeURIComponent(detection.speaker_key) + '/remember',
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ name: detection.display_name }),
            },
          );
          showToast(result.already_saved
            ? detection.display_name + ' already has this sample'
            : detection.display_name + ' · voice sample ' + result.sample_count + '/' + (profile?.max_samples || 8) + ' saved');
          await loadSpeakerProfiles();
        } catch (error) {
          showToast(error.message);
          add.disabled = false;
        }
      });
      actions.appendChild(add);
    }
    row.append(info, actions);
    return row;
  }

  function unnamedSpeakerCard(analysis, detection) {
    const card = document.createElement('div'); card.className = 'speaker-row speaker-unnamed';
    const top = document.createElement('div'); top.className = 'speaker-unnamed-top';
    const info = document.createElement('div'); info.className = 'speaker-row-info';
    const name = document.createElement('strong'); name.textContent = detection.display_name;
    const isDefaultName = /^Person \d+$/.test(detection.display_name);
    const chip = document.createElement('span'); chip.className = 'chip chip-notes chip-inline';
    chip.textContent = isDefaultName ? 'Unnamed' : 'Not remembered';
    name.appendChild(chip);
    const meta = document.createElement('span'); meta.className = 'muted small-note'; meta.textContent = speechLength(detection.speech_seconds);
    info.append(name, meta);
    top.append(info, hearButton(analysis, detection));

    const pickId = 'voicePick-' + detection.id;
    const pickLabel = document.createElement('label'); pickLabel.className = 'admin-label'; pickLabel.htmlFor = pickId;
    pickLabel.textContent = 'Who is this?';
    const pick = document.createElement('select'); pick.id = pickId;
    const blank = document.createElement('option'); blank.value = ''; blank.textContent = 'Choose a remembered voice…';
    pick.appendChild(blank);
    const profiles = [...(state.speakerProfiles || [])].sort((a, b) => a.name.localeCompare(b.name));
    for (const profile of profiles) {
      const option = document.createElement('option'); option.value = profile.name; option.textContent = profile.name;
      pick.appendChild(option);
    }
    const newOption = document.createElement('option'); newOption.value = '__new'; newOption.textContent = 'New name…';
    pick.appendChild(newOption);

    const newId = 'voiceNew-' + detection.id;
    const newLabel = document.createElement('label'); newLabel.className = 'admin-label'; newLabel.htmlFor = newId;
    newLabel.textContent = 'New name'; newLabel.hidden = true;
    const newName = document.createElement('input'); newName.id = newId; newName.type = 'text'; newName.placeholder = 'e.g. Jordan';
    newName.autocomplete = 'off';
    if (!isDefaultName) newName.value = detection.display_name;
    newLabel.appendChild(newName);
    pick.addEventListener('change', () => {
      newLabel.hidden = pick.value !== '__new';
      if (!newLabel.hidden) newName.focus();
    });

    const actions = document.createElement('div'); actions.className = 'speaker-unnamed-actions';
    const apply = document.createElement('button'); apply.type = 'button'; apply.className = 'primary small'; apply.textContent = 'Apply name';
    const rememberLabel = document.createElement('label'); rememberLabel.className = 'check small-note';
    const remember = document.createElement('input'); remember.type = 'checkbox';
    remember.checked = Boolean(detection.can_remember);
    remember.disabled = !detection.can_remember;
    rememberLabel.append(remember, document.createTextNode(' Add to voiceprint'));
    if (!detection.can_remember) rememberLabel.title = 'Needs at least 3 seconds of this person speaking.';
    actions.append(apply, rememberLabel);

    apply.addEventListener('click', async () => {
      const chosen = pick.value === '__new' ? newName.value.trim() : pick.value;
      if (!chosen) {
        showToast(pick.value === '__new' ? 'Type the new name first' : 'Choose a voice or New name…');
        return;
      }
      apply.disabled = true;
      const base = '/api/admin/speakers/analyses/' + analysis.id + '/detections/' + encodeURIComponent(detection.speaker_key);
      try {
        if (remember.checked && detection.can_remember) {
          const saved = await api(base + '/remember', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: chosen }),
          });
          showToast(saved.already_saved ? chosen + ' already has this sample' : chosen + ' · voice sample ' + saved.sample_count + '/8 saved');
          await loadSpeakerProfiles();
        } else {
          await api(base, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ display_name: chosen }),
          });
          showToast('Named ' + chosen);
        }
        await refreshCurrentSpeakerAnalysis();
      } catch (error) {
        showToast(error.message);
        apply.disabled = false;
      }
    });

    card.append(top, pickLabel, pick, newLabel, actions);
    return card;
  }

  function renderNotesStep(recording, analysis, notes) {
    const llmConfigured = Boolean(state.meetingNotesStatus?.llm?.configured);
    const busy = ACTIVE_JOB.includes(notes?.status);
    const regenerating = busy && !sendingOnly(notes);
    const hasNotes = Boolean(notes?.has_notes);
    const unnamed = unnamedDetections(analysis).length;

    if (regenerating) stepChip(els.stepNotesChip, 'chip-todo', 'Working…');
    else if (hasNotes) stepChip(els.stepNotesChip, 'chip-analysed', 'Ready');
    else if (analysis) stepChip(els.stepNotesChip, 'chip-notes', 'Next');
    else stepChip(els.stepNotesChip, 'chip-todo', 'Waiting');

    els.stepNotesHint.textContent = !llmConfigured
      ? 'Set LLM_BASE_URL to your llama-server to generate notes.'
      : !analysis
        ? 'No speaker analysis yet: lines will say Unidentified and action items won’t have owners.'
        : unnamed
          ? 'Name the unnamed speaker' + (unnamed === 1 ? '' : 's') + ' first so their action items have an owner.'
          : 'Uses the names from step 1.';
    els.meetingNotesGenerateButton.textContent = hasNotes ? 'Regenerate notes' : 'Generate notes';
    els.meetingNotesGenerateButton.disabled = !llmConfigured || busy;
    els.meetingNotesGenerateButton.classList.toggle('primary', !hasNotes);

    let message = '';
    if (regenerating) message = (notes.stage || 'Queued') + '…';
    else if (busy) message = 'Notes are being sent to Open Notebook…';
    else if (notes?.status === 'error') message = 'Failed: ' + (notes.error || 'unknown error');
    else if (hasNotes && notes.notes_generated_at) {
      message = 'Generated ' + friendlyDate(notes.notes_generated_at) + (notes.processing_seconds ? ' · ' + notes.processing_seconds + 's' : '');
    }
    els.meetingNotesMessage.textContent = message;
    els.meetingNotesMessage.classList.toggle('speaker-alert', notes?.status === 'error');

    els.meetingNotesPreview.textContent = notes?.notes_markdown || '';
    els.meetingNotesPreview.hidden = !hasNotes;
    els.meetingNotesEmpty.hidden = hasNotes;
    els.meetingNotesModel.textContent = notes?.model || state.meetingNotesStatus?.llm?.model || '';
    els.meetingNotesDownloadButton.disabled = !hasNotes;
  }

  function renderNotebookStep(notes) {
    const configured = Boolean(state.meetingNotesStatus?.open_notebook?.configured);
    const busy = ACTIVE_JOB.includes(notes?.status);
    const hasNotes = Boolean(notes?.has_notes);
    const exported = Boolean(notes?.exported);
    const outdated = Boolean(notes?.export_outdated);

    if (sendingOnly(notes)) stepChip(els.stepNotebookChip, 'chip-todo', 'Sending…');
    else if (exported && outdated) stepChip(els.stepNotebookChip, 'chip-notes', 'Out of date');
    else if (exported) stepChip(els.stepNotebookChip, 'chip-sent', 'Sent');
    else if (hasNotes) stepChip(els.stepNotebookChip, 'chip-notes', 'Next');
    else stepChip(els.stepNotebookChip, 'chip-todo', 'Waiting');

    const where = notes?.open_notebook_notebook_name ? ' · ' + notes.open_notebook_notebook_name : '';
    const when = notes?.exported_at ? ' · sent ' + friendlyDate(notes.exported_at) : '';
    els.meetingNotesLinkRow.classList.toggle('is-sent', exported && !outdated);
    els.meetingNotesLinkRow.classList.toggle('outdated', exported && outdated);
    els.meetingNotesExportBadgeText.textContent = exported
      ? (outdated ? '⚠ In Open Notebook' + where + when + ' · newer notes not sent yet' : '✓ In Open Notebook' + where + when)
      : 'Not sent yet';
    const uiUrl = state.meetingNotesStatus?.open_notebook?.ui_url;
    const notebookId = notes?.open_notebook_notebook_id;
    els.meetingNotesLink.hidden = !(exported && uiUrl && notebookId);
    if (uiUrl && notebookId) els.meetingNotesLink.href = uiUrl + '/notebooks/' + encodeURIComponent(notebookId);

    els.meetingNotesResendButton.textContent = exported ? 'Re-send to notebook…' : 'Send to notebook…';
    els.meetingNotesResendButton.disabled = !configured || !hasNotes || busy;
    els.meetingNotesResendButton.classList.toggle('primary', hasNotes && (!exported || outdated));
    els.stepNotebookFoot.textContent = !configured
      ? 'Set OPEN_NOTEBOOK_URL to enable sending.'
      : !hasNotes ? 'Available once notes are ready.' : '';
  }

  async function runSpeakerAnalysis(numSpeakers) {
    const recording = currentMeeting();
    if (!recording || state.meetings.analysingId) return;
    state.meetings.analysingId = recording.id;
    state.meetings.analysisError = '';
    state.meetings.analysisStage = 'Starting speaker analysis…';
    state.meetings.showTurns = false;
    renderMeetingDetail();
    try {
      const job = await api('/api/admin/speakers/analyze/' + recording.id, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ num_speakers: numSpeakers }),
      });
      for (let attempt = 0; attempt < 900; attempt += 1) {
        const analysis = await api('/api/admin/speakers/analyses/' + job.id, { cache: 'no-store' });
        if (analysis.status === 'completed') {
          Object.assign(recording, {
            analysed: true,
            latest_analysis_id: analysis.id,
            speaker_count: analysis.speaker_count,
          });
          if (state.meetings.selectedId === recording.id) state.meetings.analysis = analysis;
          showToast(analysis.speaker_count + ' speaker' + (analysis.speaker_count === 1 ? '' : 's') + ' found');
          return;
        }
        if (analysis.status === 'error') throw new Error(analysis.error || 'Speaker analysis failed.');
        state.meetings.analysisStage = analysis.status === 'queued'
          ? 'Waiting for the speaker analyzer…'
          : 'Finding speakers and transcribing their turns…';
        if (state.meetings.selectedId === recording.id) renderMeetingDetail();
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
      throw new Error('Analysis is still running. Come back to this conversation shortly.');
    } catch (error) {
      if (state.meetings.selectedId === recording.id) state.meetings.analysisError = error.message;
    } finally {
      state.meetings.analysingId = null;
      renderMeetingsList();
      if (state.meetings.selectedId === recording.id) renderMeetingDetail();
    }
  }

  async function pollMeetingNotes(recordingId) {
    if (state.meetings.notesPolling === recordingId) return;
    state.meetings.notesPolling = recordingId;
    try {
      for (let attempt = 0; attempt < 900; attempt += 1) {
        const result = await api('/api/admin/meeting-notes/recordings/' + recordingId, { cache: 'no-store' });
        if (state.meetings.selectedId === recordingId) {
          state.meetings.notes = result;
          renderMeetingDetail();
        }
        if (!ACTIVE_JOB.includes(result.status)) {
          if (result.status === 'completed') {
            showToast(result.export_requested ? 'Sent to Open Notebook' : 'Meeting notes ready');
          }
          state.meetings.jobKind = null;
          await refreshMeetingsList();
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    } catch (error) {
      if (state.meetings.selectedId === recordingId) els.meetingNotesMessage.textContent = error.message;
    } finally {
      if (state.meetings.notesPolling === recordingId) state.meetings.notesPolling = null;
    }
  }

  async function startMeetingNotes({ regenerate, exportToNotebook }) {
    const recordingId = meetingNotesRecordingId();
    if (!recordingId) return;
    const body = { regenerate_notes: regenerate, export: exportToNotebook };
    if (exportToNotebook) {
      const notebook = await chooseNotebook();
      if (!notebook) return;
      body.notebook_id = notebook.id;
      body.notebook_name = notebook.name;
    }
    if (regenerate && state.meetings.analysis?.recording_id === recordingId) {
      body.analysis_id = state.meetings.analysis.id;
    }
    state.meetings.jobKind = regenerate ? 'notes' : 'send';
    try {
      const job = await api('/api/admin/meeting-notes/recordings/' + recordingId, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (state.meetings.selectedId === recordingId) {
        state.meetings.notes = { ...(state.meetings.notes || {}), ...job };
        renderMeetingDetail();
      }
      await pollMeetingNotes(recordingId);
    } catch (error) {
      els.meetingNotesMessage.textContent = error.message;
    }
  }

  async function loadMeetingNotesStatus() {
    try {
      const status = await api('/api/admin/meeting-notes/status', { cache: 'no-store' });
      state.meetingNotesStatus = status;
      const llmInfo = status.llm || {};
      const notebook = status.open_notebook || {};
      if (!llmInfo.configured) setHealth('llm', 'off', 'Not set up', 'Set LLM_BASE_URL');
      else if (!llmInfo.reachable) setHealth('llm', 'bad', 'Not reachable', llmInfo.error || '');
      else if (llmInfo.model_available === false) setHealth('llm', 'bad', 'Model not loaded', llmInfo.model + ' is not on the server');
      else setHealth('llm', 'ok', 'Ready', llmInfo.model || '');
      if (!notebook.configured) setHealth('notebook', 'off', 'Not set up', 'Set OPEN_NOTEBOOK_URL');
      else if (!notebook.reachable) setHealth('notebook', 'bad', 'Not reachable', notebook.error || '');
      else setHealth('notebook', 'ok', 'Ready', notebook.notebook_count + ' notebook' + (notebook.notebook_count === 1 ? '' : 's'));
    } catch (error) {
      state.meetingNotesStatus = null;
      setHealth('llm', 'bad', 'Unknown', error.message || '');
      setHealth('notebook', 'bad', 'Unknown', error.message || '');
    }
    if (state.meetings.selectedId) renderMeetingDetail();
  }

  let notebookPickerNotebooks = [];

  async function loadNotebookPickerList(preferredId) {
    const list = els.notebookPickerList;
    list.replaceChildren();
    els.notebookPickerConfirmButton.disabled = true;
    els.notebookPickerMessage.textContent = 'Loading notebooks from Open Notebook…';
    els.notebookPickerMessage.classList.remove('speaker-alert');
    try {
      const payload = await api('/api/admin/meeting-notes/notebooks', { cache: 'no-store' });
      notebookPickerNotebooks = payload.notebooks || [];
      if (!notebookPickerNotebooks.length) {
        els.notebookPickerMessage.textContent = 'No notebooks yet. Create one in Open Notebook, then refresh.';
        return;
      }
      const ids = notebookPickerNotebooks.map((item) => item.id);
      const selectedId = [preferredId, payload.default_notebook_id].find((id) => id && ids.includes(id)) || ids[0];
      for (const item of notebookPickerNotebooks) {
        const label = document.createElement('label');
        label.className = 'notebook-picker-option';
        const radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = 'notebookPickerChoice';
        radio.value = item.id;
        radio.checked = item.id === selectedId;
        const name = document.createElement('span');
        name.textContent = item.name;
        label.append(radio, name);
        const tags = [];
        if (item.id === preferredId) tags.push('last used');
        if (item.id === payload.default_notebook_id) tags.push('default');
        if (tags.length) {
          const tag = document.createElement('span');
          tag.className = 'muted';
          tag.textContent = tags.join(' · ');
          label.appendChild(tag);
        }
        list.appendChild(label);
      }
      els.notebookPickerMessage.textContent = notebookPickerNotebooks.length === 1
        ? '1 notebook available.'
        : notebookPickerNotebooks.length + ' notebooks available.';
      els.notebookPickerConfirmButton.disabled = false;
      list.querySelector('input:checked')?.focus();
    } catch (error) {
      notebookPickerNotebooks = [];
      els.notebookPickerMessage.textContent = error.message;
      els.notebookPickerMessage.classList.add('speaker-alert');
    }
  }

  function chooseNotebook() {
    const dialog = els.notebookPickerDialog;
    const preferredId = state.meetings.notes?.open_notebook_notebook_id || null;
    return new Promise((resolve) => {
      const onClose = () => {
        dialog.removeEventListener('close', onClose);
        if (dialog.returnValue !== 'confirm') { resolve(null); return; }
        const chosen = els.notebookPickerList.querySelector('input[name="notebookPickerChoice"]:checked');
        resolve(notebookPickerNotebooks.find((item) => item.id === chosen?.value) || null);
      };
      dialog.addEventListener('close', onClose);
      dialog.returnValue = '';
      dialog.showModal();
      loadNotebookPickerList(preferredId);
    });
  }

  function downloadMeetingNotes() {
    const recordingId = meetingNotesRecordingId();
    if (!recordingId) return;
    const link = document.createElement('a');
    link.href = '/api/admin/meeting-notes/recordings/' + recordingId + '/notes.md';
    link.download = '';
    document.body.appendChild(link);
    link.click();
    link.remove();
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

  function renderTurns(analysis) {
    stopSpeakerPreview();
    els.speakerAnalysisResult.replaceChildren();
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

    els.speakerAnalysisResult.append(conversation);
  }

  async function loadAdminStatus() {
    try {
      const status = await api('/api/admin/status', { cache: 'no-store' });
      els.retentionDays.value = String(status.retention?.audio_retention_days || 0);
      els.deleteAudioImmediately.checked = Boolean(status.retention?.delete_audio_after_transcription);
      els.retentionDays.disabled = els.deleteAudioImmediately.checked;

      setHealth('database', status.database ? 'ok' : 'bad', status.database ? 'Connected' : 'Problem', 'PostgreSQL');
      setHealth(
        'gateway',
        status.speech_gateway ? 'ok' : 'bad',
        status.speech_gateway ? 'Ready' : 'Not reachable',
        status.speech_gateway
          ? (status.speech_gateway_version ? 'v' + status.speech_gateway_version : 'Whisper + Piper')
          : 'Live transcription and read-aloud are down',
      );

      els.systemStatus.replaceChildren();
      for (const [label, value] of [
        ['Recordings', String(status.recordings)],
        ['Voice files', formatBytes(status.audio_bytes)],
        ['Recycle bin', String(status.recycle_bin)],
      ]) {
        const stat = document.createElement('div'); stat.className = 'storage-stat';
        const name = document.createElement('span'); name.className = 'muted small-note'; name.textContent = label;
        const val = document.createElement('strong'); val.textContent = value;
        stat.append(name, val);
        els.systemStatus.appendChild(stat);
      }

      els.backupNotice.replaceChildren();
      const notice = document.createElement('p');
      if (status.last_backup_at) {
        notice.className = 'backup-ok';
        notice.textContent = 'Last app backup downloaded ' + friendlyDate(status.last_backup_at) + '.';
      } else {
        notice.className = 'backup-warn';
        const strong = document.createElement('strong'); strong.textContent = 'No app backup downloaded yet. ';
        notice.append(strong, document.createTextNode('Your PostgreSQL backups still cover the database.'));
      }
      els.backupNotice.appendChild(notice);
    } catch (error) {
      setHealth('database', 'bad', 'Unknown', error.message || '');
      setHealth('gateway', 'bad', 'Unknown', error.message || '');
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
    try {
      const records = await api('/api/admin/recycle-bin', { cache: 'no-store' });
      renderRecycleBin(records);
    } catch (error) {
      els.recycleList.replaceChildren(tableMessageRow(4, error.message, 'error'));
    }
  }

  function renderRecycleBin(records) {
    els.recycleList.replaceChildren();
    if (!records.length) {
      els.recycleList.appendChild(tableMessageRow(4, 'Recycle bin is empty.'));
      return;
    }
    for (const record of records) {
      const row = document.createElement('tr');
      const titleCell = document.createElement('td');
      const title = document.createElement('strong'); title.textContent = record.title || 'Recording';
      const snippet = document.createElement('div'); snippet.className = 'muted small-note recycle-snippet';
      snippet.textContent = record.transcript.slice(0, 120) + (record.transcript.length > 120 ? '…' : '');
      titleCell.append(title, snippet);
      const deleted = document.createElement('td'); deleted.className = 'muted';
      deleted.textContent = record.deleted_at ? friendlyDate(record.deleted_at) : '';
      const words = document.createElement('td'); words.textContent = String(record.word_count);
      const actions = document.createElement('td'); actions.className = 'table-actions';
      const restore = document.createElement('button'); restore.type = 'button'; restore.className = 'quiet'; restore.textContent = 'Restore';
      restore.addEventListener('click', async () => {
        try {
          await api('/api/admin/recycle-bin/' + record.id + '/restore', { method: 'POST' });
          showToast('Recording restored');
          await Promise.all([loadRecycleBin(), loadAdminStatus(), refreshMeetingsList()]);
        } catch (error) { showToast(error.message); }
      });
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'quiet danger-text'; remove.textContent = 'Delete forever';
      remove.addEventListener('click', async () => {
        if (!confirm('Permanently delete this recording, its transcript history, saved voice audio and any Open Notebook copy? This cannot be undone.')) return;
        try {
          await api('/api/admin/recycle-bin/' + record.id, { method: 'DELETE' });
          showToast('Recording deleted');
          await Promise.all([loadRecycleBin(), loadAdminStatus()]);
        } catch (error) { showToast(error.message); }
      });
      actions.append(restore, remove);
      row.append(titleCell, deleted, words, actions);
      els.recycleList.appendChild(row);
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
  els.actAsSelect?.addEventListener('change', () => switchActAs(els.actAsSelect.value));
  els.stopActAsButton?.addEventListener('click', () => switchActAs(''));
    els.progressDays.addEventListener('change', () => { if (isAdmin()) loadProgress(); });
  for (const tab of TOOLS_TABS) {
    $('toolsTab-' + tab).addEventListener('click', () => setToolsTab(tab));
  }
  $('toolsTab-meetings').parentElement.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const index = TOOLS_TABS.indexOf(state.toolsTab || 'meetings');
    const next = event.key === 'Home' ? 0
      : event.key === 'End' ? TOOLS_TABS.length - 1
        : (index + (event.key === 'ArrowRight' ? 1 : -1) + TOOLS_TABS.length) % TOOLS_TABS.length;
    event.preventDefault();
    setToolsTab(TOOLS_TABS[next], true);
  });
  els.toolsRefreshButton.addEventListener('click', loadTools);
  for (const filter of ['todo', 'sent', 'all']) {
    $('meetingsFilter-' + filter).addEventListener('click', () => setMeetingsFilter(filter));
  }
  els.meetingsSearch.addEventListener('input', renderMeetingsList);
  els.meetingTurnsCloseButton.addEventListener('click', () => {
    state.meetings.showTurns = false;
    renderMeetingDetail();
  });
  els.voicesSearch.addEventListener('input', renderSpeakerProfiles);
  els.addUserToggleButton.addEventListener('click', () => toggleCreateUserForm(els.createUserForm.hidden));
  els.cancelCreateUserButton.addEventListener('click', () => toggleCreateUserForm(false));
  els.relabelPendingViewButton.addEventListener('click', () => setRelabelView('pending'));
  els.relabelHistoryViewButton.addEventListener('click', () => setRelabelView('history'));
  for (const control of [els.relabelFromDate, els.relabelToDate, els.relabelStatusFilter]) {
    control.addEventListener('change', () => loadRelabelSamples());
  }
  els.relabelClearFiltersButton.addEventListener('click', () => {
    els.relabelFromDate.value = '';
    els.relabelToDate.value = '';
    els.relabelStatusFilter.value = '';
    loadRelabelSamples();
  });
  els.meetingNotesGenerateButton.addEventListener('click', () => startMeetingNotes({ regenerate: true, exportToNotebook: false }));
  els.meetingNotesResendButton.addEventListener('click', () => startMeetingNotes({ regenerate: false, exportToNotebook: true }));
  els.meetingNotesDownloadButton.addEventListener('click', downloadMeetingNotes);
  els.notebookPickerRefreshButton.addEventListener('click', () => {
    const chosen = els.notebookPickerList.querySelector('input[name="notebookPickerChoice"]:checked');
    loadNotebookPickerList(chosen?.value || state.meetings.notes?.open_notebook_notebook_id);
  });
  document.addEventListener('click', (event) => {
    if (els.moreActions?.open && !els.moreActions.contains(event.target)) els.moreActions.open = false;
  });
  els.moreActions?.querySelectorAll('.actions button').forEach((button) => {
    button.addEventListener('click', () => { els.moreActions.open = false; });
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && els.moreActions?.open) {
      els.moreActions.open = false;
      els.moreActions.querySelector('summary')?.focus();
    }
  });
  els.createUserForm.addEventListener('submit', createUser);
  els.saveRetentionButton.addEventListener('click', saveRetention);
  els.applyRetentionButton.addEventListener('click', applyRetentionNow);
  els.refreshAdminButton.addEventListener('click', () => Promise.allSettled([
    loadAdminStatus(), loadSpeakerStatus(), loadMeetingNotesStatus(),
  ]));
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
