import admin from 'firebase-admin';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from '../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class FirebaseService {
  static initialized = false;

  static initialize() {
    if (this.initialized) return;

    try {
      // Try to load service account from file first (more reliable than env var)
      const serviceAccountPath = path.resolve(__dirname, '../../firebase-service-account.json');
      let serviceAccount = null;

      if (fs.existsSync(serviceAccountPath)) {
        try {
          const fileContent = fs.readFileSync(serviceAccountPath, 'utf8');
          serviceAccount = JSON.parse(fileContent);
          logger.info('Firebase service account loaded from file', { path: serviceAccountPath });
        } catch (error) {
          logger.error('Failed to read firebase-service-account.json', { error: error.message });
        }
      }

      // Fallback to environment variable if file not found
      if (!serviceAccount && process.env.FIREBASE_SERVICE_ACCOUNT) {
        try {
          serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
          logger.info('Firebase service account loaded from environment variable');
        } catch (error) {
          logger.error('Failed to parse FIREBASE_SERVICE_ACCOUNT JSON', { error: error.message });
        }
      }

      // Check if we have a valid service account
      if (!serviceAccount || !serviceAccount.project_id || !serviceAccount.private_key || !serviceAccount.client_email) {
        logger.warn('Firebase not configured - social login will not be available');
        logger.warn('Expected firebase-service-account.json at: ' + serviceAccountPath);
        return;
      }

      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        projectId: serviceAccount.project_id
      });

      this.initialized = true;
      logger.info('Firebase Admin SDK initialized successfully', {
        projectId: serviceAccount.project_id
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
