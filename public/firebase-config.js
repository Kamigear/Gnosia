// Firebase Configuration
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getAuth, signInAnonymously, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { getDatabase } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";

const firebaseConfig = {
    apiKey: "AIzaSyCR1ke9jPwLQnDppNUcic9ZwXvLAv3LvC8",
    authDomain: "gnosia-f1586.firebaseapp.com",
    projectId: "gnosia-f1586",
    storageBucket: "gnosia-f1586.firebasestorage.app",
    messagingSenderId: "535708683664",
    appId: "1:535708683664:web:ea4aa889685418cb94f715",
    measurementId: "G-DJVE0QTT6X"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const rtdb = getDatabase(
    app,
    "https://gnosia-f1586-default-rtdb.asia-southeast1.firebasedatabase.app"
);

export { auth, db, rtdb, signInAnonymously, onAuthStateChanged };
