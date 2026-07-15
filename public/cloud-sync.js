/**
 * Firebase cloud persistence adapter for the static GitHub Pages application.
 *
 * The adapter deliberately does not import firebase-config.js statically. This
 * lets the existing local-only application keep working when Firebase has not
 * been configured yet.
 */

const FIREBASE_SDK_VERSION = "12.15.0";
const FIREBASE_CDN_BASE = `https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}`;
const FIREBASE_APP_NAME = "gestion-conges-cloud-sync";
const DEFAULT_COLLECTION = "userCalendars";
const SCHEMA_VERSION = 1;
const MAX_STATE_BYTES = 900_000;
const REQUIRED_CONFIG_FIELDS = ["apiKey", "authDomain", "projectId", "appId"];
let firebaseSdkPromise = null;

async function loadFirebaseSdk() {
  if (!firebaseSdkPromise) {
    firebaseSdkPromise = Promise.all([
      import(`${FIREBASE_CDN_BASE}/firebase-app.js`),
      import(`${FIREBASE_CDN_BASE}/firebase-auth.js`),
      import(`${FIREBASE_CDN_BASE}/firebase-firestore.js`),
      import(`${FIREBASE_CDN_BASE}/firebase-app-check.js`),
    ]).then(([app, auth, firestore, appCheck]) => ({
      ...app,
      ...auth,
      ...firestore,
      ...appCheck,
    }));
  }

  return firebaseSdkPromise;
}

export class CloudSyncError extends Error {
  constructor(code, message, cause = null) {
    super(message);
    this.name = "CloudSyncError";
    this.code = code;
    if (cause) {
      this.cause = cause;
    }
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isPlaceholder(value) {
  return /^(YOUR_|REPLACE_|<|$)/.test(String(value ?? "").trim());
}

function validateFirebaseConfig(config) {
  if (!isPlainObject(config)) {
    return false;
  }

  return REQUIRED_CONFIG_FIELDS.every(
    (field) => typeof config[field] === "string" && !isPlaceholder(config[field]),
  );
}

function validateCollectionName(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]+$/.test(value);
}

function normalizeState(state) {
  if (!isPlainObject(state)) {
    throw new CloudSyncError(
      "invalid-state",
      "Cloud state must be a plain JavaScript object.",
    );
  }

  let serialized;
  try {
    serialized = JSON.stringify(state);
  } catch (error) {
    throw new CloudSyncError(
      "invalid-state",
      "Cloud state must be JSON-serializable.",
      error,
    );
  }

  if (serialized === undefined) {
    throw new CloudSyncError(
      "invalid-state",
      "Cloud state must be JSON-serializable.",
    );
  }

  const size = new TextEncoder().encode(serialized).byteLength;
  if (size > MAX_STATE_BYTES) {
    throw new CloudSyncError(
      "state-too-large",
      `Cloud state exceeds the ${MAX_STATE_BYTES}-byte safety limit.`,
    );
  }

  return JSON.parse(serialized);
}

function publicUser(user) {
  if (!user) {
    return null;
  }

  return Object.freeze({
    uid: user.uid,
    email: user.email,
    displayName: user.displayName,
    photoURL: user.photoURL,
  });
}

function timestampToDate(value) {
  return value && typeof value.toDate === "function" ? value.toDate() : null;
}

async function loadConfiguration(explicitConfig, explicitOptions) {
  if (explicitConfig) {
    return {
      firebaseConfig: explicitConfig,
      publicOptions: explicitOptions ?? {},
    };
  }

  try {
    const module = await import("./firebase-config.js");
    return {
      firebaseConfig: module.firebaseConfig,
      publicOptions: module.firebasePublicOptions ?? {},
    };
  } catch (error) {
    return {
      firebaseConfig: null,
      publicOptions: {},
      error,
    };
  }
}

export class FirebaseCloudSync {
  constructor() {
    this.configured = false;
    this.initialized = false;
    this.code = "not-initialized";
    this.reason = "Cloud sync has not been initialized.";
    this.app = null;
    this.auth = null;
    this.db = null;
    this._sdk = null;
    this.collectionName = DEFAULT_COLLECTION;
    this._statusListeners = new Set();
    this._authListeners = new Set();
    this._firebaseAuthUnsubscribe = null;
    this._initializePromise = null;
  }

  get user() {
    return publicUser(this.auth?.currentUser ?? null);
  }

  get currentUser() {
    return this.user;
  }

  getStatus() {
    return Object.freeze({
      configured: this.configured,
      initialized: this.initialized,
      code: this.code,
      reason: this.reason,
      user: this.user,
    });
  }

  onStatus(callback) {
    if (typeof callback !== "function") {
      throw new TypeError("onStatus requires a callback function.");
    }

    this._statusListeners.add(callback);
    callback(this.getStatus());
    return () => this._statusListeners.delete(callback);
  }

  onAuthState(callback) {
    if (typeof callback !== "function") {
      throw new TypeError("onAuthState requires a callback function.");
    }

    this._authListeners.add(callback);
    callback(this.user);
    return () => this._authListeners.delete(callback);
  }

  async initialize({ firebaseConfig = null, publicOptions = null } = {}) {
    if (this.initialized) {
      return this.getStatus();
    }

    if (this._initializePromise) {
      return this._initializePromise;
    }

    this._initializePromise = this._initialize(firebaseConfig, publicOptions);

    try {
      return await this._initializePromise;
    } finally {
      this._initializePromise = null;
    }
  }

  async _initialize(explicitConfig, explicitOptions) {
    const configuration = await loadConfiguration(explicitConfig, explicitOptions);

    if (!validateFirebaseConfig(configuration.firebaseConfig)) {
      this.configured = false;
      this.initialized = true;
      this._setStatus(
        "not-configured",
        "Cloud sync is disabled. Copy firebase-config.example.js to firebase-config.js and add the Firebase Web configuration.",
      );
      return this.getStatus();
    }

    const options = configuration.publicOptions ?? {};
    if (options.collectionName !== undefined) {
      if (!validateCollectionName(options.collectionName)) {
        throw new CloudSyncError(
          "invalid-collection",
          "collectionName may contain only letters, numbers, underscores, and hyphens.",
        );
      }
      this.collectionName = options.collectionName;
    }

    try {
      this._sdk = await loadFirebaseSdk();
    } catch (error) {
      this.configured = false;
      this.initialized = true;
      this._setStatus(
        "sdk-unavailable",
        "Firebase could not be loaded. The application should continue in local-only mode.",
      );
      return this.getStatus();
    }

    const existingApp = this._sdk.getApps()
      .find((app) => app.name === FIREBASE_APP_NAME);
    this.app = existingApp ?? this._sdk.initializeApp(
      configuration.firebaseConfig,
      FIREBASE_APP_NAME,
    );

    if (typeof options.appCheckSiteKey === "string" && options.appCheckSiteKey.trim()) {
      this._sdk.initializeAppCheck(this.app, {
        provider: new this._sdk.ReCaptchaEnterpriseProvider(
          options.appCheckSiteKey.trim(),
        ),
        isTokenAutoRefreshEnabled: true,
      });
    }

    this.auth = this._sdk.getAuth(this.app);
    this.auth.useDeviceLanguage();
    await this._sdk.setPersistence(
      this.auth,
      options.rememberSession
        ? this._sdk.browserLocalPersistence
        : this._sdk.browserSessionPersistence,
    );

    this.db = this._sdk.getFirestore(this.app);
    this.configured = true;
    this.initialized = true;

    this._firebaseAuthUnsubscribe = this._sdk.onAuthStateChanged(
      this.auth,
      (user) => {
        this._setStatus(user ? "ready" : "signed-out", null);
        for (const listener of this._authListeners) {
          listener(publicUser(user));
        }
      },
      (error) => {
        this._setStatus("auth-error", error.message);
      },
    );

    try {
      await this._sdk.getRedirectResult(this.auth);
      if (typeof this.auth.authStateReady === "function") {
        await this.auth.authStateReady();
      }
    } catch (error) {
      this._setStatus("auth-error", error.message);
      throw new CloudSyncError(
        "auth-redirect-failed",
        "Google sign-in redirect could not be completed.",
        error,
      );
    }

    this._setStatus(this.auth.currentUser ? "ready" : "signed-out", null);
    return this.getStatus();
  }

  async signInWithGoogle({ forceRedirect = false } = {}) {
    this._requireConfigured();
    this._setStatus("signing-in", null);

    const provider = new this._sdk.GoogleAuthProvider();
    provider.setCustomParameters({ prompt: "select_account" });

    if (forceRedirect) {
      await this._sdk.signInWithRedirect(this.auth, provider);
      return Object.freeze({ redirecting: true, user: null });
    }

    try {
      const credential = await this._sdk.signInWithPopup(this.auth, provider);
      this._setStatus("ready", null);
      return Object.freeze({
        redirecting: false,
        user: publicUser(credential.user),
      });
    } catch (error) {
      if (
        error?.code === "auth/popup-blocked"
        || error?.code === "auth/operation-not-supported-in-this-environment"
      ) {
        await this._sdk.signInWithRedirect(this.auth, provider);
        return Object.freeze({ redirecting: true, user: null });
      }

      this._setStatus("auth-error", error.message);
      throw new CloudSyncError(
        "google-sign-in-failed",
        `Google sign-in failed: ${error?.message || "unknown error"}`,
        error,
      );
    }
  }

  async signIn(options = {}) {
    return this.signInWithGoogle(options);
  }

  async signOut() {
    this._requireConfigured();
    await this._sdk.signOut(this.auth);
    this._setStatus("signed-out", null);
  }

  async loadState({ serverOnly = false } = {}) {
    const reference = this._userDocument();

    try {
      const snapshot = serverOnly
        ? await this._sdk.getDocFromServer(reference)
        : await this._sdk.getDoc(reference);

      if (!snapshot.exists()) {
        return Object.freeze({
          exists: false,
          state: null,
          schemaVersion: SCHEMA_VERSION,
          updatedAt: null,
          fromCache: snapshot.metadata.fromCache,
        });
      }

      const data = snapshot.data();
      return Object.freeze({
        exists: true,
        state: normalizeState(data.state),
        schemaVersion: data.schemaVersion,
        updatedAt: timestampToDate(data.updatedAt),
        fromCache: snapshot.metadata.fromCache,
      });
    } catch (error) {
      throw new CloudSyncError(
        "load-failed",
        "Cloud state could not be loaded.",
        error,
      );
    }
  }

  async saveState(state) {
    const reference = this._userDocument();
    const normalizedState = normalizeState(state);
    this._setStatus("saving", null);

    try {
      await this._sdk.setDoc(reference, {
        state: normalizedState,
        schemaVersion: SCHEMA_VERSION,
        updatedAt: this._sdk.serverTimestamp(),
      });
      this._setStatus("ready", null);
      return Object.freeze({ saved: true, state: normalizedState });
    } catch (error) {
      this._setStatus("save-error", error.message);
      throw new CloudSyncError(
        "save-failed",
        "Cloud state could not be saved. The local application should keep its local copy.",
        error,
      );
    }
  }

  subscribeState(callback, onError = null) {
    if (typeof callback !== "function") {
      throw new TypeError("subscribeState requires a callback function.");
    }

    const reference = this._userDocument();
    return this._sdk.onSnapshot(
      reference,
      { includeMetadataChanges: true },
      (snapshot) => {
        if (!snapshot.exists()) {
          callback(Object.freeze({
            exists: false,
            state: null,
            schemaVersion: SCHEMA_VERSION,
            updatedAt: null,
            fromCache: snapshot.metadata.fromCache,
            hasPendingWrites: snapshot.metadata.hasPendingWrites,
          }));
          return;
        }

        const data = snapshot.data();
        callback(Object.freeze({
          exists: true,
          state: normalizeState(data.state),
          schemaVersion: data.schemaVersion,
          updatedAt: timestampToDate(data.updatedAt),
          fromCache: snapshot.metadata.fromCache,
          hasPendingWrites: snapshot.metadata.hasPendingWrites,
        }));
      },
      (error) => {
        this._setStatus("subscription-error", error.message);
        if (typeof onError === "function") {
          onError(new CloudSyncError(
            "subscription-failed",
            "Cloud state subscription failed.",
            error,
          ));
        }
      },
    );
  }

  subscribe(callback, onError = null) {
    return this.subscribeState(callback, onError);
  }

  async deleteState() {
    const reference = this._userDocument();
    await this._sdk.deleteDoc(reference);
    return Object.freeze({ deleted: true });
  }

  async migrateLegacyLocalStorage({
    storageKey = "holidayData",
    confirmImport = null,
    keepBackup = true,
    removeLegacyAfterSuccess = false,
  } = {}) {
    this._requireUser();

    if (typeof window === "undefined" || !window.localStorage) {
      return Object.freeze({ status: "storage-unavailable" });
    }

    // A server read prevents an empty browser cache from being mistaken for an
    // empty cloud document and overwriting data from another device.
    const cloud = await this.loadState({ serverOnly: true });
    if (cloud.exists) {
      return Object.freeze({ status: "cloud-exists", cloud });
    }

    const raw = window.localStorage.getItem(storageKey);
    if (raw === null) {
      return Object.freeze({ status: "no-local-data" });
    }

    let localState;
    try {
      localState = normalizeState(JSON.parse(raw));
    } catch (error) {
      throw new CloudSyncError(
        "invalid-local-data",
        `The localStorage item "${storageKey}" is not valid cloud state.`,
        error,
      );
    }

    if (typeof confirmImport !== "function") {
      return Object.freeze({
        status: "confirmation-required",
        storageKey,
        state: localState,
      });
    }

    const confirmed = await confirmImport(Object.freeze({
      storageKey,
      state: localState,
    }));

    if (!confirmed) {
      return Object.freeze({ status: "cancelled" });
    }

    let backupKey = null;
    if (keepBackup) {
      backupKey = `${storageKey}:backup:${new Date().toISOString()}`;
      window.localStorage.setItem(backupKey, raw);
    }

    await this.saveState(localState);

    const markerKey = `${storageKey}:cloud-migrated:${this.auth.currentUser.uid}`;
    window.localStorage.setItem(markerKey, new Date().toISOString());

    if (removeLegacyAfterSuccess) {
      window.localStorage.removeItem(storageKey);
    }

    return Object.freeze({
      status: "migrated",
      backupKey,
      markerKey,
    });
  }

  _userDocument() {
    const user = this._requireUser();
    return this._sdk.doc(this.db, this.collectionName, user.uid);
  }

  _requireConfigured() {
    if (!this.configured || !this.auth || !this.db) {
      throw new CloudSyncError(
        "not-configured",
        this.reason || "Cloud sync is not configured.",
      );
    }
  }

  _requireUser() {
    this._requireConfigured();
    if (!this.auth.currentUser) {
      throw new CloudSyncError(
        "not-authenticated",
        "Sign in with Google before using cloud sync.",
      );
    }
    return this.auth.currentUser;
  }

  _setStatus(code, reason) {
    this.code = code;
    this.reason = reason;
    const status = this.getStatus();
    for (const listener of this._statusListeners) {
      listener(status);
    }
  }
}

export async function createCloudSync({
  onStateChange = null,
  onRemoteState = null,
  onError = null,
  firebaseConfig = null,
  publicOptions = null,
} = {}) {
  const adapter = new FirebaseCloudSync();

  if (typeof onStateChange === "function") {
    adapter.onStatus(onStateChange);
  }

  try {
    await adapter.initialize({ firebaseConfig, publicOptions });
  } catch (error) {
    if (typeof onError === "function") {
      onError(error);
    }
    throw error;
  }

  let remoteUnsubscribe = null;
  let authUnsubscribe = null;

  if (typeof onRemoteState === "function") {
    authUnsubscribe = adapter.onAuthState((user) => {
      if (remoteUnsubscribe) {
        remoteUnsubscribe();
        remoteUnsubscribe = null;
      }

      if (!user || !adapter.configured) {
        return;
      }

      try {
        remoteUnsubscribe = adapter.subscribe(onRemoteState, onError);
      } catch (error) {
        if (typeof onError === "function") {
          onError(error);
        }
      }
    });
  }

  adapter.dispose = () => {
    if (remoteUnsubscribe) {
      remoteUnsubscribe();
      remoteUnsubscribe = null;
    }
    if (authUnsubscribe) {
      authUnsubscribe();
      authUnsubscribe = null;
    }
    if (adapter._firebaseAuthUnsubscribe) {
      adapter._firebaseAuthUnsubscribe();
      adapter._firebaseAuthUnsubscribe = null;
    }
  };

  return adapter;
}

export const cloudSync = new FirebaseCloudSync();
export default cloudSync;
