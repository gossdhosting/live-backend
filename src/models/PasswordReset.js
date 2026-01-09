import db from './database.js';
import crypto from 'crypto';

class PasswordReset {
  // Create password reset token
  static create(userId, email) {
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour from now

    const stmt = db.prepare(`
      INSERT INTO password_resets (user_id, email, token, expires_at)
      VALUES (?, ?, ?, ?)
    `);

    stmt.run(userId, email, token, expiresAt.toISOString());
    return token;
  }

  // Find valid reset token
  static findValidToken(token) {
    const stmt = db.prepare(`
      SELECT * FROM password_resets
      WHERE token = ? AND expires_at > datetime('now') AND used_at IS NULL
      ORDER BY created_at DESC
      LIMIT 1
    `);

    return stmt.get(token);
  }

  // Mark token as used
  static markAsUsed(token) {
    const stmt = db.prepare(`
      UPDATE password_resets
      SET used_at = CURRENT_TIMESTAMP
      WHERE token = ?
    `);

    stmt.run(token);
  }

  // Delete expired tokens (cleanup)
  static deleteExpired() {
    const stmt = db.prepare(`
      DELETE FROM password_resets
      WHERE expires_at < datetime('now')
    `);

    return stmt.run();
  }
}

export default PasswordReset;
