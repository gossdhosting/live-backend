import db from './database.js';
import bcrypt from 'bcryptjs';

class User {
  // Create a new user
  static async create({ email, password, name, role = 'admin' }) {
    const passwordHash = await bcrypt.hash(password, 10);

    const stmt = db.prepare(`
      INSERT INTO users (email, password_hash, name, role)
      VALUES (?, ?, ?, ?)
    `);

    const result = stmt.run(email, passwordHash, name, role);
    return this.findById(result.lastInsertRowid);
  }

  // Find user by ID
  static findById(id) {
    const stmt = db.prepare('SELECT id, email, name, role, created_at FROM users WHERE id = ?');
    return stmt.get(id);
  }

  // Find user by email (includes password hash for authentication)
  static findByEmail(email) {
    const stmt = db.prepare('SELECT * FROM users WHERE email = ?');
    return stmt.get(email);
  }

  // Verify password
  static async verifyPassword(plainPassword, passwordHash) {
    return bcrypt.compare(plainPassword, passwordHash);
  }

  // Update user
  static async update(id, data) {
    const fields = [];
    const values = [];

    if (data.name) {
      fields.push('name = ?');
      values.push(data.name);
    }

    if (data.email) {
      fields.push('email = ?');
      values.push(data.email);
    }

    if (data.password) {
      const passwordHash = await bcrypt.hash(data.password, 10);
      fields.push('password_hash = ?');
      values.push(passwordHash);
    }

    if (fields.length === 0) return null;

    fields.push('updated_at = CURRENT_TIMESTAMP');
    values.push(id);

    const stmt = db.prepare(`
      UPDATE users SET ${fields.join(', ')} WHERE id = ?
    `);

    stmt.run(...values);
    return this.findById(id);
  }
}

export default User;
