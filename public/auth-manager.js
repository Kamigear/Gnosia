// Authentication Manager
import { auth, signInAnonymously, onAuthStateChanged } from './firebase-config.js';

class AuthManager {
    constructor() {
        this.currentUser = null;
        this.authReady = false;
    }

    async init() {
        return new Promise((resolve, reject) => {
            onAuthStateChanged(auth, async (user) => {
                if (user) {
                    this.currentUser = user;
                    this.authReady = true;
                    resolve(user);
                } else {
                    try {
                        const userCredential = await signInAnonymously(auth);
                        this.currentUser = userCredential.user;
                        this.authReady = true;
                        resolve(userCredential.user);
                    } catch (error) {
                        console.error('Auth error:', error);
                        reject(error);
                    }
                }
            });
        });
    }

    getUserId() {
        return this.currentUser?.uid || null;
    }

    isReady() {
        return this.authReady;
    }
}

export default new AuthManager();
