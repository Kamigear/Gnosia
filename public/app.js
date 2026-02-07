// Main Application Entry Point
import authManager from './auth-manager.js';
import gameManager from './game-manager.js';
import uiManager from './ui-manager.js';

class App {
    constructor() {
        this.initialized = false;
    }

    async init() {
        try {
            // Show loading
            uiManager.showLoading('Initializing...');

            // Initialize auth
            await authManager.init();
            console.log('Auth initialized:', authManager.getUserId());

            // Try to restore previous session
            const restored = await gameManager.restoreSession();

            if (restored) {
                console.log('Session restored:', gameManager.currentRoom);
                // Trigger UI init which sets up listeners and redirects based on state
                uiManager.showLobby();
            } else {
                // Show home screen
                uiManager.showHome();
            }

            this.initialized = true;
        } catch (error) {
            console.error('Failed to initialize app:', error);
            document.getElementById('app').innerHTML = `
        <div class="screen error-screen">
          <h1>Error</h1>
          <p>Failed to initialize the application.</p>
          <p style="color: #ff0000;">${error.message}</p>
          <button class="btn btn-primary" onclick="location.reload()">Retry</button>
        </div>
      `;
        }
    }
}

// Start app when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        const app = new App();
        app.init();
    });
} else {
    const app = new App();
    app.init();
}
