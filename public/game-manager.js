// Game Manager - Redesigned with Deterministic State System
import { db, rtdb } from './firebase-config.js';
import {
    collection, doc, setDoc, getDoc, getDocs, updateDoc, deleteDoc,
    onSnapshot, serverTimestamp, increment, addDoc
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { ref, set, onValue, update, remove } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";
import authManager from './auth-manager.js';
import { GAME_PHASES } from './game-states.js';

class GameManager {
    constructor() {
        this.currentRoom = null;
        this.currentPlayer = null;
        this.unsubscribers = [];
        this.activeTimer = null;
    }

    // ========================================
    // SESSION MANAGEMENT
    // ========================================

    persistRoom(roomCode) {
        localStorage.setItem('gnosia_room', roomCode);
    }

    clearSession() {
        localStorage.removeItem('gnosia_room');
        this.currentRoom = null;
        this.currentPlayer = null;
    }

    async restoreSession() {
        const roomCode = localStorage.getItem('gnosia_room');
        if (!roomCode) return false;

        const userId = authManager.getUserId();
        if (!userId) return false;

        try {
            // Check Room
            const roomRef = doc(db, 'rooms', roomCode);
            const roomSnap = await getDoc(roomRef);
            if (!roomSnap.exists()) {
                this.clearSession();
                return false;
            }

            // Check Player
            const playerRef = doc(db, 'rooms', roomCode, 'players', userId);
            const playerSnap = await getDoc(playerRef);
            if (!playerSnap.exists()) {
                this.clearSession();
                return false;
            }

            const playerData = playerSnap.data();

            // Restore State
            this.currentRoom = roomCode;
            this.currentPlayer = {
                id: userId,
                name: playerData.name,
                isHost: playerData.isHost, // Critical: Restore Host Status
                role: playerData.role      // Critical: Restore Role
            };

            this.setupPresence(roomCode, userId);
            return true;

        } catch (error) {
            console.error('Failed to restore session:', error);
            this.clearSession();
            return false;
        }
    }

    // ========================================
    // ROOM MANAGEMENT
    // ========================================

    generateRoomCode() {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
        let code = '';
        for (let i = 0; i < 4; i++) {
            code += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return code;
    }

    async createRoom(playerName) {
        const roomCode = this.generateRoomCode();
        const userId = authManager.getUserId();

        const roomRef = doc(db, 'rooms', roomCode);

        await setDoc(roomRef, {
            roomCode: roomCode,
            hostId: userId,
            status: 'lobby',
            createdAt: serverTimestamp(),
            day: 1
        });

        await this.joinRoom(roomCode, playerName, true);

        const settingsRef = doc(db, 'rooms', roomCode, 'settings', 'main');
        await setDoc(settingsRef, {
            roles: {
                citizen: 4,
                impostor: 2,
                engineer: 1,
                doctor: 1,
                fallen_angel: 1,
                guard_duty: 0,
                impostor_follower: 0,
                bug: 0
            },
            timers: {
                meeting: 300,
                vote: 60,
                break: 120
            }
        });

        return roomCode;
    }

    async joinRoom(roomCode, playerName, isHost = false) {
        const userId = authManager.getUserId();

        const roomRef = doc(db, 'rooms', roomCode);
        const roomSnap = await getDoc(roomRef);

        if (!roomSnap.exists()) {
            throw new Error('Room not found');
        }

        const roomData = roomSnap.data();
        const playerRef = doc(db, 'rooms', roomCode, 'players', userId);
        const playerSnap = await getDoc(playerRef);

        // If game is already started, only allow existing players to re-join
        if (roomData.status !== 'lobby' && !playerSnap.exists()) {
            throw new Error('Game already in progress. Cannot join now.');
        }

        const existingData = playerSnap.exists() ? playerSnap.data() : {};

        // Merge logic: Preserve role and status if they exist
        await setDoc(playerRef, {
            name: playerName,
            isHost: isHost || existingData.isHost || false,
            isAlive: existingData.isAlive !== undefined ? existingData.isAlive : true,
            role: existingData.role !== undefined ? existingData.role : null,
            roleReadConfirmed: existingData.roleReadConfirmed || false,
            connected: true,
            joinedAt: existingData.joinedAt || serverTimestamp()
        }, { merge: true });

        // Update local state
        this.currentRoom = roomCode;
        this.currentPlayer = {
            id: userId,
            name: playerName,
            isHost: isHost || existingData.isHost || false,
            role: existingData.role || null
        };

        this.setupPresence(roomCode, userId);
        this.persistRoom(roomCode);

        return roomCode;
    }

    async leaveRoom() {
        if (!this.currentRoom || !this.currentPlayer) return;

        const roomId = this.currentRoom;
        const userId = this.currentPlayer.id;
        const isHost = this.currentPlayer.isHost;

        try {
            if (isHost) {
                // 1. Notify clients room is closed
                const roomRef = doc(db, 'rooms', roomId);
                await updateDoc(roomRef, { status: 'closed' });

                // 2. Client-side cleanup of subcollections
                // Note: Client SDK cannot delete collections, must iterate docs.
                const subcollections = ['players', 'votes', 'nightActions', 'deathLog', 'gameState', 'settings'];

                for (const sub of subcollections) {
                    const subRef = collection(db, 'rooms', roomId, sub);
                    const subSnap = await getDocs(subRef);
                    const deletePromises = subSnap.docs.map(doc => deleteDoc(doc.ref));
                    await Promise.all(deletePromises);
                }

                // 3. Delete Room Doc
                await deleteDoc(roomRef);

                // 4. Delete RTDB
                await remove(ref(rtdb, `presence/${roomId}`));
                await remove(ref(rtdb, `timers/${roomId}`));

            } else {
                const playerRef = doc(db, 'rooms', roomId, 'players', userId);
                await deleteDoc(playerRef);
            }
        } catch (e) {
            console.error('Error during leaveRoom:', e);
        }

        // Remove presence
        const presenceRef = ref(rtdb, `presence/${roomId}/${userId}`);
        try {
            await remove(presenceRef);
        } catch (e) {
            console.error('Error removing presence:', e);
        }

        if (this.presenceInterval) {
            clearInterval(this.presenceInterval);
        }

        // Clear local session logic
        this.clearSession();

        // Clean up listeners
        this.unsubscribers.forEach(unsub => unsub());
        this.unsubscribers = [];

        if (this.activeTimer) {
            clearInterval(this.activeTimer);
            this.activeTimer = null;
        }
    }

    setupPresence(roomCode, userId) {
        const presenceRef = ref(rtdb, `presence/${roomCode}/${userId}`);

        set(presenceRef, {
            online: true,
            lastPing: Date.now()
        });

        this.presenceInterval = setInterval(() => {
            update(presenceRef, {
                lastPing: Date.now()
            });
        }, 5000);

        window.addEventListener('beforeunload', () => {
            set(presenceRef, {
                online: false,
                lastPing: Date.now()
            });
        });
    }

    async kickPlayer(playerId) {
        if (!this.currentPlayer.isHost) return;

        const playerRef = doc(db, 'rooms', this.currentRoom, 'players', playerId);
        await deleteDoc(playerRef);

        const presenceRef = ref(rtdb, `presence/${this.currentRoom}/${playerId}`);
        await remove(presenceRef);
    }

    async updateSettings(settings) {
        if (!this.currentPlayer.isHost) return;

        const settingsRef = doc(db, 'rooms', this.currentRoom, 'settings', 'main');
        await updateDoc(settingsRef, settings);
    }

    // ========================================
    // STATE MANAGEMENT (SINGLE SOURCE OF TRUTH)
    // ========================================

    // ========================================
    // STATE MANAGEMENT (SINGLE SOURCE OF TRUTH)
    // ========================================

    /**
     * Updates the authortative game state.
     * @param {string} phase - The new phase from GAME_PHASES
     * @param {object} additionalData - Any extra data to merge into state
     */
    async setState(phase, additionalData = {}) {
        if (!this.currentPlayer.isHost) return;

        const gameStateRef = doc(db, 'rooms', this.currentRoom, 'gameState', 'current');
        const transitionId = `${phase}_${Date.now()}`;

        await setDoc(gameStateRef, {
            phase: phase,
            version: increment(1),
            transitionId: transitionId,
            updatedAt: serverTimestamp(),
            hostUid: this.currentPlayer.id,
            ...additionalData
        }, { merge: true });
    }

    async getState() {
        const gameStateRef = doc(db, 'rooms', this.currentRoom, 'gameState', 'current');
        const snap = await getDoc(gameStateRef);
        return snap.exists() ? snap.data() : null;
    }

    async resetGameState() {
        if (!this.currentPlayer.isHost) return;

        try {
            // Reset all players to alive and remove roles
            const playersRef = collection(db, 'rooms', this.currentRoom, 'players');
            const playersSnap = await getDocs(playersRef);
            const playerUpdates = [];
            playersSnap.forEach(doc => {
                playerUpdates.push(updateDoc(doc.ref, {
                    isAlive: true,
                    role: null,
                    roleReadConfirmed: false
                }));
            });
            await Promise.all(playerUpdates);

            // Clear votes
            const votesRef = collection(db, 'rooms', this.currentRoom, 'votes');
            const votesSnap = await getDocs(votesRef);
            const voteDeletes = [];
            votesSnap.forEach(doc => voteDeletes.push(deleteDoc(doc.ref)));
            await Promise.all(voteDeletes);

            // Clear night actions
            const actionsRef = collection(db, 'rooms', this.currentRoom, 'nightActions');
            const actionsSnap = await getDocs(actionsRef);
            const actionDeletes = [];
            actionsSnap.forEach(doc => actionDeletes.push(deleteDoc(doc.ref)));
            await Promise.all(actionDeletes);

            // Clear death log
            const deathLogRef = collection(db, 'rooms', this.currentRoom, 'deathLog');
            const deathLogSnap = await getDocs(deathLogRef);
            const deathDeletes = [];
            deathLogSnap.forEach(doc => deathDeletes.push(deleteDoc(doc.ref)));
            await Promise.all(deathDeletes);

            // Clear vote history (optional - you might want to keep this)
            const historyRef = collection(db, 'rooms', this.currentRoom, 'voteHistory');
            const historySnap = await getDocs(historyRef);
            const historyDeletes = [];
            historySnap.forEach(doc => historyDeletes.push(deleteDoc(doc.ref)));
            await Promise.all(historyDeletes);

            // Reset room day counter
            const roomRef = doc(db, 'rooms', this.currentRoom);
            await updateDoc(roomRef, {
                day: 1,
                status: 'lobby'
            });

            // Clear RTDB Timers
            const timerRef = ref(rtdb, `timers/${this.currentRoom}`);
            await remove(timerRef);

            // Reset game state to lobby (Overwrite instead of merge to wipe old winners/victims)
            const gameStateRef = doc(db, 'rooms', this.currentRoom, 'gameState', 'current');
            await setDoc(gameStateRef, {
                phase: GAME_PHASES.LOBBY,
                version: 0,
                transitionId: `RESET_${Date.now()}`,
                updatedAt: serverTimestamp(),
                hostUid: this.currentPlayer.id
            });

            console.log('Game state reset successfully - Room is fresh.');

            console.log('Game state reset successfully');
        } catch (error) {
            console.error('Error resetting game state:', error);
        }
    }

    /**
     * Version-Driven Sync Listener
     * @param {function} renderScreen - Callback(phase, role) to update UI
     */
    subscribeToGameState(renderScreen) {
        let localVersion = -1;
        let lastSnapshotTime = Date.now();
        const gameStateRef = doc(db, 'rooms', this.currentRoom, 'gameState', 'current');

        // 1. Snapshot Listener
        const unsubscribe = onSnapshot(gameStateRef, (snap) => {
            lastSnapshotTime = Date.now();
            const state = snap.data();

            if (!state) return;

            // Only re-render if version changed (or first load)
            if (state.version !== localVersion) {
                console.log(`[Sync] Version change: ${localVersion} -> ${state.version} (${state.phase})`);
                localVersion = state.version;

                // Client-side render logic
                // We need to know the player's role to determine UI
                // We assume this.currentPlayer is set or we fetch it.
                // Ideally role is passed or available globally.
                // For now, we'll refetch player if role is missing or just pass it.
                this.getCurrentRole().then(role => {
                    renderScreen(state.phase, role, state);
                });
            }
        });
        this.unsubscribers.push(unsubscribe);

        // 2. Anti-Stuck Guard
        const guardInterval = setInterval(() => {
            if (Date.now() - lastSnapshotTime > 3000) {
                console.warn('[Guard] No snapshot for 3s, forcing reload...');
                getDoc(gameStateRef).then(snap => {
                    if (snap.exists()) {
                        const state = snap.data();
                        if (state.version !== localVersion) {
                            console.log('[Guard] Recovered state!');
                            localVersion = state.version;
                            this.getCurrentRole().then(role => {
                                renderScreen(state.phase, role, state);
                            });
                        }
                    }
                });
                lastSnapshotTime = Date.now(); // Reset to prevent spam
            }
        }, 2000);
        this.unsubscribers.push(() => clearInterval(guardInterval));

        return unsubscribe;
    }

    async getCurrentRole() {
        if (this.currentPlayer && this.currentPlayer.role) return this.currentPlayer.role;
        // Fetch from Firestore if not in memory
        const playerRef = doc(db, 'rooms', this.currentRoom, 'players', authManager.getUserId());
        const snap = await getDoc(playerRef);
        if (snap.exists()) {
            return snap.data().role;
        }
        return null;
    }

    // ========================================
    // GAME FLOW - ROLE_SHOW
    // ========================================

    async startGame() {
        if (!this.currentPlayer.isHost) return;

        const playersRef = collection(db, 'rooms', this.currentRoom, 'players');
        const playersSnap = await getDocs(playersRef);
        const players = [];
        playersSnap.forEach(doc => {
            players.push({ id: doc.id, ...doc.data() });
        });

        const settingsRef = doc(db, 'rooms', this.currentRoom, 'settings', 'main');
        const settingsSnap = await getDoc(settingsRef);
        const settings = settingsSnap.data();

        const roles = this.assignRoles(players.length, settings.roles);
        const shuffledRoles = this.shuffleArray(roles);

        for (let i = 0; i < players.length; i++) {
            const playerRef = doc(db, 'rooms', this.currentRoom, 'players', players[i].id);
            await updateDoc(playerRef, {
                role: shuffledRoles[i],
                roleReadConfirmed: false
            });
        }

        const roomRef = doc(db, 'rooms', this.currentRoom);
        await updateDoc(roomRef, {
            status: 'ingame'
        });

        // STATE: ROLE_REVEAL
        await this.setState(GAME_PHASES.ROLE_REVEAL);
    }

    assignRoles(playerCount, roleSettings) {
        const roles = [];

        for (const [role, count] of Object.entries(roleSettings)) {
            for (let i = 0; i < count; i++) {
                roles.push(role);
            }
        }

        while (roles.length < playerCount) {
            roles.push('citizen');
        }

        return roles.slice(0, playerCount);
    }

    shuffleArray(array) {
        const shuffled = [...array];
        for (let i = shuffled.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        return shuffled;
    }

    async markRoleAsRead() {
        const playerRef = doc(db, 'rooms', this.currentRoom, 'players', authManager.getUserId());
        await updateDoc(playerRef, {
            roleReadConfirmed: true
        });
    }

    async checkAllPlayersReadRole() {
        const playersRef = collection(db, 'rooms', this.currentRoom, 'players');
        const playersSnap = await getDocs(playersRef);

        let allRead = true;
        playersSnap.forEach(doc => {
            if (!doc.data().roleReadConfirmed) {
                allRead = false;
            }
        });

        if (allRead && this.currentPlayer.isHost) {
            // STATE: MEETING_DISCUSSION
            await this.setState(GAME_PHASES.MEETING_DISCUSSION);
            await this.startMeetingTimer();
        }

        return allRead;
    }

    // ========================================
    // GAME FLOW - MEETING
    // ========================================

    async startMeetingTimer() {
        if (!this.currentPlayer.isHost) return;

        const settingsRef = doc(db, 'rooms', this.currentRoom, 'settings', 'main');
        const settingsSnap = await getDoc(settingsRef);
        const settings = settingsSnap.data();

        const timerRef = ref(rtdb, `timers/${this.currentRoom}`);
        set(timerRef, {
            remaining: settings.timers.meeting,
            phase: 'meeting'
        });

        this.startTimer(settings.timers.meeting, 'meeting');
    }

    startTimer(duration, phase) {
        if (this.activeTimer) {
            clearInterval(this.activeTimer);
        }

        const timerRef = ref(rtdb, `timers/${this.currentRoom}`);
        let remaining = duration;

        this.activeTimer = setInterval(async () => {
            remaining--;
            update(timerRef, { remaining });

            if (remaining <= 0) {
                clearInterval(this.activeTimer);
                this.activeTimer = null;

                // Handle Phase Timeout
                if (this.currentPlayer.isHost) {
                    if (phase === 'voting') {
                        console.log('Vote timer expired. Forcing result...');
                        await this.processVotes();
                    } else if (phase === 'meeting') {
                        console.log('Meeting timer expired. Moving to vote...');
                        await this.transitionToVoting();
                    } else if (phase === 'break') {
                        console.log('Break timer expired. Moving to night...');
                        await this.transitionToNight();
                    }
                }
            }
        }, 1000);
    }

    async transitionToVoting() {
        if (!this.currentPlayer.isHost) return;

        // STATE: VOTING
        await this.setState(GAME_PHASES.VOTING);
        await this.startVotingTimer();
    }

    async transitionToBreak() {
        if (!this.currentPlayer.isHost) return;

        // STATE: BREAK
        await this.setState(GAME_PHASES.BREAK);
        await this.startBreakTimer();
    }

    async startBreakTimer() {
        if (!this.currentPlayer.isHost) return;

        const settingsRef = doc(db, 'rooms', this.currentRoom, 'settings', 'main');
        const settingsSnap = await getDoc(settingsRef);
        const settings = settingsSnap.data();

        const timerRef = ref(rtdb, `timers/${this.currentRoom}`);
        set(timerRef, {
            remaining: settings.timers.break,
            phase: 'break'
        });

        this.startTimer(settings.timers.break, 'break');
    }

    async transitionToNight() {
        if (!this.currentPlayer.isHost) return;

        // Clear previous night actions
        const actionsRef = collection(db, 'rooms', this.currentRoom, 'nightActions');
        const actionsSnap = await getDocs(actionsRef);
        actionsSnap.forEach(async (actionDoc) => {
            await deleteDoc(actionDoc.ref);
        });

        // STATE: NIGHT_SPECIAL (Engineer/Doctor)
        await this.setState(GAME_PHASES.NIGHT_SPECIAL);
    }

    // ========================================
    // GAME FLOW - VOTING
    // ========================================

    async startVotingTimer() {
        if (!this.currentPlayer.isHost) return;

        const settingsRef = doc(db, 'rooms', this.currentRoom, 'settings', 'main');
        const settingsSnap = await getDoc(settingsRef);
        const settings = settingsSnap.data();

        // Clear previous votes
        const votesRef = collection(db, 'rooms', this.currentRoom, 'votes');
        const votesSnap = await getDocs(votesRef);
        votesSnap.forEach(async (voteDoc) => {
            await deleteDoc(voteDoc.ref);
        });

        const timerRef = ref(rtdb, `timers/${this.currentRoom}`);
        set(timerRef, {
            remaining: settings.timers.vote,
            phase: 'voting'
        });

        this.startTimer(settings.timers.vote, 'voting');
    }

    async submitVote(targetId) {
        const voteRef = doc(db, 'rooms', this.currentRoom, 'votes', authManager.getUserId());
        await setDoc(voteRef, {
            targetId: targetId,
            submittedAt: serverTimestamp()
        });
    }

    async checkAllVoted() {
        const playersRef = collection(db, 'rooms', this.currentRoom, 'players');
        const playersSnap = await getDocs(playersRef);

        const alivePlayers = [];
        playersSnap.forEach(doc => {
            if (doc.data().isAlive) {
                alivePlayers.push(doc.id);
            }
        });

        const votesRef = collection(db, 'rooms', this.currentRoom, 'votes');
        const votesSnap = await getDocs(votesRef);

        const allVoted = votesSnap.size >= alivePlayers.length;

        if (allVoted && this.currentPlayer.isHost) {
            // STATE: VOTE_RESULT
            await this.processVotes();
        }

        return allVoted;
    }

    async getVotes() {
        const votesRef = collection(db, 'rooms', this.currentRoom, 'votes');
        const votesSnap = await getDocs(votesRef);
        const votes = [];
        votesSnap.forEach(doc => {
            votes.push({
                voterId: doc.id,
                targetId: doc.data().targetId
            });
        });
        return votes;
    }

    async processVotes() {
        if (!this.currentPlayer.isHost) return;

        const votesRef = collection(db, 'rooms', this.currentRoom, 'votes');
        const votesSnap = await getDocs(votesRef);

        const voteCount = {};
        votesSnap.forEach(doc => {
            const targetId = doc.data().targetId;
            voteCount[targetId] = (voteCount[targetId] || 0) + 1;
        });

        let maxVotes = 0;
        let targets = [];

        for (const [playerId, count] of Object.entries(voteCount)) {
            if (count > maxVotes) {
                maxVotes = count;
                targets = [playerId];
            } else if (count === maxVotes) {
                targets.push(playerId);
            }
        }

        // Handle tie
        if (targets.length > 1) {
            // STATE: VOTE_RESULT (Tie)
            await this.setState(GAME_PHASES.VOTE_RESULT, {
                result: 'tie',
                tiedPlayers: targets,
                voteCounts: voteCount
            });

            return { result: 'tie', targets };
        }

        // Archive votes for history
        await this.archiveVotes(voteCount, votesSnap);

        // Kill player
        const victimId = targets[0];
        const playerRef = doc(db, 'rooms', this.currentRoom, 'players', victimId);
        const playerSnap = await getDoc(playerRef);

        if (!playerSnap.exists()) {
            console.warn(`Target player ${victimId} not found (left the game?). Skipping kill logic.`);
            // Advance anyway to avoid stuck game
            await this.setState(GAME_PHASES.VOTE_RESULT, {
                result: 'killed',
                victimId,
                victimName: 'Unknown (Left)'
            });
            return { result: 'killed', victimId, victimName: 'Unknown' };
        }

        const playerData = playerSnap.data();

        await updateDoc(playerRef, {
            isAlive: false
        });

        const roomRef = doc(db, 'rooms', this.currentRoom);
        const roomSnap = await getDoc(roomRef);
        const day = roomSnap.data().day;

        const deathLogRef = doc(db, 'rooms', this.currentRoom, 'deathLog', victimId);
        await setDoc(deathLogRef, {
            cause: 'vote',
            day: day,
            role: playerData.role,
            timestamp: serverTimestamp()
        });

        // STATE: VOTE_RESULT (Kill)
        await this.setState(GAME_PHASES.VOTE_RESULT, {
            result: 'killed',
            victimId,
            victimName: playerData.name,
            voteCounts: voteCount
        });

        return { result: 'killed', victimId, victimName: playerData.name };
    }

    async proceedAfterVote() {
        if (!this.currentPlayer.isHost) return;

        const state = await this.getState();
        if (!state) return;

        if (state.result === 'tie') {
            await this.setState(GAME_PHASES.MEETING_DISCUSSION);
            await this.startMeetingTimer();
        } else if (state.result === 'killed') {
            const winner = await this.checkWinCondition();
            if (winner) {
                await this.setState(GAME_PHASES.GAME_RESULT, { winner });
            } else {
                await this.setState(GAME_PHASES.BREAK);
                await this.startBreakTimer();
            }
        }
    }

    async archiveVotes(voteCount, votesSnap) {
        const roomRef = doc(db, 'rooms', this.currentRoom);
        const roomSnap = await getDoc(roomRef);
        const day = roomSnap.data().day;

        const historyRef = collection(db, 'rooms', this.currentRoom, 'voteHistory');
        const batch = [];

        votesSnap.forEach(doc => {
            const data = doc.data();
            batch.push(addDoc(historyRef, {
                day: day,
                voterId: doc.id,
                targetId: data.targetId,
                timestamp: serverTimestamp()
            }));
        });

        await Promise.all(batch);
    }

    async getFullVoteHistory() {
        const historyRef = collection(db, 'rooms', this.currentRoom, 'voteHistory');
        // Order by day/timestamp if possible, client can sort
        const snap = await getDocs(historyRef);

        const history = [];
        snap.forEach(doc => history.push(doc.data()));
        return history;
    }

    // ========================================
    // GAME FLOW - RESULT (NIGHT)
    // ========================================

    async submitNightAction(type, targetId) {
        const actionRef = doc(db, 'rooms', this.currentRoom, 'nightActions', authManager.getUserId());
        await setDoc(actionRef, {
            type: type,
            targetId: targetId,
            submittedAt: serverTimestamp()
        });
    }

    async checkEDSubmitted() {
        const playersRef = collection(db, 'rooms', this.currentRoom, 'players');
        const playersSnap = await getDocs(playersRef);

        const edPlayers = [];
        playersSnap.forEach(doc => {
            const data = doc.data();
            if (data.isAlive && (data.role === 'engineer' || data.role === 'doctor' || data.role === 'fallen_angel')) {
                edPlayers.push(doc.id);
            }
        });

        const actionsRef = collection(db, 'rooms', this.currentRoom, 'nightActions');
        const actionsSnap = await getDocs(actionsRef);

        let submittedCount = 0;
        actionsSnap.forEach(doc => {
            if (edPlayers.includes(doc.id)) {
                submittedCount++;
            }
        });

        const allSubmitted = submittedCount >= edPlayers.length;

        if (allSubmitted && this.currentPlayer.isHost) {
            // Check current phase to prevent infinite loop if duplicate check occurs
            const currentState = await this.getState();
            if (currentState.phase === GAME_PHASES.NIGHT_SPECIAL) {
                // STATE: NIGHT_IMPOSTOR
                await this.setState(GAME_PHASES.NIGHT_IMPOSTOR);
            }
        }

        return allSubmitted;
    }

    async checkImpostorSubmitted() {
        const actionsRef = collection(db, 'rooms', this.currentRoom, 'nightActions');
        const actionsSnap = await getDocs(actionsRef);

        let impostorSubmitted = false;
        actionsSnap.forEach(doc => {
            if (doc.data().type === 'impostor') {
                impostorSubmitted = true;
            }
        });

        if (impostorSubmitted && this.currentPlayer.isHost) {
            const currentState = await this.getState();
            if (currentState.phase === GAME_PHASES.NIGHT_IMPOSTOR) {
                await this.processMorning();
            }
        }

        return impostorSubmitted;
    }

    async processMorning() {
        if (!this.currentPlayer.isHost) return;

        try {
            console.log('Processing morning...');
            const actionsRef = collection(db, 'rooms', this.currentRoom, 'nightActions');
            const actionsSnap = await getDocs(actionsRef);
            const playersRef = collection(db, 'rooms', this.currentRoom, 'players');
            const playersSnap = await getDocs(playersRef);
            const players = {};
            playersSnap.forEach(doc => players[doc.id] = { id: doc.id, ...doc.data() });

            // 1. Process Engineer vs Bug (Bug disappears instantly)
            const victims = [];

            actionsSnap.forEach(doc => {
                const data = doc.data();
                if (data.type === 'engineer') {
                    const targetId = data.targetId;
                    const target = players[targetId];
                    if (target && target.isAlive && target.role === 'bug') {
                        console.log(`Bug ${targetId} eliminated by Engineer`);
                        victims.push({ id: targetId, cause: 'bug_death' });
                    }
                }
            });

            // 2. Identify Impostor Target
            let impostorTargetId = null;
            let earliestTime = null;

            actionsSnap.forEach(doc => {
                const data = doc.data();
                if (data.type === 'impostor') {
                    const submittedAt = data.submittedAt ? data.submittedAt.toMillis() : Date.now();
                    if (!earliestTime || submittedAt < earliestTime) {
                        earliestTime = submittedAt;
                        impostorTargetId = data.targetId;
                    }
                }
            });

            // 3. Process Impostor Kill
            if (impostorTargetId) {
                const target = players[impostorTargetId];

                // Check if target is already dead (e.g. killed by Engineer as Bug)
                const isAlreadyDead = victims.find(v => v.id === impostorTargetId);

                if (target && target.isAlive && !isAlreadyDead) {
                    // Check Protection (Fallen Angel)
                    let isProtected = false;
                    actionsSnap.forEach(doc => {
                        const data = doc.data();
                        if (data.type === 'fallen_angel' && data.targetId === impostorTargetId) {
                            isProtected = true;
                        }
                    });

                    // Check Bug Immunity (Impostor cannot kill Bug)
                    const isBug = target.role === 'bug';

                    if (isProtected) {
                        console.log(`Player ${impostorTargetId} protected by Fallen Angel`);
                    } else if (isBug) {
                        console.log(`Impostor attack failed on Bug ${impostorTargetId}`);
                    } else {
                        victims.push({ id: impostorTargetId, cause: 'impostor' });
                    }
                }
            }

            // 4. Apply Deaths
            const roomRef = doc(db, 'rooms', this.currentRoom);
            const roomSnap = await getDoc(roomRef);
            const day = roomSnap.data().day;

            const deathPromises = victims.map(v => {
                const playerRef = doc(db, 'rooms', this.currentRoom, 'players', v.id);
                // Update player
                const p1 = updateDoc(playerRef, { isAlive: false });
                // Log death
                const deathLogRef = doc(db, 'rooms', this.currentRoom, 'deathLog', v.id);
                const p2 = setDoc(deathLogRef, {
                    cause: v.cause,
                    day: day,
                    role: players[v.id].role,
                    timestamp: serverTimestamp()
                });
                return Promise.all([p1, p2]);
            });

            await Promise.all(deathPromises);

            // Increment day
            await updateDoc(roomRef, {
                day: day + 1
            });

            // STATE: MORNING_ANNOUNCEMENT
            await this.setState(GAME_PHASES.MORNING_ANNOUNCEMENT, {
                victims: victims.map(v => v.id)
            });

        } catch (error) {
            console.error('Error processing morning:', error);
        }
    }

    async proceedAfterMorning() {
        if (!this.currentPlayer.isHost) return;

        try {
            const winner = await this.checkWinCondition();
            if (winner) {
                await this.setState(GAME_PHASES.GAME_RESULT, { winner });
            } else {
                // After announcement, transition back to meeting
                await this.setState(GAME_PHASES.MEETING_DISCUSSION);
                await this.startMeetingTimer();
            }
        } catch (winError) {
            console.error('Error in win condition check:', winError);
        }
    }



    // ========================================
    // WIN CONDITION
    // ========================================

    async checkWinCondition() {
        const playersRef = collection(db, 'rooms', this.currentRoom, 'players');
        const playersSnap = await getDocs(playersRef);

        let aliveImpostors = 0;
        let aliveCitizens = 0;
        let winner = null;

        playersSnap.forEach(doc => {
            const data = doc.data();
            if (data.isAlive) {
                if (data.role === 'impostor') {
                    aliveImpostors++;
                } else {
                    aliveCitizens++;
                }
            }
        });

        if (aliveImpostors >= aliveCitizens && aliveImpostors > 0) {
            winner = 'impostor';
        } else if (aliveImpostors === 0) {
            winner = 'citizen';
        }

        if (winner) {
            const bug = await this.getAliveBug();
            if (bug) {
                return 'bug';
            }
            return winner;
        }

        return null;
    }

    async getAliveBug() {
        const playersRef = collection(db, 'rooms', this.currentRoom, 'players');
        const playersSnap = await getDocs(playersRef);
        let bug = null;
        playersSnap.forEach(doc => {
            const data = doc.data();
            if (data.isAlive && data.role === 'bug') {
                bug = data;
            }
        });
        return bug;
    }

    // ========================================
    // LISTENERS
    // ========================================

    listenToRoom(callback) {
        const roomRef = doc(db, 'rooms', this.currentRoom);
        const unsubscribe = onSnapshot(roomRef, callback);
        this.unsubscribers.push(unsubscribe);
        return unsubscribe;
    }

    listenToPlayers(callback) {
        const playersRef = collection(db, 'rooms', this.currentRoom, 'players');
        const unsubscribe = onSnapshot(playersRef, callback);
        this.unsubscribers.push(unsubscribe);
        return unsubscribe;
    }

    listenToGameState(callback) {
        const gameStateRef = doc(db, 'rooms', this.currentRoom, 'gameState', 'current');
        const unsubscribe = onSnapshot(gameStateRef, callback);
        this.unsubscribers.push(unsubscribe);
        return unsubscribe;
    }

    listenToTimer(callback) {
        const timerRef = ref(rtdb, `timers/${this.currentRoom}`);
        const unsubscribe = onValue(timerRef, callback);
        this.unsubscribers.push(unsubscribe);
        return unsubscribe;
    }

    cleanup() {
        this.unsubscribers.forEach(unsub => unsub());
        this.unsubscribers = [];

        if (this.presenceInterval) {
            clearInterval(this.presenceInterval);
        }
    }
}

export default new GameManager();
