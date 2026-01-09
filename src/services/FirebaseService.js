import admin from 'firebase-admin';
import logger from '../utils/logger.js';

class FirebaseService {
  static initialized = false;

  static initialize() {
    if (this.initialized) return;

    try {
      // Check if Firebase credentials are configured
      if (!process.env.FIREBASE_PROJECT_ID) {
        logger.warn('Firebase not configured - social login will not be available');
        return;
      }

      // Parse service account from environment variable
      let serviceAccount;
      try {
        serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
      } catch (error) {
        logger.error('Failed to parse FIREBASE_SERVICE_ACCOUNT JSON', { error: error.message });
        return;
      }

      // Validate service account has required fields
      if (!serviceAccount.project_id || !serviceAccount.private_key || !serviceAccount.client_email) {
        logger.error('Invalid Firebase service account - missing required fields');
        return;
      }

      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        projectId: process.env.FIREBASE_PROJECT_ID
      });

      this.initialized = true;
      logger.info('Firebase Admin SDK initialized successfully', {
        projectId: process.env.FIREBASE_PROJECT_ID
      });
    } catch (error) {
      logger.error('Firebase Admin SDK initialization failed', {
        error: error.message,
        stack: error.stack
      });
    }
  }

  // Verify Firebase ID token
  static async verifyIdToken(idToken) {
    if (!this.initialized) {
      this.initialize();
    }

    if (!this.initialized) {
      throw new Error('Firebase is not configured. Please contact administrator.');
    }

    try {
      const decodedToken = await admin.auth().verifyIdToken(idToken);
      logger.info('Firebase token verified', {
        uid: decodedToken.uid,
        email: decodedToken.email,
        provider: decodedToken.firebase?.sign_in_provider
      });
      return decodedToken;
    } catch (error) {
      logger.error('Firebase token verification failed', {
        error: error.message,
        code: error.code
      });
      throw new Error('Invalid or expired Firebase token');
    }
  }

  // Get user from Firebase
  static async getFirebaseUser(uid) {
    if (!this.initialized) {
      this.initialize();
    }

    if (!this.initialized) {
      throw new Error('Firebase is not configured');
    }

    try {
      const user = await admin.auth().getUser(uid);
      return user;
    } catch (error) {
      logger.error('Failed to get Firebase user', {
        uid,
        error: error.message
      });
      throw new Error('Firebase user not found');
    }
  }

  // Check if Firebase is available
  static isAvailable() {
    if (!this.initialized) {
      this.initialize();
    }
    return this.initialized;
  }
}

export default FirebaseService;
