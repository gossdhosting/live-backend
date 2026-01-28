import axios from 'axios';
import logger from '../utils/logger.js';

const RECAPTCHA_API_KEY = process.env.RECAPTCHA_API_KEY || 'AIzaSyDsf_UQyTiVGLpGT2Uz_WKSMK-N44Jh8A0';
const RECAPTCHA_PROJECT_ID = process.env.RECAPTCHA_PROJECT_ID || 'zebcast-938e4';
const RECAPTCHA_SITE_KEY = process.env.RECAPTCHA_SITE_KEY || '6LfhWFksAAAAAAs_AmZgON4Z7cHOpp72kMmBx2eo';

class RecaptchaService {
  /**
   * Verify a reCAPTCHA Enterprise token
   * @param {string} token - The reCAPTCHA token from the frontend
   * @param {string} expectedAction - The expected action (e.g., 'LOGIN', 'REGISTER')
   * @param {number} minScore - Minimum score required (0.0 to 1.0, default 0.5)
   * @returns {Promise<{success: boolean, score?: number, error?: string}>}
   */
  static async verify(token, expectedAction, minScore = 0.5) {
    // Skip verification if reCAPTCHA is not configured
    if (!RECAPTCHA_API_KEY) {
      logger.warn('reCAPTCHA API key not configured, skipping verification');
      return { success: true, score: 1.0, skipped: true };
    }

    // Skip if no token provided (backwards compatibility)
    if (!token) {
      logger.warn('No reCAPTCHA token provided, skipping verification');
      return { success: true, score: 1.0, skipped: true };
    }

    try {
      // reCAPTCHA Enterprise API endpoint
      const response = await axios.post(
        `https://recaptchaenterprise.googleapis.com/v1/projects/${RECAPTCHA_PROJECT_ID}/assessments?key=${RECAPTCHA_API_KEY}`,
        {
          event: {
            token: token,
            siteKey: RECAPTCHA_SITE_KEY,
            expectedAction: expectedAction
          }
        }
      );

      const assessment = response.data;

      // Check if token is valid
      if (!assessment.tokenProperties?.valid) {
        logger.warn('reCAPTCHA token invalid', {
          reason: assessment.tokenProperties?.invalidReason,
          action: expectedAction
        });
        return {
          success: false,
          error: 'Invalid reCAPTCHA token. Please try again.'
        };
      }

      // Check if action matches
      if (assessment.tokenProperties?.action !== expectedAction) {
        logger.warn('reCAPTCHA action mismatch', {
          expected: expectedAction,
          actual: assessment.tokenProperties?.action
        });
        return {
          success: false,
          error: 'reCAPTCHA action mismatch. Please try again.'
        };
      }

      // Get the risk score
      const score = assessment.riskAnalysis?.score || 0;

      // Log the assessment for monitoring
      logger.info('reCAPTCHA assessment', {
        action: expectedAction,
        score: score,
        valid: true,
        reasons: assessment.riskAnalysis?.reasons || []
      });

      // Check if score meets minimum threshold
      if (score < minScore) {
        logger.warn('reCAPTCHA score too low', {
          score: score,
          minScore: minScore,
          action: expectedAction
        });
        return {
          success: false,
          score: score,
          error: 'Suspicious activity detected. Please try again.'
        };
      }

      return {
        success: true,
        score: score
      };
    } catch (error) {
      logger.error('reCAPTCHA verification failed', {
        error: error.message,
        response: error.response?.data
      });

      // In case of API errors, we can choose to fail open or fail closed
      // Failing open (return success) to not block legitimate users during outages
      return {
        success: true,
        score: 0,
        error: 'reCAPTCHA verification unavailable',
        skipped: true
      };
    }
  }

  /**
   * Middleware to verify reCAPTCHA for routes
   * @param {string} action - The expected action
   * @param {number} minScore - Minimum score required
   */
  static middleware(action, minScore = 0.5) {
    return async (req, res, next) => {
      const token = req.body.recaptchaToken;

      const result = await RecaptchaService.verify(token, action, minScore);

      if (!result.success) {
        return res.status(403).json({ error: result.error || 'reCAPTCHA verification failed' });
      }

      // Add reCAPTCHA result to request for logging
      req.recaptchaScore = result.score;
      req.recaptchaSkipped = result.skipped || false;

      next();
    };
  }
}

export default RecaptchaService;
