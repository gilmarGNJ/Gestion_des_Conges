// Firebase Web configuration is public by design. Copy this file to
// `firebase-config.js` and replace only the placeholder values below.
//
// Never put a service-account JSON file, private key, OAuth client secret, or
// Firebase Admin SDK credential in this repository.

export const firebaseConfig = Object.freeze({
  apiKey: "YOUR_FIREBASE_WEB_API_KEY",
  authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT_ID.firebasestorage.app",
  messagingSenderId: "YOUR_MESSAGING_SENDER_ID",
  appId: "YOUR_FIREBASE_WEB_APP_ID",
});

export const firebasePublicOptions = Object.freeze({
  // Must match the collection name in firestore.rules.
  collectionName: "userCalendars",

  // Keep false on shared computers. Set true only if the browser may remember
  // the Firebase session after it is closed.
  rememberSession: false,

  // Optional public reCAPTCHA Enterprise site key for Firebase App Check.
  // Leave blank until App Check is configured in the Firebase console.
  appCheckSiteKey: "",
});
