import gameManager from './game-manager.js';
import authManager from './auth-manager.js';
import { GAME_PHASES } from './game-states.js';

class UIManager {
  constructor() {
    this.currentPlayerData = null;
    this.allPlayers = [];
    this.activeListeners = [];
    this.globalUnsubscribe = null;
    this.globalUnsubscribe = null;
    this.globalPlayerUnsub = null;
    this.globalRoomUnsub = null;
    this.listeningToRoom = null;
  }

  // Initialize global listener - This survives cleanupListeners()
  init() {
    // Only initialize if we have a room
    if (!gameManager.currentRoom) return;

    // If we're already listening to this specific room, do nothing
    if (this.globalUnsubscribe && this.listeningToRoom === gameManager.currentRoom) {
      return;
    }

    if (this.globalUnsubscribe) this.globalUnsubscribe();
    if (this.globalPlayerUnsub) this.globalPlayerUnsub();
    if (this.globalRoomUnsub) this.globalRoomUnsub();

    this.listeningToRoom = gameManager.currentRoom;

    // Pre-populate currentPlayerData from restored session to avoid race condition
    if (gameManager.currentPlayer) {
      this.currentPlayerData = gameManager.currentPlayer;
    }

    // 0. Global Room Listener (Check for closure)
    this.globalRoomUnsub = gameManager.listenToRoom((snapshot) => {
      if (!snapshot.exists()) return;
      const data = snapshot.data();
      if (data.status === 'closed') {
        this.showRoomClosed();
      }
    });

    // 1. Game State Listener
    this.globalUnsubscribe = gameManager.subscribeToGameState((phase, role, state) => {
      this.renderScreen(phase, role, state);
    });

    // 2. Global Player Listener (Keeps isAlive/role statuses sync'd)
    this.globalPlayerUnsub = gameManager.listenToPlayers((snapshot) => {
      this.allPlayers = [];
      snapshot.forEach(doc => {
        const data = doc.data();
        this.allPlayers.push({ id: doc.id, ...data });

        // Sync current player data
        if (doc.id === authManager.getUserId()) {
          this.currentPlayerData = data;
        }
      });

      // Trigger updates for screens that need real-time player lists (Lobby, Vote, etc)
      // We can check the current phase and re-render partial UI if straightforward, 
      // or let the state listener handle major transitions.
      // For Lobby specifically, we often want instant updates.
      // Trigger updates for screens that need real-time player lists
      const lobbyList = document.getElementById('playersList');
      if (lobbyList) {
        this.updatePlayersList();
      }
    });
  }

  cleanupListeners() {
    this.activeListeners.forEach(item => {
      if (typeof item === 'function') {
        item();
      } else if (typeof item === 'number') {
        clearInterval(item);
      }
    });
    this.activeListeners = [];
  }

  // ========================================
  // UTILITY SCREENS
  // ========================================

  showLoading(message = 'Loading...') {
    document.getElementById('app').innerHTML = `
      <div class="screen loading-screen">
        <div class="loading-spinner"></div>
        <p>${message}</p>
      </div>
    `;
  }

  showWaiting(message) {
    document.getElementById('app').innerHTML = `
      <div class="screen waiting-screen">
        <div class="loading-spinner"></div>
        <p>${message}</p>
      </div>
    `;
  }

  // HOST MONITORING: If host is waiting during night actions, they must keep checking
  ensureHostMonitor(phase) {
    // Only Host runs this
    if (!gameManager.currentPlayer.isHost) return;

    // Avoid duplicates - check if we already have an interval? 
    // Since cleanupListeners() wipes activeListeners, we are safe to add one here 
    // IF renderScreen called cleanup (which it does).
    // However, showNightSpecial logic attaches specific listeners too.

    // We'll define a simpler global monitor that doesn't conflict with individual action checks.
    // Ideally, the monitor should be centralized.

    this.startHostMonitor();
  }

  startHostMonitor() {
    if (gameManager.currentPlayer.isHost) {
      // Clear existing monitor if any (to be safe against double calls)
      if (this.hostMonitorInterval) clearInterval(this.hostMonitorInterval);

      this.hostMonitorInterval = setInterval(async () => {
        const state = await gameManager.getState();
        if (!state) return;

        if (state.phase === GAME_PHASES.NIGHT_SPECIAL) {
          await gameManager.checkEDSubmitted();
        } else if (state.phase === GAME_PHASES.NIGHT_IMPOSTOR) {
          await gameManager.checkImpostorSubmitted();
        }
      }, 2000);

      this.activeListeners.push(this.hostMonitorInterval);
    }
  }

  // ========================================
  // HOME & LOBBY
  // ========================================

  showHome() {
    this.cleanupListeners();
    // Cleanup globals
    if (this.globalRoomUnsub) { this.globalRoomUnsub(); this.globalRoomUnsub = null; }
    if (this.globalPlayerUnsub) { this.globalPlayerUnsub(); this.globalPlayerUnsub = null; }
    if (this.globalUnsubscribe) { this.globalUnsubscribe(); this.globalUnsubscribe = null; }

    document.getElementById('app').innerHTML = `
      <div class="screen home-screen">
        <h1 class="logo">GNOSIA</h1>
        <p class="subtitle">Social Deduction Game</p>
        
        <div class="button-group">
          <button id="createRoomBtn" class="btn btn-primary btn-large">Create Room</button>
          <button id="joinRoomBtn" class="btn btn-secondary btn-large">Join Room</button>
        </div>
      </div>
    `;

    document.getElementById('createRoomBtn').addEventListener('click', () => this.showCreateRoom());
    document.getElementById('joinRoomBtn').addEventListener('click', () => this.showJoinRoom());
  }

  showCreateRoom() {
    document.getElementById('app').innerHTML = `
      <div class="screen create-room-screen">
        <h2>Create Room</h2>
        
        <div class="form-group">
          <label>Your Name</label>
          <input type="text" id="playerName" maxlength="20" placeholder="Enter your name" />
        </div>

        <div class="button-group">
          <button id="createBtn" class="btn btn-primary">Create</button>
          <button id="backBtn" class="btn btn-secondary">Back</button>
        </div>
      </div>
    `;

    document.getElementById('createBtn').addEventListener('click', async () => {
      const name = document.getElementById('playerName').value.trim();
      if (!name) {
        alert('Please enter your name');
        return;
      }

      this.showLoading('Creating room...');
      try {
        const roomCode = await gameManager.createRoom(name);
        this.showLobby();
      } catch (error) {
        console.error('Error creating room:', error);
        alert('Failed to create room');
        this.showHome();
      }
    });

    document.getElementById('backBtn').addEventListener('click', () => this.showHome());
  }

  showJoinRoom() {
    document.getElementById('app').innerHTML = `
      <div class="screen join-room-screen">
        <h2>Join Room</h2>
        
        <div class="form-group">
          <label>Your Name</label>
          <input type="text" id="playerName" maxlength="20" placeholder="Enter your name" />
        </div>

        <div class="form-group">
          <label>Room Code</label>
          <input type="text" id="roomCode" maxlength="4" placeholder="ABCD" style="text-transform: uppercase;" />
        </div>

        <div class="button-group">
          <button id="joinBtn" class="btn btn-primary">Join</button>
          <button id="backBtn" class="btn btn-secondary">Back</button>
        </div>
      </div>
    `;

    document.getElementById('joinBtn').addEventListener('click', async () => {
      const name = document.getElementById('playerName').value.trim();
      const code = document.getElementById('roomCode').value.trim().toUpperCase();

      if (!name || !code) {
        alert('Please fill all fields');
        return;
      }

      this.showLoading('Joining room...');
      try {
        await gameManager.joinRoom(code, name);
        this.showLobby();
      } catch (error) {
        console.error('Error joining room:', error);
        alert('Failed to join room. Room may not exist.');
        this.showJoinRoom();
      }
    });

    document.getElementById('backBtn').addEventListener('click', () => this.showHome());
  }

  showLobby() {
    this.cleanupListeners();
    this.init(); // Initialize global router if not already done
    const isHost = gameManager.currentPlayer.isHost;

    document.getElementById('app').innerHTML = `
      <div class="screen lobby-screen">
        <div class="room-header">
          <h2>Room: ${gameManager.currentRoom}</h2>
          <p class="player-count" id="playerCount">0 Players</p>
        </div>

        <div class="players-list" id="playersList"></div>

        ${isHost ? `
          <div class="settings-section">
            <h3>Game Settings</h3>
            
            <div class="settings-grid">
              <div class="setting-item">
                <label>Citizens</label>
                <input type="number" id="citizenCount" value="4" min="0" max="20" />
              </div>
              <div class="setting-item">
                <label>Impostors</label>
                <input type="number" id="impostorCount" value="2" min="1" max="10" />
              </div>
              <div class="setting-item">
                <label>Engineers</label>
                <input type="number" id="engineerCount" value="1" min="0" max="5" />
              </div>
              <div class="setting-item">
                <label>Doctors</label>
                <input type="number" id="doctorCount" value="1" min="0" max="5" />
              </div>
              <div class="setting-item">
                <label>Fallen Angels</label>
                <input type="number" id="fallenAngelCount" value="1" min="0" max="5" />
              </div>
              <div class="setting-item">
                <label>Guard Duty</label>
                <input type="number" id="guardDutyCount" value="0" min="0" max="5" />
              </div>
              <div class="setting-item">
                <label>Impostor Follower</label>
                <input type="number" id="impostorFollowerCount" value="0" min="0" max="5" />
              </div>
              <div class="setting-item">
                <label>Bug</label>
                <input type="number" id="bugCount" value="0" min="0" max="5" />
              </div>
            </div>

            <div class="timer-settings">
              <div class="setting-item">
                <label>Meeting Timer (seconds)</label>
                <input type="number" id="meetingTimer" value="300" min="60" max="600" />
              </div>
              <div class="setting-item">
                <label>Vote Timer (seconds)</label>
                <input type="number" id="voteTimer" value="60" min="30" max="120" />
              </div>
              <div class="setting-item">
                <label>Break Timer (seconds)</label>
                <input type="number" id="breakTimer" value="120" min="30" max="300" />
              </div>
            </div>
          </div>

          <button id="startGameBtn" class="btn btn-primary btn-large">Start Game</button>
        ` : `
          <p class="waiting-text">Waiting for host to start...</p>
        `}
      </div>
    `;

    // Players listener is now global (init)
    this.updatePlayersList();

    // Attach Global UI
    this.attachGlobalUI();

    if (isHost) {
      document.getElementById('startGameBtn').addEventListener('click', async () => {
        const settings = {
          roles: {
            citizen: parseInt(document.getElementById('citizenCount').value),
            impostor: parseInt(document.getElementById('impostorCount').value),
            engineer: parseInt(document.getElementById('engineerCount').value),
            doctor: parseInt(document.getElementById('doctorCount').value),
            fallen_angel: parseInt(document.getElementById('fallenAngelCount').value),
            guard_duty: parseInt(document.getElementById('guardDutyCount').value),
            impostor_follower: parseInt(document.getElementById('impostorFollowerCount').value),
            bug: parseInt(document.getElementById('bugCount').value)
          },
          timers: {
            meeting: parseInt(document.getElementById('meetingTimer').value),
            vote: parseInt(document.getElementById('voteTimer').value),
            break: parseInt(document.getElementById('breakTimer').value)
          }
        };

        const totalRoles = Object.values(settings.roles).reduce((a, b) => a + b, 0);
        if (totalRoles !== this.allPlayers.length) {
          alert(`Total roles (${totalRoles}) must match player count (${this.allPlayers.length})`);
          return;
        }

        if (settings.roles.impostor < 1) {
          alert('Must have at least 1 impostor');
          return;
        }

        this.showLoading('Starting game...');
        try {
          await gameManager.updateSettings(settings);
          await gameManager.startGame();
        } catch (error) {
          console.error('Failed to start game:', error);
          alert('Failed to start game: ' + error.message);
          this.showLobby();
        }
      });

      // Load config initially
      this.loadSavedConfig();

      // Setup Auto-Save for all settings inputs
      const settingsInputs = document.querySelectorAll('.settings-section input');
      settingsInputs.forEach(input => {
        input.addEventListener('input', () => this.autoSaveConfig());
      });
    }
  }

  autoSaveConfig() {
    const config = {
      citizen: parseInt(document.getElementById('citizenCount')?.value) || 4,
      impostor: parseInt(document.getElementById('impostorCount')?.value) || 2,
      engineer: parseInt(document.getElementById('engineerCount')?.value) || 1,
      doctor: parseInt(document.getElementById('doctorCount')?.value) || 1,
      fallen_angel: parseInt(document.getElementById('fallenAngelCount')?.value) || 1,
      guard_duty: parseInt(document.getElementById('guardDutyCount')?.value) || 0,
      impostor_follower: parseInt(document.getElementById('impostorFollowerCount')?.value) || 0,
      bug: parseInt(document.getElementById('bugCount')?.value) || 0,
      meetingTimer: parseInt(document.getElementById('meetingTimer')?.value) || 300,
      voteTimer: parseInt(document.getElementById('voteTimer')?.value) || 60,
      breakTimer: parseInt(document.getElementById('breakTimer')?.value) || 120
    };
    localStorage.setItem('gnosiaConfig', JSON.stringify(config));
    console.log('[Config] Auto-saved');
  }

  loadSavedConfig() {
    const saved = localStorage.getItem('gnosiaConfig');
    if (!saved) return;

    try {
      const config = JSON.parse(saved);
      const fields = {
        'citizenCount': config.citizen,
        'impostorCount': config.impostor,
        'engineerCount': config.engineer,
        'doctorCount': config.doctor,
        'fallenAngelCount': config.fallen_angel,
        'guardDutyCount': config.guard_duty,
        'impostorFollowerCount': config.impostor_follower,
        'bugCount': config.bug,
        'meetingTimer': config.meetingTimer,
        'voteTimer': config.voteTimer,
        'breakTimer': config.breakTimer
      };

      for (const [id, value] of Object.entries(fields)) {
        const el = document.getElementById(id);
        if (el && value !== undefined) {
          el.value = value;
        }
      }
      console.log('[Config] Loaded from auto-save');
    } catch (e) {
      console.error('[Config] Failed to load saved config', e);
    }
  }

  updatePlayersList() {
    const playersList = document.getElementById('playersList');
    const playerCount = document.getElementById('playerCount');

    if (!playersList) return;

    playerCount.textContent = `${this.allPlayers.length} Players`;

    playersList.innerHTML = this.allPlayers.map(player => `
      <div class="player-item">
        <span class="player-name">${player.name}</span>
        ${player.isHost ? '<span class="host-badge">HOST</span>' : ''}
        ${gameManager.currentPlayer.isHost && player.id !== authManager.getUserId() ?
        `<button class="btn-kick" data-player-id="${player.id}">Kick</button>` : ''}
      </div>
    `).join('');

    if (gameManager.currentPlayer.isHost) {
      document.querySelectorAll('.btn-kick').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          const playerId = e.target.dataset.playerId;
          if (confirm('Kick this player?')) {
            await gameManager.kickPlayer(playerId);
          }
        });
      });
    }
  }

  // ========================================
  // STATE ROUTER (STRICT RENDER LOGIC)
  // ========================================

  renderScreen(phase, role, state) {
    console.log(`[UI] Render: ${phase} for role ${role}`);

    this.cleanupListeners(); // Clear previous screen listeners/intervals

    switch (phase) {
      case GAME_PHASES.LOBBY:
        this.showLobby();
        break;

      case GAME_PHASES.ROLE_REVEAL:
        this.showRoleReveal();
        break;

      case GAME_PHASES.MEETING_DISCUSSION:
        this.showMeeting();
        break;

      case GAME_PHASES.VOTING:
        this.showVoting();
        break;

      case GAME_PHASES.VOTE_RESULT:
        this.showVoteResult(state);
        break;

      case GAME_PHASES.BREAK:
        this.showBreak(state);
        break;

      case GAME_PHASES.NIGHT_SPECIAL:
        this.showNightSpecial(role);
        break;

      case GAME_PHASES.NIGHT_IMPOSTOR:
        this.showNightImpostor();
        break;

      case GAME_PHASES.MORNING_ANNOUNCEMENT:
        // state.victims is an array of victim IDs
        const victimId = state.victims && state.victims.length > 0 ? state.victims[0] : null;
        this.showMorning(victimId);
        break;

      case GAME_PHASES.GAME_RESULT:
        this.showGameEnd(state.winner);
        break;

      default:
        console.warn(`Unknown phase: ${phase}`);
        this.showWaiting('Waiting for server...');
    }

    // Host Monitor Fallback:
    // If I am Host and I am NOT involved in the current phase (e.g. dead engineer),
    // I still need to run the checks to advance the game.
    if (this.currentPlayerData && this.currentPlayerData.isHost) {
      if (phase === GAME_PHASES.NIGHT_SPECIAL || phase === GAME_PHASES.NIGHT_IMPOSTOR) {
        // Check if we already have a monitor running? 
        // activeListeners usually cleared.
        // But we don't want double intervals if showNightSpecial also starts one.
        // Let's rely on showNightSpecial/showNightImpostor to start it IF they render an action screen.
        // BUT if they show "Sleep" (dead/wrong role), we must start it here.

        // Actually, safest way is to clear intervals in renderScreen and start ONE monitor if Host.
        this.ensureHostMonitor(phase);
      }
    }

    // Attach global UI (Leave Button) to every screen
    this.attachGlobalUI();
  }

  attachGlobalUI() {
    // Check if button already exists in current render
    if (document.getElementById('globalLeaveBtn')) return;

    const btn = document.createElement('button');
    btn.id = 'globalLeaveBtn';
    btn.className = 'btn btn-secondary btn-small floating-leave-btn';
    btn.innerText = 'Leave Room';
    btn.onclick = async () => {
      if (confirm('Are you sure you want to leave the room?')) {
        await gameManager.leaveRoom();
        this.showHome();
      }
    };

    document.getElementById('app').appendChild(btn);
  }

  showRoomClosed() {
    this.cleanupListeners();
    document.getElementById('app').innerHTML = `
        <div class="screen result-screen">
            <h1>Room Closed</h1>
            <p class="instruction">The host has left the game.</p>
            <button id="goHomeBtn" class="btn btn-primary btn-large">Back to Home</button>
        </div>
    `;
    document.getElementById('goHomeBtn').addEventListener('click', () => {
      gameManager.clearSession();
      this.showHome();
    });
  }

  // ========================================
  // ROLE_SHOW SCREENS
  // ========================================

  showRoleReveal() {
    this.cleanupListeners();

    this.renderRoleReveal();
  }

  renderRoleReveal() {
    const role = this.currentPlayerData.role;
    const myId = authManager.getUserId();

    // Find partners (others with same role)
    // We explicitly exclude Citizen because they are not supposed to know each other
    let partnersHtml = '';

    // Logic for showing partners/info
    let targetRoleToSee = null;
    let label = '';

    if (role === 'impostor') {
      targetRoleToSee = 'impostor';
      label = 'Allies';
    } else if (role === 'guard_duty') {
      targetRoleToSee = 'guard_duty';
      label = 'Partner';
    }

    if (targetRoleToSee) {
      const targets = this.allPlayers.filter(p => p.role === targetRoleToSee && p.id !== myId);
      if (targets.length > 0) {
        const names = targets.map(p => p.name).join(', ');
        partnersHtml = `
            <div class="partners-section">
                <p class="partners-label">${label}:</p>
                <p class="partners-list">${names}</p>
          </div>
        `;
      }
    }

    const roleNames = {
      citizen: 'Citizen',
      impostor: 'Impostor',
      engineer: 'Engineer',
      doctor: 'Doctor',
      fallen_angel: 'Fallen Angel',
      guard_duty: 'Guard Duty',
      impostor_follower: 'Impostor Follower',
      bug: 'Bug'
    };

    const roleDescriptions = {
      citizen: 'Find and eliminate the impostors',
      impostor: 'Eliminate citizens without being caught',
      engineer: 'Check one living player\'s role each night',
      doctor: 'Check all dead players\' roles each night',
      fallen_angel: 'Protect one player from attacks each night',
      guard_duty: 'You can prove your innocence. Open "Show Players" and tap your name to reveal your role.',
      impostor_follower: 'Human who sides with the Impostors',
      bug: 'Survive until the end to destroy the universe'
    };

    document.getElementById('app').innerHTML = `
      <div class="screen role-reveal-screen">
        <h1>Your Role</h1>
        <div class="role-card ${role}">
          <h2>${roleNames[role]}</h2>
          <p>${roleDescriptions[role]}</p>
          ${partnersHtml}
        </div>
        <button id="okBtn" class="btn btn-primary btn-large">OK</button>
      </div>
    `;

    document.getElementById('okBtn').addEventListener('click', async () => {
      await gameManager.markRoleAsRead();
      this.showWaiting('Waiting for all players...');

      // Host checks if all players confirmed
      if (gameManager.currentPlayer.isHost) {
        const checkInterval = setInterval(async () => {
          const allConfirmed = await gameManager.checkAllPlayersReadRole();
          if (allConfirmed) {
            clearInterval(checkInterval);
          }
        }, 1000);
      }
    });

    // Auto-confirm if already read (e.g., after refresh)
    if (this.currentPlayerData.roleReadConfirmed) {
      (async () => {
        await gameManager.markRoleAsRead();
        this.showWaiting('Waiting for all players...');

        if (gameManager.currentPlayer.isHost) {
          const checkInterval = setInterval(async () => {
            const allConfirmed = await gameManager.checkAllPlayersReadRole();
            if (allConfirmed) {
              clearInterval(checkInterval);
            }
          }, 1000);
        }
      })();
    }
  }

  showWaitingForConfirmation() {
    this.showWaiting('Waiting for all players to read their roles...');
  }

  // ========================================
  // MEETING SCREENS
  // ========================================

  async showMeeting() {
    this.cleanupListeners();
    const isHost = gameManager.currentPlayer.isHost;

    // Fetch previous votes
    const votes = await gameManager.getVotes();
    let voteHistoryHtml = '';

    if (votes.length > 0) {
      const historyItems = votes.map(v => {
        const voter = this.allPlayers.find(p => p.id === v.voterId)?.name || 'Unknown';
        const target = this.allPlayers.find(p => p.id === v.targetId)?.name || 'Unknown';
        return `<div class="vote-record"><span class="voter">${voter}</span> ➔ <span class="target">${target}</span></div>`;
      }).join('');

      voteHistoryHtml = `
            <div class="vote-history-section">
                <h3>Last Vote</h3>
                <div class="vote-history-list">
                    ${historyItems}
                </div>
            </div>
        `;
    }

    document.getElementById('app').innerHTML = `
      <div class="screen meeting-screen">
        <h1>Meeting</h1>
        <div class="timer" id="timer">5:00</div>
        <p class="instruction">Discuss offline who might be the impostor</p>
        
        <div class="button-row" style="margin-bottom: 1rem; display: flex; gap: 10px; justify-content: center;">
            <button id="showPlayersBtn" class="btn btn-secondary">Show Players</button>
            <button id="showVoteHistoryBtn" class="btn btn-secondary">Vote History</button>
        </div>

        ${isHost ? `
          <button id="voteBtn" class="btn btn-primary btn-large">Start Voting</button>
        ` : `
          <p class="waiting-text">Waiting for host to start voting...</p>
        `}

        ${voteHistoryHtml}
      </div>
    `;

    document.getElementById('showPlayersBtn').addEventListener('click', () => {
      this.showPlayerStatusModal();
    });

    document.getElementById('showVoteHistoryBtn').addEventListener('click', () => {
      this.showVoteHistoryModal();
    });

    if (isHost) {
      document.getElementById('voteBtn').addEventListener('click', async () => {
        await gameManager.transitionToVoting();
      });
    }

    const timerListener = gameManager.listenToTimer((snapshot) => {
      const data = snapshot.val();
      if (data && data.phase === 'meeting') {
        const timerEl = document.getElementById('timer');
        if (timerEl) {
          timerEl.textContent = this.formatTime(data.remaining);
        }
      }
    });
    this.activeListeners.push(timerListener);
  }

  showBreak(state) {
    this.cleanupListeners();
    const isHost = gameManager.currentPlayer.isHost;

    // Show vote result if available
    const voteResult = state.voteVictimName ? `
      <div class="vote-result">
        <p class="victim-name">${state.voteVictimName}</p>
        <p class="instruction">was put in cold sleep</p>
      </div>
    ` : '';

    document.getElementById('app').innerHTML = `
      <div class="screen break-screen">
        <h1>Break</h1>
        ${voteResult}
        <div class="timer" id="timer">2:00</div>
        <p class="instruction">Take a break</p>
        
        ${isHost ? `
          <button id="nightBtn" class="btn btn-primary btn-large">Start Night</button>
        ` : ''}
      </div>
    `;

    if (isHost) {
      document.getElementById('nightBtn').addEventListener('click', async () => {
        await gameManager.transitionToNight();
      });
    }

    const timerListener = gameManager.listenToTimer((snapshot) => {
      const data = snapshot.val();
      if (data && data.phase === 'break') {
        const timerEl = document.getElementById('timer');
        if (timerEl) {
          timerEl.textContent = this.formatTime(data.remaining);
        }
      }
    });
    this.activeListeners.push(timerListener);
  }

  // ========================================
  // VOTING SCREENS
  // ========================================

  showVoting() {
    this.cleanupListeners();
    // Use all players (Requirement: show list of all players)
    const voteTargets = this.allPlayers;

    // Check if I am alive
    const amIAlive = this.currentPlayerData && this.currentPlayerData.isAlive;
    const myId = authManager.getUserId();
    const myRole = this.currentPlayerData ? this.currentPlayerData.role : null;

    document.getElementById('app').innerHTML = `
      <div class="screen voting-screen">
        <h1>Vote</h1>
        <p class="instruction">${amIAlive ? 'Select who to put in cold sleep' : 'You are deceased and cannot vote'}</p>
        
        <div class="vote-list" id="voteList">
          ${voteTargets.map(player => {
      const isMe = player.id === myId;
      const isDeceased = !player.isAlive;

      // Impostor check: Allow voting for ally but warn
      const isAlly = myRole === 'impostor' && player.role === 'impostor' && !isMe;

      const isDisabled = isDeceased || !amIAlive || isMe;

      let label = '';
      if (isMe) label = '(You)';
      else if (isDeceased) label = '(Deceased)';
      else if (isAlly) label = '(Ally)';

      return `
            <button class="vote-item ${isDeceased ? 'deceased' : ''}" 
                    data-player-id="${player.id}"
                    ${isDisabled ? 'disabled' : ''}>
              ${player.name} ${label}
            </button>
          `}).join('')}
        </div>
      </div>
    `;

    // Only attach listeners if I'm alive
    if (amIAlive) {
      document.querySelectorAll('.vote-item').forEach(btn => {
        if (!btn.disabled) {
          btn.addEventListener('click', async (e) => {
            const button = e.target.closest('.vote-item');
            const id = button.dataset.playerId;
            const name = button.innerText;

            // Check if voting for ally
            const target = voteTargets.find(p => p.id === id);
            const isTargetAlly = myRole === 'impostor' && target.role === 'impostor';

            let confirmMsg = `Vote for ${name}?`;
            if (isTargetAlly) {
              confirmMsg = `WARNING: You are voting for your ally (Gnosia)! Are you sure you want to vote for ${target.name}?`;
            }

            if (confirm(confirmMsg)) {
              await gameManager.submitVote(id);
              this.showWaiting('Vote submitted. Waiting for others...');

              if (gameManager.currentPlayer.isHost) {
                const checkInterval = setInterval(async () => {
                  const allVoted = await gameManager.checkAllVoted();
                  if (allVoted) {
                    clearInterval(checkInterval);
                  }
                }, 1000);
                this.activeListeners.push(checkInterval);
              }
            }
          });
        }
      });
    }
  }

  showTieResult(tiedPlayers) {
    const tiedNames = tiedPlayers.map(id => {
      const player = this.allPlayers.find(p => p.id === id);
      return player ? player.name : 'Unknown';
    }).join(', ');

    document.getElementById('app').innerHTML = `
      <div class="screen result-screen">
        <h1>Vote Tied</h1>
        <p class="instruction">Tied between:</p>
        <p class="victim-name">${tiedNames}</p>
        <p class="instruction">Revoting...</p>
        
        ${gameManager.currentPlayer.isHost ? `
            <button id="nextBtn" class="btn btn-primary btn-large">Next</button>
        ` : `
            <p class="waiting-text">Waiting for host...</p>
        `}
      </div>
    `;

    if (gameManager.currentPlayer.isHost) {
      document.getElementById('nextBtn').addEventListener('click', async () => {
        await gameManager.proceedAfterVote();
      });
    }
  }

  // ========================================
  // HELPER SCREENS
  // ========================================

  showActionConfirmation(message, onConfirm, onCancel) {
    document.getElementById('app').innerHTML = `
      <div class="screen confirmation-screen">
        <h2>Confirm Action</h2>
        <p class="instruction">${message}</p>
        <div class="button-group">
            <button id="btnConfirmYes" class="btn btn-primary btn-large">Yes</button>
            <button id="btnConfirmNo" class="btn btn-secondary">No</button>
        </div>
      </div>
    `;

    document.getElementById('btnConfirmYes').addEventListener('click', onConfirm);
    document.getElementById('btnConfirmNo').addEventListener('click', onCancel);
  }

  // ========================================
  // RESULT SCREENS (NIGHT)
  // ========================================

  async showVoteResult(state) {
    // 1. Play Animation first
    await this.playVoteAnimation(state);

    // 2. Show Final Result
    this.renderFinalVoteResult(state);
  }

  async playVoteAnimation(state) {
    // Filter alive players + the victim (who just died)
    const targets = this.allPlayers.filter(p => p.isAlive || (state.result === 'killed' && p.id === state.victimId));
    const voteCounts = state.voteCounts || {};

    document.getElementById('app').innerHTML = `
      <div class="screen vote-result-screen">
        <h1>Vote Results</h1>
        <div class="vote-result-list" id="voteResultList">
            ${targets.map(p => `
                <div class="vote-result-item" id="result-${p.id}">
                    <span class="player-name">${p.name}</span>
                    <span class="vote-count" id="count-${p.id}">0</span>
                </div>
            `).join('')}
        </div>
        <div id="finalResultArea" class="final-result-area"></div>
      </div>
    `;

    // Sequence: Iterate and animate
    for (const player of targets) {
      // Wait a bit before starting each item
      await new Promise(r => setTimeout(r, 500));

      const count = voteCounts[player.id] || 0;
      const countEl = document.getElementById(`count-${player.id}`);
      const itemEl = document.getElementById(`result-${player.id}`);

      // Highlight current
      itemEl.classList.add('revealing');
      itemEl.scrollIntoView({ behavior: 'smooth', block: 'center' });

      // Animate number (slow tick)
      await this.animateNumber(countEl, count);

      // Pause after reveal
      await new Promise(r => setTimeout(r, 800));
      itemEl.classList.remove('revealing');
    }

    // Scroll to final result after all items animated
    const finalArea = document.getElementById('finalResultArea');
    if (finalArea) {
      finalArea.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  animateNumber(element, finalValue) {
    return new Promise(resolve => {
      if (finalValue === 0) {
        element.textContent = '0';
        resolve();
        return;
      }

      let current = 0;
      // Increment by 1 every 500ms (0.5 sec)
      const timer = setInterval(() => {
        current++;
        element.textContent = current;

        if (current >= finalValue) {
          clearInterval(timer);
          resolve();
        }
      }, 500);
    });
  }

  renderFinalVoteResult(state) {
    const container = document.getElementById('finalResultArea');
    if (!container) return; // Should exist from animation step

    let html = '';
    if (state.result === 'tie') {
      const tiedNames = state.tiedPlayers.map(id => {
        const p = this.allPlayers.find(pl => pl.id === id);
        return p ? p.name : 'Unknown';
      }).join(', ');

      html = `
            <h2>Vote Tied</h2>
            <p>Between: ${tiedNames}</p>
            <p class="instruction">Revoting...</p>
        `;
    } else if (state.result === 'killed') {
      html = `
            <h2>Result</h2>
            <p class="victim-name">${state.victimName}</p>
            <p class="instruction">was put in cold sleep</p>
        `;
    }

    // Add controls
    if (gameManager.currentPlayer.isHost) {
      html += `<button id="nextBtn" class="btn btn-primary btn-large">Next</button>`;
    } else {
      html += `<p class="waiting-text">Waiting for host...</p>`;
    }

    container.innerHTML = html;
    container.scrollIntoView({ behavior: 'smooth', block: 'center' });

    if (gameManager.currentPlayer.isHost) {
      document.getElementById('nextBtn').addEventListener('click', async () => {
        await gameManager.proceedAfterVote();
      });
    }
  }

  showNightSpecial(role) {
    // 1. Check if eligible for special action
    // Must be Alive AND have a special role
    const specialRoles = ['engineer', 'doctor', 'fallen_angel'];
    const myRole = this.currentPlayerData ? this.currentPlayerData.role : null;
    const isAlive = this.currentPlayerData ? this.currentPlayerData.isAlive : false;

    if (!isAlive || !specialRoles.includes(myRole)) {
      this.showNightSleep();
      return;
    }

    // 2. Prepare UI for Special Role
    const targets = this.allPlayers;
    const myId = authManager.getUserId();
    let validTargetCount = 0;

    // Determine Title and Instruction
    let title = '';
    let instruction = '';
    if (myRole === 'engineer') {
      title = 'Night - Engineer';
      instruction = 'Check one living player';
    } else if (myRole === 'doctor') {
      title = 'Night - Doctor';
      instruction = 'Select a deceased player to reveal their role';
    } else if (myRole === 'fallen_angel') {
      title = 'Night - Fallen Angel';
      instruction = 'Protect one player';
    }

    const renderedList = targets.map(player => {
      let isValid = false;
      if (myRole === 'engineer') {
        // Engineer: check alive, not self
        isValid = player.isAlive && player.id !== myId;
      } else if (myRole === 'doctor') {
        // Doctor: check dead
        isValid = !player.isAlive;
      } else if (myRole === 'fallen_angel') {
        // Fallen Angel: check alive, not self (Can protect anyone, including Impostors)
        isValid = player.isAlive && player.id !== myId;
      }

      if (isValid) validTargetCount++;

      const isDisabled = !isValid;

      return `
            <button class="target-item ${!player.isAlive ? 'deceased' : ''}" 
                    data-player-id="${player.id}"
                    ${isDisabled ? 'disabled' : ''}>
              ${player.name} ${player.id === myId ? '(You)' : ''} ${!player.isAlive ? '(Deceased)' : ''}
            </button>
        `;
    }).join('');

    const hasTargets = validTargetCount > 0;

    // Fallback instruction for no targets
    if (!hasTargets) {
      if (myRole === 'doctor') instruction = 'No deceased players to check';
      else instruction = 'No valid targets';
    }

    document.getElementById('app').innerHTML = `
      <div class="screen night-action-screen">
        <h1>${title}</h1>
        <p class="instruction">${instruction}</p>
        
        <div class="target-list" id="targetList">
          ${renderedList}
          ${!hasTargets ? `
            <div class="no-targets-message">No actions available tonight.</div>
            <button id="skipBtn" class="btn btn-secondary">Continue</button>
          ` : ''}
        </div>
      </div>
    `;

    if (hasTargets) {
      document.querySelectorAll('.target-item').forEach(btn => {
        if (!btn.disabled) {
          btn.addEventListener('click', (e) => {
            const button = e.target.closest('.target-item');
            const targetId = button.dataset.playerId;
            const target = this.allPlayers.find(p => p.id === targetId);

            let confirmMsg = '';
            if (myRole === 'engineer') confirmMsg = `Check ${target.name}?`;
            else if (myRole === 'doctor') confirmMsg = `Examine ${target.name}?`;
            else if (myRole === 'fallen_angel') confirmMsg = `Protect ${target.name}?`;

            this.showActionConfirmation(
              confirmMsg,
              async () => {
                // For Info roles (Eng/Doc), show info FIRST, then submit on OK.
                // This prevents the game from advancing before reading.
                if (myRole === 'engineer' || myRole === 'doctor') {
                  this.showTargetRole(target.name, target.role, async () => {
                    await gameManager.submitNightAction(myRole, targetId);
                    this.showWaiting('Waiting for other actions...');
                    this.startHostMonitor();
                  });
                } else {
                  // For Action roles (Angel), submit immediately
                  await gameManager.submitNightAction(myRole, targetId);
                  this.showWaiting('Protected. Waiting for morning...');
                  this.startHostMonitor();
                }
              },
              () => this.showNightSpecial(myRole)
            );
          });
        }
      });
    } else {
      document.getElementById('skipBtn')?.addEventListener('click', async () => {
        await gameManager.submitNightAction(role, 'SKIP');
        this.showWaiting('Waiting for other actions...');
        this.startHostMonitor();
      });
    }
  }

  startHostMonitor() {
    if (gameManager.currentPlayer.isHost) {
      const checkInterval = setInterval(async () => {
        const allSubmitted = await gameManager.checkEDSubmitted();
        if (allSubmitted) {
          clearInterval(checkInterval);
        }
      }, 1000);
      this.activeListeners.push(checkInterval);
    }
  }

  showNightImpostor() {
    this.cleanupListeners();
    const role = this.currentPlayerData.role;
    const isAlive = this.currentPlayerData.isAlive;

    if (!isAlive || role !== 'impostor') {
      this.showNightSleep();
      return;
    }

    // Show ALL players
    const targets = this.allPlayers;
    const myId = authManager.getUserId();

    document.getElementById('app').innerHTML = `
      <div class="screen night-action-screen impostor">
        <h1>Night - Impostor</h1>
        <p class="instruction">Choose your target</p>
        
        <div class="target-list" id="targetList">
          ${targets.map(player => {
      const isMe = player.id === myId;
      const isImpostor = player.role === 'impostor';
      const isDead = !player.isAlive;
      // Disable if: Self, Fellow Impostor, or Dead
      const isDisabled = isMe || isImpostor || isDead;
      const label = isMe ? '(You)' : (isImpostor ? '(Ally)' : (isDead ? '(Deceased)' : ''));

      return `
            <button class="target-item" 
                    data-player-id="${player.id}"
                    ${isDisabled ? 'disabled' : ''}>
              ${player.name} ${label}
            </button>
          `}).join('')}
        </div>
      </div>
    `;

    document.querySelectorAll('.target-item').forEach(btn => {
      if (!btn.disabled) {
        btn.addEventListener('click', (e) => {
          const button = e.target.closest('.target-item');
          const targetId = button.dataset.playerId;
          const target = this.allPlayers.find(p => p.id === targetId);

          this.showActionConfirmation(
            `Kill ${target ? target.name : 'this player'}?`,
            async () => {
              await gameManager.submitNightAction('impostor', targetId);
              this.showWaiting('Target selected. Waiting...');
              if (gameManager.currentPlayer.isHost) {
                const checkInterval = setInterval(async () => {
                  const allSubmitted = await gameManager.checkImpostorSubmitted();
                  if (allSubmitted) {
                    clearInterval(checkInterval);
                  }
                }, 1000);
                this.activeListeners.push(checkInterval);
              }
            },
            () => this.showNightImpostor()
          );
        });
      }
    });
  }

  showNightSleep() {
    document.getElementById('app').innerHTML = `
      <div class="screen night-screen">
        <h1>Night</h1>
        <p class="instruction">Close your eyes and sleep</p>
      </div>
    `;

    // HOST MONITORING: Host must keep checking night actions even while 'sleeping'
    if (gameManager.currentPlayer.isHost) {
      const monitorInterval = setInterval(async () => {
        const state = await gameManager.getState();
        if (!state) return;

        if (state.phase === GAME_PHASES.NIGHT_SPECIAL) {
          await gameManager.checkEDSubmitted();
        } else if (state.phase === GAME_PHASES.NIGHT_IMPOSTOR) {
          await gameManager.checkImpostorSubmitted();
        }
      }, 2000);
      this.activeListeners.push(monitorInterval);
    }
  }

  showTargetRole(name, role, onOk) {
    // Logic: Only reveal Gnosia (Impostor) or Human.
    // AC Follower, Bug, etc are "Human".
    const isGnosia = role === 'impostor';
    const displayRole = isGnosia ? 'Gnosia' : 'Human';
    const badgeClass = isGnosia ? 'impostor' : 'citizen';

    document.getElementById('app').innerHTML = `
      <div class="screen role-check-screen" style="text-align: center;">
        <h2>${name}</h2>
        <div class="role-badge ${badgeClass}">${displayRole}</div>
        <p class="instruction">Remember this information</p>
        <button id="targetOkBtn" class="btn btn-primary btn-large">OK</button>
      </div>
    `;

    document.getElementById('targetOkBtn').addEventListener('click', () => {
      if (onOk) onOk();
    });
  }

  showMorning(victimId) {
    this.cleanupListeners();
    const victim = this.allPlayers.find(p => p.id === victimId);
    const victimName = victim ? victim.name : 'No one';

    document.getElementById('app').innerHTML = `
      <div class="screen morning-screen">
        <h1>Morning</h1>
        <p class="instruction">Last night...</p>
        <p class="victim-name">${victimName}</p>
        <p class="instruction">${victim ? 'was killed' : 'survived'}</p>
        
        ${gameManager.currentPlayer.isHost ? `
            <button id="nextBtn" class="btn btn-primary btn-large">Next</button>
        ` : `
            <p class="waiting-text">Waiting for host...</p>
        `}
      </div>
    `;

    if (gameManager.currentPlayer.isHost) {
      document.getElementById('nextBtn').addEventListener('click', async () => {
        await gameManager.proceedAfterMorning();
      });
    }
  }

  showPlayerStatusModal() {
    const myId = authManager.getUserId();
    const myRole = this.currentPlayerData ? this.currentPlayerData.role : null;

    // Build list
    const listHtml = this.allPlayers.map(p => {
      const isMe = p.id === myId;
      const isDead = !p.isAlive;
      const isClickable = isMe && myRole === 'guard_duty';

      return `
            <div class="status-item ${isDead ? 'dead' : 'alive'} ${isClickable ? 'clickable-self' : ''}" 
                 data-id="${p.id}">
                <span class="player-name">${p.name} ${isMe ? '(You)' : ''}</span>
                <span class="status-badge">${isDead ? 'DECEASED' : 'ALIVE'}</span>
            </div>
        `;
    }).join('');

    const modalHtml = `
        <div class="modal-overlay" id="statusModal">
            <div class="modal-content">
                <h2>Player Status</h2>
                <div class="status-list">
                    ${listHtml}
                </div>
                <button id="closeModalBtn" class="btn btn-primary">Close</button>
            </div>
        </div>
    `;

    const app = document.getElementById('app');
    const existingModal = document.getElementById('statusModal');
    if (existingModal) existingModal.remove();

    app.insertAdjacentHTML('beforeend', modalHtml);

    document.getElementById('closeModalBtn').addEventListener('click', () => {
      document.getElementById('statusModal').remove();
    });

    // Guard Duty Self-Verify
    if (myRole === 'guard_duty') {
      const selfItem = document.querySelector('.clickable-self');
      if (selfItem) {
        selfItem.addEventListener('click', () => {
          this.showGuardDutyProofOverlay();
        });
      }
    }
  }

  showGuardDutyProofOverlay() {
    const html = `
        <div class="proof-overlay" id="proofOverlay">
            <div class="proof-card">
                <h1>VERIFIED</h1>
                <div class="proof-role">GUARD DUTY</div>
                <p class="proof-desc">This player is proven innocent.</p>
                <button class="btn btn-primary" id="closeProofBtn">Close</button>
            </div>
        </div>
    `;
    document.body.insertAdjacentHTML('beforeend', html);

    document.getElementById('closeProofBtn').addEventListener('click', () => {
      document.getElementById('proofOverlay').remove();
    });
  }

  async showVoteHistoryModal() {
    const history = await gameManager.getFullVoteHistory();

    // Group by Day
    const byDay = {};
    history.forEach(vote => {
      if (!byDay[vote.day]) byDay[vote.day] = [];
      byDay[vote.day].push(vote);
    });

    const days = Object.keys(byDay).sort((a, b) => a - b);

    let htmlContent = '';
    days.forEach(day => {
      htmlContent += `<div class="history-day"><h3>Day ${day}</h3>`;
      byDay[day].forEach(vote => {
        const voter = this.allPlayers.find(p => p.id === vote.voterId)?.name || 'Unknown';
        const target = this.allPlayers.find(p => p.id === vote.targetId)?.name || 'Unknown';
        htmlContent += `<div class="history-item"><span class="voter">${voter}</span> voted for <span class="target">${target}</span></div>`;
      });
      htmlContent += `</div>`;
    });

    const modalHtml = `
        <div class="modal-overlay" id="historyModal">
            <div class="modal-content">
                <h2>Vote History</h2>
                <div class="status-list">
                    ${htmlContent || '<p>No votes yet.</p>'}
                </div>
                <button id="closeHistoryBtn" class="btn btn-primary">Close</button>
            </div>
        </div>
    `;

    const app = document.getElementById('app');
    const existing = document.getElementById('historyModal');
    if (existing) existing.remove();

    app.insertAdjacentHTML('beforeend', modalHtml);

    document.getElementById('closeHistoryBtn').addEventListener('click', () => {
      document.getElementById('historyModal').remove();
    });
  }

  // ========================================
  // GAME END
  // ========================================

  showGameEnd(winner) {
    this.cleanupListeners();
    const myRole = this.currentPlayerData ? this.currentPlayerData.role : '';

    let winnerText = '';
    let userWon = false;

    if (winner === 'impostor') {
      const hasFollower = this.allPlayers.some(p => p.role === 'impostor_follower');
      winnerText = hasFollower ? 'Impostors and Impostor Follower Win!' : 'Impostors Win!';
      if (myRole === 'impostor' || myRole === 'impostor_follower') userWon = true;
    } else if (winner === 'bug') {
      winnerText = 'The Universe Collapsed (Bug Wins)';
      if (myRole === 'bug') userWon = true;
    } else {
      winnerText = 'Citizens Win!';
      if (myRole !== 'impostor' && myRole !== 'impostor_follower' && myRole !== 'bug') userWon = true;
    }

    document.getElementById('app').innerHTML = `
      <div class="screen end-screen">
        <h1>Game Over</h1>
        <div class="winner-badge ${winner}">
          ${winnerText}
        </div>
        <h2 class="${userWon ? 'victory-text' : 'defeat-text'}">
            ${userWon ? 'VICTORY' : 'DEFEAT'}
        </h2>
        
        <div class="players-reveal">
          <h3>Players</h3>
          ${this.allPlayers.map(player => {
      const roleDisplay = {
        citizen: 'Citizen',
        impostor: 'Impostor',
        engineer: 'Engineer',
        doctor: 'Doctor',
        fallen_angel: 'Fallen Angel',
        guard_duty: 'Guard Duty',
        impostor_follower: 'Impostor Follower',
        bug: 'Bug'
      }[player.role] || player.role;

      return `
            <div class="player-reveal ${!player.isAlive ? 'deceased-player' : ''}">
              <span>${player.name} ${!player.isAlive ? '- Dead' : ''}</span>
              <span class="role-badge ${player.role}">${roleDisplay}</span>
            </div>
          `}).join('')}
        </div>

        <div style="display: flex; gap: 1rem; justify-content: center; margin-top: var(--spacing-lg);">
          <button id="playAgainBtn" class="btn btn-primary btn-large">Play Again</button>
          <button id="homeBtn" class="btn btn-secondary btn-large">Back to Home</button>
        </div>
      </div>
      `;

    document.getElementById('playAgainBtn').addEventListener('click', async () => {
      this.cleanupListeners();
      // Reset game but stay in room
      const roomCode = gameManager.currentRoom;
      const playerName = gameManager.currentPlayer.name;

      // Clear game state but don't leave room
      await gameManager.resetGameState();

      // Show lobby
      this.showLobby();
    });

    document.getElementById('homeBtn').addEventListener('click', () => {
      this.cleanupListeners();
      gameManager.cleanup();
      this.showHome();
    });
  }

  // ========================================
  // UTILITIES
  // ========================================

  formatTime(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')} `;
  }
}

export default new UIManager();
